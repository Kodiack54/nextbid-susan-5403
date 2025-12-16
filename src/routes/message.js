/**
 * Susan Message Routes
 * Receives messages from Chad, extracts knowledge
 */

const express = require('express');
const router = express.Router();
const { from } = require('../lib/db');
const { extractKnowledge, summarizeSession } = require('../lib/openai');
const { Logger } = require('../lib/logger');
const config = require('../lib/config');
const clairClient = require('../services/clairClient');

const logger = new Logger('Susan:Message');

/**
 * POST /api/message - Receive message from Chad
 */
router.post('/message', async (req, res) => {
  const { sessionId, projectPath, message } = req.body;

  try {
    // Check if this message contains something worth remembering
    if (config.AUTO_EXTRACT_KNOWLEDGE &&
        message.role === 'assistant' &&
        message.content.length > config.MIN_CONTENT_LENGTH) {
      await processForKnowledge(sessionId, projectPath, message.content);
    }
    res.json({ success: true });
  } catch (err) {
    logger.error('Message processing failed', { error: err.message, sessionId });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/summarize - Summarize ended session
 */
router.post('/summarize', async (req, res) => {
  const { sessionId } = req.body;

  try {
    // Get all messages from session
    const { data: messages, error: msgError } = await from('dev_ai_messages')
      .select('role, content')
      .eq('session_id', sessionId)
      .order('sequence_num', { ascending: true });

    if (msgError) throw msgError;

    if (!messages || messages.length === 0) {
      return res.json({ success: true, summary: null });
    }

    // Build conversation for summarization
    const conversation = messages
      .map(m => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.content}`)
      .join('\n\n');

    // Summarize with GPT
    const summary = await summarizeSession(conversation);

    // Update session with summary
    const { error: updateError } = await from('dev_ai_sessions')
      .update({ summary })
      .eq('id', sessionId);

    if (updateError) throw updateError;

    logger.info('Session summarized', {
      sessionId,
      summaryPreview: summary.slice(0, 50)
    });

    // Get project path from session for Clair's work log
    const { data: session } = await from('dev_ai_sessions')
      .select('project_path')
      .eq('id', sessionId)
      .single();

    // Log work session to Clair's journal
    if (session?.project_path && summary) {
      await clairClient.logWorkSession(session.project_path, summary, sessionId);
      logger.info('Work session logged to Clair', { sessionId });
    }

    res.json({ success: true, summary });
  } catch (err) {
    logger.error('Summarization failed', { error: err.message, sessionId });
    res.status(500).json({ error: err.message });
  }
});

/**
 * Process message content for knowledge extraction
 */
async function processForKnowledge(sessionId, projectPath, content) {
  if (content.length < config.MIN_CONTENT_LENGTH) return;

  try {
    const result = await extractKnowledge(content);

    if (result.shouldRemember && result.knowledge) {
      const k = result.knowledge;
      const { error } = await from('dev_ai_knowledge').insert({
        session_id: sessionId,
        project_path: projectPath,
        category: k.category,
        title: k.title,
        summary: k.summary,
        tags: k.tags || [],
        importance: k.importance || 5
      });

      if (error) throw error;

      logger.info('Knowledge extracted', {
        category: k.category,
        title: k.title,
        sessionId
      });

      // Forward to Clair's journal if journal-worthy
      const forwarded = await clairClient.forwardKnowledgeToJournal(projectPath, k);
      if (forwarded) {
        logger.info('Knowledge forwarded to Clair journal', {
          category: k.category,
          title: k.title
        });
      }
    }
  } catch (err) {
    logger.error('Knowledge extraction failed', { error: err.message, sessionId });
  }
}

module.exports = router;

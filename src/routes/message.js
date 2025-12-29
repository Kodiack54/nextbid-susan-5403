/**
 * Susan Message Routes
 * Receives messages from Chad, extracts knowledge
 *
 * NOTE: clairClient removed - Susan operates independently
 */

const express = require('express');
const router = express.Router();
const { from } = require('../lib/db');
const { extractKnowledge, summarizeSession } = require('../lib/openai');
const { Logger } = require('../lib/logger');
const config = require('../lib/config');

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

      // Determine project path based on scope
      // Global knowledge (ports, team roster, shared patterns) uses null project_id
      const isGlobal = k.scope === 'global';
      const effectiveProjectPath = isGlobal ? null : projectPath;

      const { error } = await from('dev_ai_knowledge').insert({
        session_id: sessionId,
        project_id: effectiveProjectPath,
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
        scope: isGlobal ? 'global' : 'project',
        sessionId
      });
    }
  } catch (err) {
    logger.error('Knowledge extraction failed', { error: err.message, sessionId });
  }
}

module.exports = router;

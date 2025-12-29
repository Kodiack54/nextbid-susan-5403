/**
 * Quick Parse Route
 * Receives quick parse data from Jen
 */

const express = require('express');
const router = express.Router();
const { from } = require('../lib/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:QuickParse');

router.post('/', async (req, res) => {
  try {
    const { sessionId, projectPath, quickData, parsedAt, source } = req.body;

    if (!sessionId || !projectPath) {
      return res.status(400).json({ error: 'Missing sessionId or projectPath' });
    }

    logger.info('Received quick parse', {
      sessionId,
      projectPath,
      source: source || 'unknown',
      keywords: quickData?.keywords?.length || 0,
      files: quickData?.fileMentions?.length || 0
    });

    // Check if activity record exists
    const { data: existing } = await from('dev_ai_activity')
      .select('id')
      .eq('session_id', sessionId)
      .limit(1);

    if (existing && existing.length > 0) {
      // Update existing
      await from('dev_ai_activity')
        .update({
          keywords: quickData.keywords || [],
          file_mentions: quickData.fileMentions || [],
          todo_mentions: quickData.todoMentions || [],
          error_mentions: quickData.errorMentions || [],
          message_count: quickData.messageCount || 0,
          last_activity: quickData.lastActivity,
          parsed_at: parsedAt,
          updated_at: new Date().toISOString()
        })
        .eq('session_id', sessionId);
    } else {
      // Insert new
      await from('dev_ai_activity')
        .insert({
          session_id: sessionId,
          project_id: projectPath,
          keywords: quickData.keywords || [],
          file_mentions: quickData.fileMentions || [],
          todo_mentions: quickData.todoMentions || [],
          error_mentions: quickData.errorMentions || [],
          message_count: quickData.messageCount || 0,
          last_activity: quickData.lastActivity,
          parsed_at: parsedAt,
          updated_at: new Date().toISOString()
        });
    }

    res.json({ success: true, stored: true });
  } catch (err) {
    logger.error('Quick parse failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get('/recent', async (req, res) => {
  try {
    const { data, error } = await from('dev_ai_activity')
      .select('*')
      .order('last_activity', { ascending: false })
      .limit(20);

    if (error) throw error;
    res.json({ success: true, activity: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { from } = require('../lib/db');

/**
 * GET /api/sessions
 * Returns recent session logs with full content for briefing
 */
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 3;
    
    const { data, error } = await from('dev_ai_sessions')
      .select('id, started_at, ended_at, summary, raw_content')
      .order('started_at', { ascending: false })
      .limit(limit);
    
    if (error) throw error;
    
    res.json({ success: true, sessions: data || [] });
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/sessions
 * Log a new session for memory persistence
 */
router.post('/', async (req, res) => {
  try {
    const { project, summary, messages } = req.body;
    
    if (!summary) {
      return res.status(400).json({ success: false, error: 'Summary required' });
    }
    
    const sessionData = {
      project_id: project || 'unknown',
      summary: summary,
      raw_content: JSON.stringify(messages || []),
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      status: 'active',
      source_type: 'claude-code',
      source_name: 'mcp-session-log'
    };
    
    const { data, error } = await from('dev_ai_sessions')
      .insert(sessionData);
    
    if (error) throw error;
    
    console.log('[Sessions] Logged session:', summary.substring(0, 50));
    res.json({ success: true, id: data?.[0]?.id, logged: true });
  } catch (error) {
    console.error('Error logging session:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;

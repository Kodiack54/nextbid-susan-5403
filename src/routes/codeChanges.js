/**
 * Susan Code Changes Routes
 * Track commits and code changes for projects
 */

const express = require('express');
const router = express.Router();
const { from } = require('../lib/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:CodeChanges');

/**
 * POST /api/code-change - Log a code change/commit
 */
router.post('/code-change', async (req, res) => {
  const {
    project_path,
    commit_hash,
    commit_message,
    author,
    files_changed,
    build_number
  } = req.body;

  if (!commit_hash || !project_path) {
    return res.status(400).json({ error: 'commit_hash and project_path required' });
  }

  try {
    const { data, error } = await from('dev_ai_code_changes')
      .insert({
        project_path,
        commit_hash,
        commit_message,
        author,
        files_changed: files_changed || [],
        build_number
      })
      .select('id')
      .single();

    if (error) throw error;

    logger.info('Code change logged', { id: data.id, commit_hash: commit_hash.slice(0, 7) });
    res.json({ success: true, id: data.id });
  } catch (err) {
    logger.error('Code change log failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/code-changes - Get code changes for a project
 */
router.get('/code-changes', async (req, res) => {
  const { project, author, limit = 50 } = req.query;

  try {
    let query = from('dev_ai_code_changes')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (project) {
      query = query.eq('project_path', project);
    }

    if (author) {
      query = query.eq('author', author);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, changes: data || [] });
  } catch (err) {
    logger.error('Code changes fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/code-change/:id - Get a specific code change
 */
router.get('/code-change/:id', async (req, res) => {
  try {
    const { data, error } = await from('dev_ai_code_changes')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;

    res.json({ success: true, change: data });
  } catch (err) {
    logger.error('Code change fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

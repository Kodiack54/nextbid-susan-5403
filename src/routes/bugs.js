/**
 * Susan Bugs Routes
 * Manage bug reports - Tiffany (tester) will report bugs here
 */

const express = require('express');
const router = express.Router();
const { from } = require('../lib/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:Bugs');

/**
 * POST /api/bug - Report a new bug
 */
router.post('/bug', async (req, res) => {
  const {
    project_path,
    title,
    description,
    severity,
    reported_by,
    assigned_to,
    steps_to_reproduce,
    expected_behavior,
    actual_behavior,
    environment,
    screenshot_url,
    related_file,
    related_todo_id
  } = req.body;

  if (!title || !project_path) {
    return res.status(400).json({ error: 'Title and project_path required' });
  }

  try {
    const { data, error } = await from('dev_ai_bugs')
      .insert({
        project_path,
        title,
        description,
        severity: severity || 'medium',
        status: 'open',
        reported_by: reported_by || 'manual',
        assigned_to,
        steps_to_reproduce,
        expected_behavior,
        actual_behavior,
        environment: environment || 'dev',
        screenshot_url,
        related_file,
        related_todo_id
      })
      .select('id')
      .single();

    if (error) throw error;

    logger.info('Bug reported', { id: data.id, title, severity, reported_by });
    res.json({ success: true, id: data.id });
  } catch (err) {
    logger.error('Bug report failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/bugs - Get bugs for a project
 */
router.get('/bugs', async (req, res) => {
  const { project, status, severity, reported_by, limit = 50 } = req.query;

  try {
    let query = from('dev_ai_bugs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (project) {
      query = query.eq('project_path', project);
    }

    if (status) {
      query = query.eq('status', status);
    }

    if (severity) {
      query = query.eq('severity', severity);
    }

    if (reported_by) {
      query = query.eq('reported_by', reported_by);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, bugs: data || [] });
  } catch (err) {
    logger.error('Bugs fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/bug/:id - Get a specific bug
 */
router.get('/bug/:id', async (req, res) => {
  try {
    const { data, error } = await from('dev_ai_bugs')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;

    res.json({ success: true, bug: data });
  } catch (err) {
    logger.error('Bug fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/bug/:id - Update bug
 */
router.patch('/bug/:id', async (req, res) => {
  const {
    title,
    description,
    severity,
    status,
    assigned_to,
    steps_to_reproduce,
    expected_behavior,
    actual_behavior,
    environment,
    screenshot_url,
    related_file,
    resolved_at
  } = req.body;

  try {
    const updates = { updated_at: new Date().toISOString() };

    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (severity !== undefined) updates.severity = severity;
    if (status !== undefined) updates.status = status;
    if (assigned_to !== undefined) updates.assigned_to = assigned_to;
    if (steps_to_reproduce !== undefined) updates.steps_to_reproduce = steps_to_reproduce;
    if (expected_behavior !== undefined) updates.expected_behavior = expected_behavior;
    if (actual_behavior !== undefined) updates.actual_behavior = actual_behavior;
    if (environment !== undefined) updates.environment = environment;
    if (screenshot_url !== undefined) updates.screenshot_url = screenshot_url;
    if (related_file !== undefined) updates.related_file = related_file;
    if (resolved_at !== undefined) updates.resolved_at = resolved_at;

    // Auto-set resolved_at when status changes to fixed
    if (status === 'fixed' && !resolved_at) {
      updates.resolved_at = new Date().toISOString();
    }

    const { error } = await from('dev_ai_bugs')
      .update(updates)
      .eq('id', req.params.id);

    if (error) throw error;

    logger.info('Bug updated', { id: req.params.id, status, severity });
    res.json({ success: true });
  } catch (err) {
    logger.error('Bug update failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/bug/:id - Delete bug
 */
router.delete('/bug/:id', async (req, res) => {
  try {
    const { error } = await from('dev_ai_bugs')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    logger.info('Bug deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    logger.error('Bug delete failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/bugs/stats - Get bug statistics
 */
router.get('/bugs/stats', async (req, res) => {
  const { project } = req.query;

  try {
    let query = from('dev_ai_bugs')
      .select('status, severity, environment, reported_by');

    if (project) {
      query = query.eq('project_path', project);
    }

    const { data, error } = await query;
    if (error) throw error;

    const stats = {
      total: data?.length || 0,
      byStatus: {},
      bySeverity: {},
      byEnvironment: {},
      byReporter: {}
    };

    if (data) {
      data.forEach(bug => {
        stats.byStatus[bug.status] = (stats.byStatus[bug.status] || 0) + 1;
        stats.bySeverity[bug.severity] = (stats.bySeverity[bug.severity] || 0) + 1;
        if (bug.environment) {
          stats.byEnvironment[bug.environment] = (stats.byEnvironment[bug.environment] || 0) + 1;
        }
        if (bug.reported_by) {
          stats.byReporter[bug.reported_by] = (stats.byReporter[bug.reported_by] || 0) + 1;
        }
      });
    }

    res.json({ success: true, stats });
  } catch (err) {
    logger.error('Bug stats failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

/**
 * Susan Todos Routes
 * Manage project todos and tasks discovered during conversations
 */

const express = require('express');
const router = express.Router();
const { from } = require('../lib/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:Todos');

/**
 * POST /api/todo - Add a todo item
 */
router.post('/todo', async (req, res) => {
  // Accept both camelCase and snake_case for flexibility
  const {
    projectPath, project_path,
    title, description, priority,
    category, status,
    discoveredIn, discovered_in,
    tags
  } = req.body;

  const projPath = project_path || projectPath;

  if (!title) {
    return res.status(400).json({ error: 'Title required' });
  }

  try {
    const { data, error } = await from('dev_ai_todos')
      .insert({
        project_path: projPath,
        title,
        description,
        priority: priority || 'medium',
        category: category || 'general',
        status: status || 'pending',
        discovered_in: discovered_in || discoveredIn,
        tags: tags || []
      })
      .select('id')
      .single();

    if (error) throw error;

    logger.info('Todo added', { id: data.id, title, project_path: projPath });
    res.json({ success: true, id: data.id });
  } catch (err) {
    logger.error('Todo add failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/todos - Get todos for a project
 */
router.get('/todos', async (req, res) => {
  const { project, status, priority, category, limit = 50 } = req.query;

  try {
    let query = from('dev_ai_todos')
      .select('id, project_path, title, description, priority, category, status, discovered_in, tags, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (project) {
      query = query.eq('project_path', project);
    }

    if (status) {
      query = query.eq('status', status);
    }

    if (priority) {
      query = query.eq('priority', priority);
    }

    if (category) {
      query = query.eq('category', category);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, todos: data || [] });
  } catch (err) {
    logger.error('Todos fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/todo/:id - Update todo status
 */
router.patch('/todo/:id', async (req, res) => {
  const { status, priority, title, description } = req.body;

  try {
    const updates = { updated_at: new Date().toISOString() };
    if (status) updates.status = status;
    if (priority) updates.priority = priority;
    if (title) updates.title = title;
    if (description !== undefined) updates.description = description;

    if (status === 'completed') {
      updates.completed_at = new Date().toISOString();
    }

    const { error } = await from('dev_ai_todos')
      .update(updates)
      .eq('id', req.params.id);

    if (error) throw error;

    logger.info('Todo updated', { id: req.params.id, status });
    res.json({ success: true });
  } catch (err) {
    logger.error('Todo update failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/todo/:id - Delete todo
 */
router.delete('/todo/:id', async (req, res) => {
  try {
    const { error } = await from('dev_ai_todos')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    logger.info('Todo deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/todos/stats - Get todo statistics
 */
router.get('/todos/stats', async (req, res) => {
  const { project } = req.query;

  try {
    let query = from('dev_ai_todos')
      .select('status, priority, category');

    if (project) {
      query = query.eq('project_path', project);
    }

    const { data, error } = await query;
    if (error) throw error;

    const stats = {
      total: data?.length || 0,
      byStatus: {},
      byPriority: {},
      byCategory: {}
    };

    if (data) {
      data.forEach(item => {
        stats.byStatus[item.status] = (stats.byStatus[item.status] || 0) + 1;
        stats.byPriority[item.priority] = (stats.byPriority[item.priority] || 0) + 1;
        stats.byCategory[item.category] = (stats.byCategory[item.category] || 0) + 1;
      });
    }

    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

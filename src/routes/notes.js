/**
 * Susan Notes Routes
 * Freeform notes/notepad for projects
 */

const express = require('express');
const router = express.Router();
const { from } = require('../lib/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:Notes');

/**
 * POST /api/note - Create a note
 */
router.post('/note', async (req, res) => {
  const { project_path, title, content } = req.body;

  if (!title || !project_path) {
    return res.status(400).json({ error: 'Title and project_path required' });
  }

  try {
    const { data, error } = await from('dev_ai_notes')
      .insert({
        project_path,
        title,
        content: content || ''
      })
      .select('id')
      .single();

    if (error) throw error;

    logger.info('Note created', { id: data.id, title });
    res.json({ success: true, id: data.id });
  } catch (err) {
    logger.error('Note create failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/notes - Get notes for a project
 */
router.get('/notes', async (req, res) => {
  const { project, limit = 50 } = req.query;

  try {
    let query = from('dev_ai_notes')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(parseInt(limit));

    if (project) {
      query = query.eq('project_path', project);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, notes: data || [] });
  } catch (err) {
    logger.error('Notes fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/note/:id - Get a specific note
 */
router.get('/note/:id', async (req, res) => {
  try {
    const { data, error } = await from('dev_ai_notes')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;

    res.json({ success: true, note: data });
  } catch (err) {
    logger.error('Note fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/note/:id - Update note
 */
router.patch('/note/:id', async (req, res) => {
  const { title, content } = req.body;

  try {
    const updates = { updated_at: new Date().toISOString() };

    if (title !== undefined) updates.title = title;
    if (content !== undefined) updates.content = content;

    const { error } = await from('dev_ai_notes')
      .update(updates)
      .eq('id', req.params.id);

    if (error) throw error;

    logger.info('Note updated', { id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    logger.error('Note update failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/note/:id - Delete note
 */
router.delete('/note/:id', async (req, res) => {
  try {
    const { error } = await from('dev_ai_notes')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    logger.info('Note deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    logger.error('Note delete failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

/**
 * Susan Documentation Routes
 * Manage project documentation
 */

const express = require('express');
const router = express.Router();
const { from } = require('../lib/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:Docs');

/**
 * POST /api/doc - Create documentation (singular route for UI)
 */
router.post('/doc', async (req, res) => {
  // Accept both camelCase and snake_case
  const {
    projectPath, project_path,
    docType, doc_type, category,
    title, content, tags
  } = req.body;

  const projPath = project_path || projectPath;
  const type = category || doc_type || docType || 'general';

  if (!projPath || !title) {
    return res.status(400).json({ error: 'project_path and title required' });
  }

  try {
    const { data, error } = await from('dev_ai_docs')
      .insert({
        project_path: projPath,
        doc_type: type,
        title,
        content: content || '',
        tags: tags || [],
        updated_at: new Date().toISOString()
      })
      .select('id')
      .single();

    if (error) throw error;

    logger.info('Documentation created', { id: data.id, title, project_path: projPath });
    res.json({ success: true, id: data.id });
  } catch (err) {
    logger.error('Doc create failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/docs - Create/update documentation (legacy upsert)
 */
router.post('/docs', async (req, res) => {
  const { projectPath, project_path, docType, doc_type, category, title, content, tags } = req.body;

  const projPath = project_path || projectPath;
  const type = category || doc_type || docType || 'general';

  if (!projPath || !title) {
    return res.status(400).json({ error: 'project_path and title required' });
  }

  try {
    const { data, error } = await from('dev_ai_docs')
      .upsert({
        project_path: projPath,
        doc_type: type,
        title,
        content,
        tags: tags || [],
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'project_path,doc_type,title'
      })
      .select('id')
      .single();

    if (error) throw error;

    logger.info('Documentation updated', { project_path: projPath, doc_type: type, title });
    res.json({ success: true, id: data.id });
  } catch (err) {
    logger.error('Doc update failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/docs - Get documentation for a project
 */
router.get('/docs', async (req, res) => {
  const { project, docType, doc_type, category } = req.query;
  const type = category || doc_type || docType;

  try {
    let query = from('dev_ai_docs')
      .select('id, project_path, doc_type, title, content, tags, created_at, updated_at')
      .order('updated_at', { ascending: false });

    if (project) {
      query = query.eq('project_path', project);
    }

    if (type) {
      query = query.eq('doc_type', type);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Map doc_type to category for UI compatibility
    const docs = (data || []).map(doc => ({
      ...doc,
      category: doc.doc_type
    }));

    res.json({ success: true, docs });
  } catch (err) {
    logger.error('Docs fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/doc/:id - Get specific documentation
 */
router.get('/doc/:id', async (req, res) => {
  try {
    const { data, error } = await from('dev_ai_docs')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    if (!data) {
      return res.status(404).json({ error: 'Documentation not found' });
    }

    res.json({ success: true, doc: { ...data, category: data.doc_type } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/doc/:id - Update documentation
 */
router.patch('/doc/:id', async (req, res) => {
  const { title, content, category, doc_type, docType, tags } = req.body;

  try {
    const updates = { updated_at: new Date().toISOString() };

    if (title !== undefined) updates.title = title;
    if (content !== undefined) updates.content = content;
    if (category || doc_type || docType) {
      updates.doc_type = category || doc_type || docType;
    }
    if (tags !== undefined) updates.tags = tags;

    const { error } = await from('dev_ai_docs')
      .update(updates)
      .eq('id', req.params.id);

    if (error) throw error;

    logger.info('Documentation updated', { id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    logger.error('Doc update failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/doc/:id - Delete documentation (singular route)
 */
router.delete('/doc/:id', async (req, res) => {
  try {
    const { error } = await from('dev_ai_docs')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    logger.info('Documentation deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/docs/:id - Delete documentation (legacy plural route)
 */
router.delete('/docs/:id', async (req, res) => {
  try {
    const { error } = await from('dev_ai_docs')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    logger.info('Documentation deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

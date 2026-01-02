/**
 * Susan Knowledge Routes
 * Query, remember, and manage knowledge base
 *
 * NOTE: projectDetector and conceptDetector removed - Jen handles AI extraction
 */

const express = require('express');
const router = express.Router();
const { from } = require('../lib/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:Knowledge');

/**
 * GET /api/query - Search knowledge base
 */
router.get('/query', async (req, res) => {
  const { q, project, category, limit = 10 } = req.query;

  try {
    let query = from('dev_ai_knowledge')
      .select('id, category, title, summary, tags, importance, created_at, project_id')
      .order('importance', { ascending: false })
      .limit(parseInt(limit));

    if (q) {
      query = query.or(`title.ilike.%${q}%,summary.ilike.%${q}%`);
    }

    if (project) {
      query = query.eq('project_id', project);
    }

    if (category) {
      query = query.eq('category', category);
    }

    const { data, error } = await query;
    if (error) throw error;

    logger.info('Knowledge query', {
      query: q,
      project,
      resultCount: data?.length || 0
    });

    res.json(data || []);
  } catch (err) {
    logger.error('Query failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/remember - Manually add knowledge
 */
router.post('/remember', async (req, res) => {
  const { category, title, summary, details, tags, projectPath, project, importance } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Title required' });
  }

  try {
    let finalProjectId = null;
    const projectInput = (projectPath || project || '').trim().toLowerCase();

    // If project input looks like a UUID, use it directly
    if (projectInput && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectInput)) {
      finalProjectId = projectInput;
    } else if (projectInput) {
      // Try exact slug match first
      let { data: proj } = await from('dev_projects')
        .select('id')
        .eq('slug', projectInput)
        .limit(1)
        .single();
      
      // Fallback to name ilike if no slug match
      if (!proj) {
        const { data: nameMatch } = await from('dev_projects')
          .select('id')
          .ilike('name', `%${projectInput}%`)
          .limit(1)
          .single();
        proj = nameMatch;
      }
      
      if (proj) {
        finalProjectId = proj.id;
      }
    }

    const { data, error } = await from('dev_ai_knowledge')
      .insert({
        category: category || 'note',
        title,
        summary,
        details,
        tags: tags || [],
        project_id: finalProjectId,
        importance: importance || 5
      })
      .select('id')
      .single();

    if (error) throw error;

    logger.info('Knowledge remembered', { id: data.id, title, project: finalProjectId });
    res.json({ success: true, id: data.id, project: finalProjectId });
  } catch (err) {
    logger.error('Remember failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/knowledge/:id - Get specific knowledge item
 */
router.get('/knowledge/:id', async (req, res) => {
  try {
    const { data, error } = await from('dev_ai_knowledge')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: 'Knowledge item not found' });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/knowledge/:id - Delete knowledge item
 */
router.delete('/knowledge/:id', async (req, res) => {
  try {
    const { error } = await from('dev_ai_knowledge')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    logger.info('Knowledge deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/categories - Get all knowledge categories
 */
router.get('/categories', async (req, res) => {
  try {
    const { data, error } = await from('dev_ai_knowledge')
      .select('category')
      .order('category');

    if (error) throw error;

    const categories = [...new Set(data.map(d => d.category))];
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// Category stats for Session Hub
router.get('/knowledge/category-stats', async (req, res) => {
  try {
    // Get counts from new dev_knowledge table
    const { data, error } = await from('dev_knowledge')
      .select('category, status')
      .eq('status', 'active');

    if (error) throw error;

    const stats = {
      decision: 0, lesson: 0, system: 0, procedure: 0,
      issue: 0, reference: 0, idea: 0, log: 0
    };

    (data || []).forEach(item => {
      if (stats[item.category] !== undefined) {
        stats[item.category]++;
      }
    });

    // Get pending review count
    const { data: pending } = await from('dev_knowledge')
      .select('id')
      .eq('status', 'needs_review');

    res.json({
      success: true,
      categories: stats,
      total: Object.values(stats).reduce((a, b) => a + b, 0),
      pendingReview: pending?.length || 0
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Category stats - different path to avoid conflict
router.get('/category-stats', async (req, res) => {
  try {
    const { data, error } = await from('dev_knowledge')
      .select('category, status');

    if (error) throw error;

    const stats = {
      decision: 0, lesson: 0, system: 0, procedure: 0,
      issue: 0, reference: 0, idea: 0, log: 0
    };
    let pendingReview = 0;

    (data || []).forEach(item => {
      if (item.status === 'needs_review') pendingReview++;
      if (item.status === 'active' && stats[item.category] !== undefined) {
        stats[item.category]++;
      }
    });

    res.json({
      success: true,
      categories: stats,
      total: Object.values(stats).reduce((a, b) => a + b, 0),
      pendingReview
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/knowledge/queue-stats - Show pending extractions from Chad
router.get('/queue-stats', async (req, res) => {
  try {
    // Get pending extractions count
    const { data: pending, error: pendingErr } = await from('dev_ai_staging')
      .select('id, extraction_type, created_at')
      .eq('status', 'pending');

    if (pendingErr) throw pendingErr;

    // Group by type
    const byType = {};
    (pending || []).forEach(item => {
      const type = item.extraction_type || 'unknown';
      byType[type] = (byType[type] || 0) + 1;
    });

    res.json({
      success: true,
      pending: {
        total: pending?.length || 0,
        byType
      },
      oldestPending: pending?.[0]?.created_at || null
    });
  } catch (error) {
    console.error('[Knowledge] Queue stats error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

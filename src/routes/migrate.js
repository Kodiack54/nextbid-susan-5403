/**
 * Susan Migration Routes
 * One-time migrations for knowledge reorganization
 */

const express = require('express');
const router = express.Router();
const { from } = require('../lib/db');
const { detectProject } = require('../services/projectDetector');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:Migrate');

// Normalize full paths to short project names
function normalizeProjectPath(path) {
  if (!path) return null;
  
  // Extract project name from full path
  const match = path.match(/(kodiack-dashboard-5500|engine-dev-5101|source-dev-5102|auth-7000|ai-workers)/);
  if (match) return match[1];

  // Already short form
  if (['kodiack-dashboard-5500', 'engine-dev-5101', 'source-dev-5102', 'auth-7000', 'ai-workers'].includes(path)) {
    return path;
  }
  
  return path;
}

/**
 * POST /api/migrate/reorganize-projects
 * Re-analyze all knowledge entries and assign correct project_path
 */
router.post('/reorganize-projects', async (req, res) => {
  const { dryRun = true } = req.body;

  logger.info('Starting knowledge reorganization', { dryRun });

  try {
    const { data: entries, error } = await from('dev_ai_knowledge')
      .select('id, title, summary, details, project_path, category')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const results = {
      total: entries.length,
      unchanged: 0,
      updated: 0,
      normalized: 0,
      byProject: {},
      changes: []
    };

    for (const entry of entries) {
      const content = [entry.title, entry.summary, entry.details]
        .filter(Boolean)
        .join(' ');

      // First normalize the existing path
      const normalizedExisting = normalizeProjectPath(entry.project_path);
      
      // Then detect from content
      const detection = detectProject(content, normalizedExisting || 'kodiack-dashboard-5500');
      const finalProject = detection.project;
      
      results.byProject[finalProject] = (results.byProject[finalProject] || 0) + 1;

      // Check if anything changed (either normalization or detection)
      const needsUpdate = finalProject !== entry.project_path;
      const wasNormalized = normalizedExisting !== entry.project_path;

      if (needsUpdate) {
        results.changes.push({
          id: entry.id,
          title: entry.title?.slice(0, 50),
          from: entry.project_path,
          to: finalProject,
          normalized: wasNormalized,
          confidence: detection.confidence
        });

        if (!dryRun) {
          await from('dev_ai_knowledge')
            .update({ project_path: finalProject })
            .eq('id', entry.id);
        }

        results.updated++;
        if (wasNormalized) results.normalized++;
      } else {
        results.unchanged++;
      }
    }

    logger.info('Reorganization complete', {
      dryRun,
      total: results.total,
      updated: results.updated,
      normalized: results.normalized,
      unchanged: results.unchanged
    });

    res.json({
      success: true,
      dryRun,
      ...results,
      changes: results.changes.slice(0, 50)
    });

  } catch (err) {
    logger.error('Reorganization failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/migrate/preview
 */
router.get('/preview', async (req, res) => {
  try {
    const { data: entries, error } = await from('dev_ai_knowledge')
      .select('id, title, summary, project_path')
      .limit(20);

    if (error) throw error;

    const previews = entries.map(entry => {
      const content = [entry.title, entry.summary].filter(Boolean).join(' ');
      const normalized = normalizeProjectPath(entry.project_path);
      const detection = detectProject(content, normalized || 'kodiack-dashboard-5500');
      return {
        id: entry.id,
        title: entry.title?.slice(0, 50),
        current: entry.project_path,
        normalized,
        detected: detection.project,
        confidence: detection.confidence
      };
    });

    res.json({ previews });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

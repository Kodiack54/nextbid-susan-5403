/**
 * Susan Ideas Routes
 * Link brainstorm ideas to projects when they're created
 *
 * NOTE: ideaLinker removed - Jen handles idea extraction/linking now
 * Routes return disabled/empty responses
 */

const express = require('express');
const router = express.Router();
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:Ideas');

/**
 * POST /api/ideas/link-all - Link all matching ideas to projects
 * DISABLED - Jen handles idea linking now
 */
router.post('/link-all', async (req, res) => {
  logger.info('Link-all called but disabled - Jen handles idea linking now');
  res.json({
    success: false,
    message: 'Idea linking handled by Jen now',
    linked: 0,
    skipped: 0
  });
});

/**
 * POST /api/ideas/link - Link a specific idea to a project
 * DISABLED - Jen handles idea linking now
 */
router.post('/link', async (req, res) => {
  res.json({
    success: false,
    message: 'Idea linking handled by Jen now'
  });
});

/**
 * GET /api/ideas/unlinked - Get all unlinked ideas
 * DISABLED - Jen handles idea linking now
 */
router.get('/unlinked', async (req, res) => {
  res.json([]);
});

/**
 * GET /api/ideas/match/:projectName - Find ideas that match a project
 * DISABLED - Jen handles idea linking now
 */
router.get('/match/:projectName', async (req, res) => {
  res.json([]);
});

module.exports = router;

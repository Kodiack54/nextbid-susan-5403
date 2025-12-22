/**
 * Susan Project Routes
 * Manage subfolders within existing projects
 * NOTE: Susan cannot create new top-level projects - only subfolders
 */

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const projectOrganizer = require('../services/projectOrganizer');
const { detectProject, listProjects, PROJECTS } = require('../services/projectDetector');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:Projects');
const BASE_PATH = '/var/www/NextBid_Dev';

/**
 * GET /api/projects - List known projects
 */
router.get('/', async (req, res) => {
  const projects = listProjects();
  const knownFolders = Array.from(projectOrganizer.knownProjects);
  res.json({ 
    configured: projects,
    folders: knownFolders
  });
});

/**
 * POST /api/projects/subfolder - Create subfolder within existing project
 * Used for planning new addons, concepts, features within a project
 */
router.post('/subfolder', async (req, res) => {
  const { projectPath, subfolderPath, description, type = 'planning' } = req.body;

  if (!projectPath || !subfolderPath) {
    return res.status(400).json({ error: 'projectPath and subfolderPath required' });
  }

  // Verify project exists
  if (!projectOrganizer.knownProjects.has(projectPath) && !PROJECTS[projectPath]) {
    return res.status(400).json({ error: `Project ${projectPath} does not exist. New projects must be created by a person.` });
  }

  try {
    const fullPath = path.join(BASE_PATH, projectPath, subfolderPath);
    
    // Create the subfolder
    await fs.mkdir(fullPath, { recursive: true });
    
    // Create a README for the new section
    const readme = `# ${path.basename(subfolderPath)}

Type: ${type}
Created: ${new Date().toISOString()}
Parent Project: ${projectPath}

## Description
${description || 'New section created from conversation detection'}

## Status
- [ ] Requirements gathering
- [ ] Architecture planning
- [ ] Implementation ready

## Notes
_Add notes as discussion continues..._
`;
    
    await fs.writeFile(path.join(fullPath, 'README.md'), readme);
    
    logger.info('Subfolder created', { projectPath, subfolderPath, type });
    res.json({ 
      success: true, 
      path: fullPath,
      projectPath,
      subfolderPath
    });
  } catch (err) {
    logger.error('Subfolder creation failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/projects/detect - Detect which existing project content belongs to
 */
router.post('/detect', async (req, res) => {
  const { content } = req.body;

  if (!content) {
    return res.status(400).json({ error: 'Content required' });
  }

  const detection = detectProject(content);
  
  // Check if detected project actually exists
  const projectExists = PROJECTS[detection.project] || projectOrganizer.knownProjects.has(detection.project);
  
  res.json({
    ...detection,
    projectExists,
    note: projectExists ? null : 'Detected project does not exist. Filing to kodiack-dashboard-5500 instead.'
  });
});

/**
 * GET /api/projects/:project/structure - Get folder structure of a project
 */
router.get('/:project/structure', async (req, res) => {
  const { project } = req.params;
  
  if (!projectOrganizer.knownProjects.has(project) && !PROJECTS[project]) {
    return res.status(404).json({ error: 'Project not found' });
  }

  try {
    const projectPath = path.join(BASE_PATH, project);
    const entries = await fs.readdir(projectPath, { withFileTypes: true });
    
    const structure = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => e.name);
    
    res.json({ project, folders: structure });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

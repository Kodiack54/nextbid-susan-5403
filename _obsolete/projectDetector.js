/**
 * Susan Project Detector - Database-Driven
 *
 * Loads projects from dev_projects and dev_project_ids tables
 * Supports client/parent/child hierarchy
 * Matches content against project paths, names, and slugs
 */

const { from } = require('../lib/db');
const { Logger } = require('../lib/logger');
const logger = new Logger('Susan:ProjectDetector');

// Cache for projects (refreshed periodically)
let projectCache = null;
let cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Load all projects with their paths from database
 */
async function loadProjectsFromDB() {
  const now = Date.now();
  if (projectCache && now < cacheExpiry) {
    return projectCache;
  }

  logger.info('Loading projects from database...');

  try {
    // Get all projects with client info
    const { data: projects, error: projError } = await from('dev_projects')
      .select('id, name, slug, is_parent, parent_id, client_id')
      .order('name');

    if (projError) throw projError;

    // Get all project paths
    const { data: paths, error: pathError } = await from('dev_project_ids')
      .select('project_id, path, path_type')
      .order('project_id');

    if (pathError) throw pathError;

    // Get all clients
    const { data: clients, error: clientError } = await from('dev_clients')
      .select('id, name, slug');

    if (clientError) throw clientError;

    // Build lookup maps
    const clientMap = {};
    for (const client of (clients || [])) {
      clientMap[client.id] = client;
    }

    const pathMap = {};
    for (const path of (paths || [])) {
      if (!pathMap[path.project_id]) {
        pathMap[path.project_id] = [];
      }
      pathMap[path.project_id].push(path.path);
    }

    // Build project lookup with hierarchy
    const projectLookup = {};
    for (const project of (projects || [])) {
      const projectPaths = pathMap[project.id] || [];
      const client = clientMap[project.client_id];

      // Find parent project if exists
      let parent = null;
      if (project.parent_id) {
        parent = projects.find(p => p.id === project.parent_id);
      }

      // Add entry for each path
      for (const serverPath of projectPaths) {
        projectLookup[serverPath] = {
          project_id: project.id,
          name: project.name,
          slug: project.slug,
          is_parent: project.is_parent,
          parent_id: project.parent_id,
          parent_name: parent?.name || null,
          client_id: project.client_id,
          client_name: client?.name || null,
          client_slug: client?.slug || null,
          paths: projectPaths,
          // Build search keywords from name, slug, paths
          keywords: buildKeywords(project, projectPaths)
        };
      }
    }

    projectCache = projectLookup;
    cacheExpiry = now + CACHE_TTL;

    logger.info('Projects loaded from database', {
      projectCount: Object.keys(projectLookup).length,
      clients: clients?.length || 0
    });

    return projectLookup;
  } catch (err) {
    logger.error('Failed to load projects from database', { error: err.message });
    // Return empty cache on error
    return projectCache || {};
  }
}

/**
 * Build search keywords from project info
 */
function buildKeywords(project, paths) {
  const keywords = [];

  // Add name parts
  if (project.name) {
    keywords.push(project.name.toLowerCase());
    keywords.push(...project.name.toLowerCase().split(/[\s\-_]+/));
  }

  // Add slug
  if (project.slug) {
    keywords.push(project.slug.toLowerCase());
    keywords.push(...project.slug.toLowerCase().split(/[\-_]+/));
  }

  // Add path parts (folder names)
  for (const path of paths) {
    const parts = path.split('/').filter(p => p && !['var', 'www'].includes(p));
    keywords.push(...parts.map(p => p.toLowerCase()));
  }

  return [...new Set(keywords)]; // Remove duplicates
}

/**
 * Detect which project content belongs to
 * @param {string} content - The text content to analyze
 * @param {string} fallbackProject - Default project if none detected
 * @returns {object} { project: string, confidence: number, reason: string, ...projectInfo }
 */
async function detectProject(content, fallbackProject = '/var/www/Studio/kodiack-dashboard-5500') {
  if (!content || typeof content !== 'string') {
    return {
      project: fallbackProject,
      server_path: fallbackProject,
      confidence: 0,
      reason: 'no content'
    };
  }

  const projects = await loadProjectsFromDB();
  const contentLower = content.toLowerCase();
  const scores = {};

  for (const [serverPath, config] of Object.entries(projects)) {
    let score = 0;
    const matches = [];

    // Check for exact path match (strongest signal)
    if (content.includes(serverPath)) {
      score += 10;
      matches.push(`exact path: ${serverPath}`);
    }

    // Check for folder name matches
    for (const path of config.paths) {
      const folderName = path.split('/').pop();
      if (folderName && content.includes(folderName)) {
        score += 3;
        matches.push(`folder: ${folderName}`);
      }
    }

    // Check keywords
    for (const keyword of config.keywords) {
      if (keyword.length > 2 && contentLower.includes(keyword)) {
        score += 1;
        matches.push(`keyword: ${keyword}`);
      }
    }

    // Check project name mention
    if (config.name && contentLower.includes(config.name.toLowerCase())) {
      score += 4;
      matches.push(`name: ${config.name}`);
    }

    // Check client name mention
    if (config.client_name && contentLower.includes(config.client_name.toLowerCase())) {
      score += 2;
      matches.push(`client: ${config.client_name}`);
    }

    if (score > 0) {
      scores[serverPath] = { score, matches, config };
    }
  }

  // Find highest scoring project
  let bestPath = fallbackProject;
  let bestScore = 0;
  let bestMatches = [];
  let bestConfig = null;

  for (const [serverPath, data] of Object.entries(scores)) {
    if (data.score > bestScore) {
      bestScore = data.score;
      bestPath = serverPath;
      bestMatches = data.matches;
      bestConfig = data.config;
    }
  }

  // Calculate confidence (0-1)
  const confidence = Math.min(bestScore / 15, 1);

  // Only override fallback if we're reasonably confident
  if (confidence < 0.2 && bestPath !== fallbackProject) {
    logger.debug('Low confidence detection, using fallback', {
      detected: bestPath,
      confidence,
      fallback: fallbackProject
    });
    return {
      project: fallbackProject,
      server_path: fallbackProject,
      confidence: 0.1,
      reason: 'low confidence, using fallback'
    };
  }

  logger.info('Project detected', {
    project: bestConfig?.name || bestPath,
    path: bestPath,
    confidence: confidence.toFixed(2),
    matches: bestMatches.slice(0, 5)
  });

  return {
    project: bestPath,
    server_path: bestPath,
    project_id: bestConfig?.project_id || null,
    project_name: bestConfig?.name || null,
    client_id: bestConfig?.client_id || null,
    client_name: bestConfig?.client_name || null,
    is_parent: bestConfig?.is_parent || false,
    parent_id: bestConfig?.parent_id || null,
    confidence,
    reason: bestMatches.slice(0, 5).join(', ')
  };
}

/**
 * Detect multiple projects mentioned in content
 * Useful for conversations that span multiple projects
 */
async function detectAllProjects(content) {
  if (!content) return [];

  const projects = await loadProjectsFromDB();
  const contentLower = content.toLowerCase();
  const detected = [];

  for (const [serverPath, config] of Object.entries(projects)) {
    let score = 0;
    const matches = [];

    // Check for path matches
    if (content.includes(serverPath)) {
      score += 10;
      matches.push(serverPath);
    }

    // Check keywords
    for (const keyword of config.keywords) {
      if (keyword.length > 3 && contentLower.includes(keyword)) {
        score += 1;
        matches.push(keyword);
      }
    }

    if (score >= 2) {
      detected.push({
        project: serverPath,
        name: config.name,
        client: config.client_name,
        is_parent: config.is_parent,
        score,
        matches
      });
    }
  }

  return detected.sort((a, b) => b.score - a.score);
}

/**
 * Get project info by path from database
 */
async function getProjectInfo(projectPath) {
  const projects = await loadProjectsFromDB();
  return projects[projectPath] || null;
}

/**
 * Get project info by project_id
 */
async function getProjectById(projectId) {
  const projects = await loadProjectsFromDB();
  for (const [path, config] of Object.entries(projects)) {
    if (config.project_id === projectId) {
      return { path, ...config };
    }
  }
  return null;
}

/**
 * Get all projects for a client
 */
async function getProjectsForClient(clientId) {
  const projects = await loadProjectsFromDB();
  const result = [];
  for (const [path, config] of Object.entries(projects)) {
    if (config.client_id === clientId) {
      result.push({ path, ...config });
    }
  }
  return result;
}

/**
 * Get child projects for a parent
 */
async function getChildProjects(parentProjectId) {
  const projects = await loadProjectsFromDB();
  const result = [];
  for (const [path, config] of Object.entries(projects)) {
    if (config.parent_id === parentProjectId) {
      result.push({ path, ...config });
    }
  }
  return result;
}

/**
 * List all known projects (from cache or DB)
 */
async function listProjects() {
  const projects = await loadProjectsFromDB();
  return Object.entries(projects).map(([path, config]) => ({
    path,
    name: config.name,
    slug: config.slug,
    client: config.client_name,
    is_parent: config.is_parent
  }));
}

/**
 * Force refresh the project cache
 */
async function refreshCache() {
  cacheExpiry = 0;
  return await loadProjectsFromDB();
}

module.exports = {
  detectProject,
  detectAllProjects,
  getProjectInfo,
  getProjectById,
  getProjectsForClient,
  getChildProjects,
  listProjects,
  refreshCache,
  loadProjectsFromDB
};

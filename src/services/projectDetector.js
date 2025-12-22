/**
 * Susan Project Detector
 * Analyzes content to determine which project it belongs to
 * instead of blindly trusting session project_path
 */

const { Logger } = require('../lib/logger');
const logger = new Logger('Susan:ProjectDetector');

// Known projects with detection patterns
// Server paths use full paths: /var/www/Studio/...
const PROJECTS = {
  // === Studios Platform Children ===
  '/var/www/Studio/kodiack-dashboard-5500': {
    name: 'Kodiack Dashboard',
    aliases: ['dashboard', 'kodiack dashboard', 'project-management', 'session-logs'],
    keywords: ['sidebar', 'panel', 'terminal', 'claude code', 'mcp', 'tabs', 'ui component'],
    paths: ['kodiack-dashboard-5500', 'dashboard-5500'],
    weight: 1.0
  },
  '/var/www/Studio/dev-studio-5000': {
    name: 'Development Studio',
    aliases: ['dev studio', 'old studio', 'studio-5000'],
    keywords: ['legacy', 'deprecated', 'migration'],
    paths: ['dev-studio-5000', 'studio-5000'],
    weight: 0.5  // Lower weight - deprecated
  },
  '/var/www/Studio/auth-7000': {
    name: 'Auth Service',
    aliases: ['auth', 'authentication', 'auth service'],
    keywords: ['login', 'logout', 'jwt', 'token', 'session', 'oauth', 'password', 'credential'],
    paths: ['auth-7000'],
    weight: 1.0
  },
  // === AI Team ===
  '/var/www/Studio/ai-team/ai-chad-5401': {
    name: 'Chad - Transcription',
    aliases: ['chad', 'transcription', 'chat hook', 'capture'],
    keywords: ['buffer', 'websocket', 'terminal capture', 'raw content', 'session dump', 'hook'],
    paths: ['ai-chad-5401', 'chad-5401'],
    weight: 1.0
  },
  '/var/www/Studio/ai-team/ai-jen-5402': {
    name: 'Jen - Extraction',
    aliases: ['jen', 'extraction', 'scrubbing', 'smart extractor'],
    keywords: ['bucket', 'scrub', 'parse', 'extract', 'category', 'ansi', 'cleaning'],
    paths: ['ai-jen-5402', 'jen-5402'],
    weight: 1.0
  },
  '/var/www/Studio/ai-team/ai-susan-5403': {
    name: 'Susan - Classification',
    aliases: ['susan', 'classification', 'sorting', 'project detector'],
    keywords: ['sort', 'classify', 'route', 'detect project', 'knowledge base', 'briefing'],
    paths: ['ai-susan-5403', 'susan-5403'],
    weight: 1.0
  },
  '/var/www/Studio/ai-team/ai-clair-5404': {
    name: 'Clair - Documentation',
    aliases: ['clair', 'documentation', 'journal', 'night compiler'],
    keywords: ['journal', 'docs', 'compile', 'night', 'day organizer', 'write'],
    paths: ['ai-clair-5404', 'clair-5404'],
    weight: 1.0
  },
  '/var/www/Studio/ai-team/ai-mike-5405': {
    name: 'Mike - QA',
    aliases: ['mike', 'qa', 'quality assurance', 'testing'],
    keywords: ['test', 'quality', 'review', 'validate'],
    paths: ['ai-mike-5405', 'mike-5405'],
    weight: 1.0
  },
  '/var/www/Studio/ai-team/ai-tiffany-5406': {
    name: 'Tiffany - QA',
    aliases: ['tiffany', 'qa', 'quality assurance'],
    keywords: ['test', 'quality', 'review', 'validate'],
    paths: ['ai-tiffany-5406', 'tiffany-5406'],
    weight: 1.0
  },
  '/var/www/Studio/ai-team/ai-ryan-5407': {
    name: 'Ryan - Roadmap',
    aliases: ['ryan', 'roadmap', 'planning', 'recommendations'],
    keywords: ['roadmap', 'plan', 'recommend', 'priority', 'schedule', 'milestone'],
    paths: ['ai-ryan-5407', 'ryan-5407'],
    weight: 1.0
  }
  // TODO: Add NextBid projects when ready
};

/**
 * Detect which project content belongs to
 * @param {string} content - The text content to analyze
 * @param {string} fallbackProject - Default project if none detected
 * @returns {object} { project: string, confidence: number, reason: string }
 */
function detectProject(content, fallbackProject = '/var/www/Studio/kodiack-dashboard-5500') {
  if (!content || typeof content !== 'string') {
    return { project: fallbackProject, confidence: 0, reason: 'no content' };
  }

  const contentLower = content.toLowerCase();
  const scores = {};

  for (const [projectPath, config] of Object.entries(PROJECTS)) {
    let score = 0;
    const matches = [];

    // Check aliases (strongest signal)
    for (const alias of config.aliases) {
      if (contentLower.includes(alias)) {
        score += 3 * config.weight;
        matches.push(`alias: ${alias}`);
      }
    }

    // Check file paths
    for (const pathPattern of config.paths) {
      if (content.includes(pathPattern)) {
        score += 2 * config.weight;
        matches.push(`path: ${pathPattern}`);
      }
    }

    // Check domain keywords
    for (const keyword of config.keywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
      const keywordMatches = content.match(regex);
      if (keywordMatches) {
        score += (0.5 * keywordMatches.length) * config.weight;
        matches.push(`keyword: ${keyword} (${keywordMatches.length}x)`);
      }
    }

    if (score > 0) {
      scores[projectPath] = { score, matches };
    }
  }

  // Find highest scoring project
  let bestProject = fallbackProject;
  let bestScore = 0;
  let bestMatches = [];

  for (const [projectPath, data] of Object.entries(scores)) {
    if (data.score > bestScore) {
      bestScore = data.score;
      bestProject = projectPath;
      bestMatches = data.matches;
    }
  }

  // Calculate confidence (0-1)
  const confidence = Math.min(bestScore / 10, 1);

  // Only override fallback if we're reasonably confident
  if (confidence < 0.3 && bestProject !== fallbackProject) {
    logger.debug('Low confidence detection, using fallback', {
      detected: bestProject,
      confidence,
      fallback: fallbackProject
    });
    return { project: fallbackProject, confidence: 0.1, reason: 'low confidence, using fallback' };
  }

  logger.info('Project detected', {
    project: bestProject,
    confidence: confidence.toFixed(2),
    matches: bestMatches.slice(0, 5)
  });

  return {
    project: bestProject,
    confidence,
    reason: bestMatches.slice(0, 5).join(', ')
  };
}

/**
 * Detect multiple projects mentioned in content
 * Useful for conversations that span multiple projects
 */
function detectAllProjects(content) {
  if (!content) return [];

  const contentLower = content.toLowerCase();
  const detected = [];

  for (const [projectPath, config] of Object.entries(PROJECTS)) {
    let score = 0;
    const matches = [];

    for (const alias of config.aliases) {
      if (contentLower.includes(alias)) {
        score += 3;
        matches.push(alias);
      }
    }

    for (const pathPattern of config.paths) {
      if (content.includes(pathPattern)) {
        score += 2;
        matches.push(pathPattern);
      }
    }

    if (score >= 2) {
      detected.push({
        project: projectPath,
        name: config.name,
        score,
        matches
      });
    }
  }

  return detected.sort((a, b) => b.score - a.score);
}

/**
 * Get project info by path
 */
function getProjectInfo(projectPath) {
  return PROJECTS[projectPath] || null;
}

/**
 * List all known projects
 */
function listProjects() {
  return Object.entries(PROJECTS).map(([path, config]) => ({
    path,
    name: config.name,
    aliases: config.aliases
  }));
}

module.exports = {
  detectProject,
  detectAllProjects,
  getProjectInfo,
  listProjects,
  PROJECTS
};

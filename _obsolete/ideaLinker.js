/**
 * Idea to Project Linker Service
 *
 * When new projects are created, this service:
 * 1. Searches for matching Ideas in the knowledge base
 * 2. Links those ideas to the new project
 * 3. Optionally promotes them from "Ideas" to "System Breakdown"
 * 4. Notifies about the linkage
 */

const { from } = require('../lib/db');

// Fuzzy match threshold (0-1, higher = stricter)
const MATCH_THRESHOLD = 0.6;

/**
 * Calculate similarity between two strings
 */
function similarity(str1, str2) {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();

  // Exact match
  if (s1 === s2) return 1;

  // Check if one contains the other
  if (s1.includes(s2) || s2.includes(s1)) return 0.9;

  // Word overlap scoring
  const words1 = s1.split(/[\s\-_]+/);
  const words2 = s2.split(/[\s\-_]+/);

  let matches = 0;
  for (const w1 of words1) {
    for (const w2 of words2) {
      if (w1 === w2 || w1.includes(w2) || w2.includes(w1)) {
        matches++;
        break;
      }
    }
  }

  return matches / Math.max(words1.length, words2.length);
}

/**
 * Find unlinked ideas that might match a project
 */
async function findMatchingIdeas(project) {
  // Get all unlinked Ideas
  const { data: ideas, error } = await from('dev_ai_knowledge')
    .select('*')
    .eq('category', 'Ideas')
    .is('project_id', null);

  if (error || !ideas) {
    console.error('Error fetching ideas:', error);
    return [];
  }

  const matches = [];

  for (const idea of ideas) {
    // Check title similarity
    const titleScore = similarity(idea.title, project.name);

    // Check content for project name mentions
    const contentMention = idea.content?.toLowerCase().includes(project.name.toLowerCase())
      || idea.content?.toLowerCase().includes(project.slug?.toLowerCase());

    const score = contentMention ? Math.max(titleScore, 0.85) : titleScore;

    if (score >= MATCH_THRESHOLD) {
      matches.push({ idea, score });
    }
  }

  // Sort by score descending
  return matches.sort((a, b) => b.score - a.score);
}

/**
 * Link an idea to a project
 */
async function linkIdeaToProject(idea, project, promote = false) {
  const updates = {
    project_id: project.id,
    client_id: project.client_id,
    updated_at: new Date().toISOString()
  };

  // Optionally promote from Ideas to System Breakdown
  if (promote) {
    updates.category = 'System Breakdown';
  }

  const { error } = await from('dev_ai_knowledge')
    .update(updates)
    .eq('id', idea.id);

  if (error) {
    console.error('Error linking idea:', error);
    return false;
  }

  console.log('Linked idea "' + idea.title + '" to project "' + project.name + '"');
  return true;
}

/**
 * Create a notification about the linkage
 */
async function notifyLinkage(idea, project) {
  try {
    await from('dev_ai_notifications').insert({
      type: 'idea_linked',
      title: 'Idea linked to ' + project.name,
      message: 'Found existing brainstorm "' + idea.title + '" - attached to new project.',
      project_id: project.server_path || project.local_path,
      is_read: false,
      created_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error creating notification:', err);
  }
}

/**
 * Check for new projects and link matching ideas
 * Called periodically or on-demand
 */
async function linkIdeasToNewProjects() {
  console.log('Checking for projects to link with ideas...');

  // Get all projects
  const { data: projects, error } = await from('dev_projects')
    .select('*')
    .order('created_at', { ascending: false });

  if (error || !projects) {
    console.error('Error fetching projects:', error);
    return { linked: 0, errors: [] };
  }

  let linked = 0;
  const errors = [];

  for (const project of projects) {
    const matches = await findMatchingIdeas(project);

    for (const match of matches) {
      const idea = match.idea;
      const score = match.score;
      console.log('Found match: "' + idea.title + '" -> "' + project.name + '" (score: ' + score.toFixed(2) + ')');

      // Link with promotion if high confidence
      const promote = score >= 0.85;
      const success = await linkIdeaToProject(idea, project, promote);

      if (success) {
        linked++;
        await notifyLinkage(idea, project);
      } else {
        errors.push({ idea: idea.title, project: project.name });
      }
    }
  }

  console.log('Linked ' + linked + ' ideas to projects');
  return { linked, errors };
}

/**
 * Link a specific idea to a project by name
 */
async function linkIdeaByName(ideaTitle, projectName, promote = true) {
  // Find the idea
  const { data: ideas } = await from('dev_ai_knowledge')
    .select('*')
    .eq('category', 'Ideas')
    .ilike('title', '%' + ideaTitle + '%');

  if (!ideas || ideas.length === 0) {
    return { success: false, error: 'Idea not found' };
  }

  // Find the project
  const { data: projects } = await from('dev_projects')
    .select('*')
    .or('name.ilike.%' + projectName + '%,slug.ilike.%' + projectName + '%');

  if (!projects || projects.length === 0) {
    return { success: false, error: 'Project not found' };
  }

  const idea = ideas[0];
  const project = projects[0];

  const success = await linkIdeaToProject(idea, project, promote);

  if (success) {
    await notifyLinkage(idea, project);
    return { success: true, idea: idea.title, project: project.name };
  }

  return { success: false, error: 'Failed to update' };
}

/**
 * Get all unlinked ideas
 */
async function getUnlinkedIdeas() {
  const { data, error } = await from('dev_ai_knowledge')
    .select('id, title, summary, created_at')
    .eq('category', 'Ideas')
    .is('project_id', null)
    .order('created_at', { ascending: false });

  return data || [];
}

module.exports = {
  linkIdeasToNewProjects,
  linkIdeaByName,
  findMatchingIdeas,
  getUnlinkedIdeas,
  similarity
};

/**
 * Susan Duplicate Checker
 * Finds similar items by title/content matching
 * Uses string similarity (no AI needed)
 */

const { from } = require('../../../shared/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:DuplicateChecker');

// Similarity threshold (0-1) - items above this are considered duplicates
const SIMILARITY_THRESHOLD = 0.7;

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/**
 * Calculate similarity score between two strings (0-1)
 */
function similarity(str1, str2) {
  if (!str1 || !str2) return 0;
  
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  
  if (s1 === s2) return 1;
  
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1;
  
  const distance = levenshteinDistance(s1, s2);
  return 1 - (distance / maxLen);
}

/**
 * Extract key terms from a title
 * Fix X on the dashboard -> [fix, x, dashboard]
 */
function extractTerms(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 2 && !STOP_WORDS.has(word));
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'has',
  'been', 'are', 'was', 'were', 'will', 'would', 'should', 'could',
  'can', 'may', 'might', 'must', 'shall', 'not', 'but', 'its', 'also'
]);

/**
 * Check if two items are duplicates/similar
 * Returns similarity score (0-1)
 */
function areSimilar(item1, item2) {
  // Same project check (items from different projects aren't duplicates)
  if (item1.project_id !== item2.project_id) return 0;
  
  // Title similarity
  const titleSim = similarity(item1.title, item2.title);
  
  // Term overlap (for cases like fix X vs fix X on dashboard)
  const terms1 = extractTerms(item1.title);
  const terms2 = extractTerms(item2.title);
  const commonTerms = terms1.filter(t => terms2.includes(t));
  const termOverlap = commonTerms.length / Math.max(terms1.length, terms2.length, 1);
  
  // Weighted score
  return (titleSim * 0.6) + (termOverlap * 0.4);
}

/**
 * Find duplicates in a table
 * @param {string} table - Table name (dev_ai_todos, dev_ai_bugs, etc.)
 * @param {string} projectId - Project ID to scope the search
 * @param {array} statuses - Statuses to check (default: open/unassigned/pending/active)
 */
async function findDuplicates(table, projectId, statuses = ['unassigned', 'open', 'pending', 'active']) {
  try {
    let query = from(table)
      .select('id, title, project_id, status, created_at')
      .eq('project_id', projectId);
    
    // Filter by statuses
    if (statuses.length > 0) {
      query = query.in('status', statuses);
    }
    
    const { data: items, error } = await query.order('created_at', { ascending: true });
    
    if (error || !items?.length) {
      return { groups: [], singles: [] };
    }
    
    // Group similar items
    const groups = [];
    const used = new Set();
    
    for (let i = 0; i < items.length; i++) {
      if (used.has(items[i].id)) continue;
      
      const group = [items[i]];
      used.add(items[i].id);
      
      for (let j = i + 1; j < items.length; j++) {
        if (used.has(items[j].id)) continue;
        
        const sim = areSimilar(items[i], items[j]);
        if (sim >= SIMILARITY_THRESHOLD) {
          group.push(items[j]);
          used.add(items[j].id);
        }
      }
      
      if (group.length > 1) {
        groups.push(group);
      }
    }
    
    // Singles are items not in any duplicate group
    const singles = items.filter(i => !used.has(i.id) || 
      groups.every(g => !g.some(gi => gi.id === i.id)));
    
    return { groups, singles };
  } catch (err) {
    logger.error('findDuplicates failed', { table, projectId, error: err.message });
    return { groups: [], singles: [] };
  }
}

/**
 * Find all duplicates across all projects for a table
 */
async function findAllDuplicates(table, statuses = ['unassigned', 'open', 'pending', 'active']) {
  try {
    // Get distinct project IDs
    const { data: projects } = await from('dev_projects').select('id');
    
    if (!projects?.length) return [];
    
    const allGroups = [];
    
    for (const project of projects) {
      const { groups } = await findDuplicates(table, project.id, statuses);
      allGroups.push(...groups);
    }
    
    return allGroups;
  } catch (err) {
    logger.error('findAllDuplicates failed', { table, error: err.message });
    return [];
  }
}

module.exports = {
  similarity,
  areSimilar,
  extractTerms,
  findDuplicates,
  findAllDuplicates,
  SIMILARITY_THRESHOLD
};

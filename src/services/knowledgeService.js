/**
 * Susan Knowledge Service
 * Query and manage stored knowledge
 *
 * NOTE: Extraction is now handled by Jen.
 * Susan only provides querying and storage APIs.
 */

const { from } = require('../lib/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:KnowledgeService');

/**
 * Initialize knowledge service
 */
async function initialize() {
  logger.info('Knowledge service initialized');
  return true;
}

/**
 * Store knowledge (called by routes, not extraction)
 */
async function storeKnowledge(projectId, knowledge, metadata = {}) {
  const { data, error } = await from('dev_ai_knowledge').insert({
    project_id: projectId,
    category: knowledge.category,
    title: knowledge.title,
    summary: knowledge.summary,
    details: knowledge.details,
    tags: knowledge.tags || [],
    importance: knowledge.importance || 5,
    source: metadata.source || 'manual',
    cataloger: metadata.cataloger
  }).select('id').single();

  if (error) {
    logger.error('Knowledge storage failed', { error: error.message });
    throw error;
  }

  logger.info('Knowledge stored', {
    id: data.id,
    category: knowledge.category,
    title: knowledge.title
  });

  return data.id;
}

/**
 * Search knowledge base
 */
async function search(query, options = {}) {
  const { projectPath, category, limit = 10 } = options;

  let dbQuery = from('dev_ai_knowledge')
    .select('id, category, title, summary, tags, importance, created_at, project_id')
    .order('importance', { ascending: false })
    .limit(limit);

  if (query) {
    dbQuery = dbQuery.or(`title.ilike.%${query}%,summary.ilike.%${query}%`);
  }

  if (projectPath) {
    dbQuery = dbQuery.or(`project_id.eq.${projectPath},project_id.is.null`);
  }

  if (category) {
    dbQuery = dbQuery.eq('category', category);
  }

  const { data, error } = await dbQuery;
  if (error) throw error;

  return data || [];
}

/**
 * Get knowledge by category
 */
async function getByCategory(category, projectPath = null, limit = 20) {
  let query = from('dev_ai_knowledge')
    .select('*')
    .eq('category', category)
    .order('importance', { ascending: false })
    .limit(limit);

  if (projectPath) {
    query = query.eq('project_id', projectPath);
  }

  const { data, error } = await query;
  if (error) throw error;

  return data || [];
}

/**
 * Get most important knowledge
 */
async function getMostImportant(projectPath = null, limit = 10) {
  let query = from('dev_ai_knowledge')
    .select('*')
    .order('importance', { ascending: false })
    .limit(limit);

  if (projectPath) {
    query = query.or(`project_id.eq.${projectPath},project_id.is.null`);
  }

  const { data, error } = await query;
  if (error) throw error;

  return data || [];
}

/**
 * Update knowledge importance
 */
async function updateImportance(id, importance) {
  const { error } = await from('dev_ai_knowledge')
    .update({ importance })
    .eq('id', id);

  if (error) throw error;

  logger.info('Knowledge importance updated', { id, importance });
}

/**
 * Get knowledge by ID
 */
async function getById(id) {
  const { data, error } = await from('dev_ai_knowledge')
    .select('*')
    .eq('id', id)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Get knowledge stats
 */
async function getStats(projectPath = null) {
  let query = from('dev_ai_knowledge')
    .select('category, importance');

  if (projectPath) {
    query = query.eq('project_id', projectPath);
  }

  const { data, error } = await query;
  if (error) throw error;

  const stats = {
    total: data?.length || 0,
    byCategory: {},
    avgImportance: 0
  };

  if (data && data.length > 0) {
    let totalImportance = 0;
    data.forEach(item => {
      stats.byCategory[item.category] = (stats.byCategory[item.category] || 0) + 1;
      totalImportance += item.importance || 0;
    });
    stats.avgImportance = Math.round((totalImportance / data.length) * 10) / 10;
  }

  return stats;
}

/**
 * Get all categories
 */
async function getCategories() {
  const { data, error } = await from('dev_ai_knowledge')
    .select('category')
    .order('category', { ascending: true });

  if (error) throw error;

  const categories = [...new Set((data || []).map(d => d.category))];
  return categories;
}

module.exports = {
  initialize,
  storeKnowledge,
  search,
  getByCategory,
  getMostImportant,
  updateImportance,
  getById,
  getStats,
  getCategories
};

/**
 * Susan Knowledge Service
 * Manages knowledge extraction and storage
 */

const { from } = require('../lib/db');
const { extractKnowledge } = require('../lib/openai');
const { Logger } = require('../lib/logger');
const config = require('../lib/config');

const logger = new Logger('Susan:KnowledgeService');

/**
 * Initialize knowledge service
 */
async function initialize() {
  logger.info('Knowledge service initialized');
  return true;
}

/**
 * Process content for knowledge extraction
 */
async function processContent(sessionId, projectPath, content, metadata = {}) {
  if (content.length < config.MIN_CONTENT_LENGTH) {
    return null;
  }

  try {
    const result = await extractKnowledge(content);

    if (result.shouldRemember && result.knowledge) {
      return await storeKnowledge(sessionId, projectPath, result.knowledge, metadata);
    }

    return null;
  } catch (err) {
    logger.error('Knowledge processing failed', { error: err.message, sessionId });
    return null;
  }
}

/**
 * Store extracted knowledge with conflict detection
 * If similar knowledge exists, flag conflict for dev review instead of overwriting
 */
async function storeKnowledge(sessionId, projectPath, knowledge, metadata = {}) {
  // Check for potential conflicts with existing knowledge
  const conflict = await checkForConflicts(projectPath, knowledge);

  if (conflict) {
    // Flag the conflict instead of storing - dev must review
    await flagConflict(projectPath, conflict.existingRecord, knowledge, metadata.source);
    logger.info('Knowledge conflict flagged for review', {
      existingId: conflict.existingRecord.id,
      newTitle: knowledge.title
    });
    return { conflictFlagged: true, existingId: conflict.existingRecord.id };
  }

  // No conflict - safe to store
  const { data, error } = await from('dev_ai_knowledge').insert({
    session_id: sessionId,
    project_path: projectPath,
    category: knowledge.category,
    title: knowledge.title,
    summary: knowledge.summary,
    details: knowledge.details,
    tags: knowledge.tags || [],
    importance: knowledge.importance || 5,
    source: metadata.source || 'extraction',
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
 * Check for conflicts with existing knowledge
 */
async function checkForConflicts(projectPath, newKnowledge) {
  // Look for existing knowledge with same category and similar title
  const { data: existing } = await from('dev_ai_knowledge')
    .select('id, title, summary, details, category')
    .eq('category', newKnowledge.category)
    .or(`project_path.eq.${projectPath},project_path.is.null`)
    .ilike('title', `%${newKnowledge.title.substring(0, 50)}%`);

  if (!existing || existing.length === 0) {
    return null;
  }

  // Check if any existing record has conflicting content
  for (const record of existing) {
    const isConflict = detectContentConflict(record, newKnowledge);
    if (isConflict) {
      return {
        existingRecord: record,
        conflictType: isConflict.type,
        reason: isConflict.reason
      };
    }
  }

  return null;
}

/**
 * Detect if new content conflicts with existing
 */
function detectContentConflict(existing, newKnowledge) {
  // Same title but different summary/details = potential conflict
  const titleSimilar = existing.title.toLowerCase().includes(newKnowledge.title.toLowerCase().substring(0, 30)) ||
                       newKnowledge.title.toLowerCase().includes(existing.title.toLowerCase().substring(0, 30));

  if (titleSimilar) {
    // Check if summaries differ significantly
    const existingSummary = (existing.summary || '').toLowerCase();
    const newSummary = (newKnowledge.summary || '').toLowerCase();

    // If titles are similar but summaries are different, flag as potential conflict
    if (existingSummary && newSummary && existingSummary !== newSummary) {
      // Look for contradicting keywords
      const contradictionPairs = [
        ['enabled', 'disabled'],
        ['true', 'false'],
        ['yes', 'no'],
        ['required', 'optional'],
        ['deprecated', 'recommended'],
        ['removed', 'added'],
        ['before', 'after'],
        ['old', 'new']
      ];

      for (const [word1, word2] of contradictionPairs) {
        if ((existingSummary.includes(word1) && newSummary.includes(word2)) ||
            (existingSummary.includes(word2) && newSummary.includes(word1))) {
          return {
            type: 'contradiction',
            reason: `Existing says "${word1}", new says "${word2}"`
          };
        }
      }

      // Different summaries for same topic = potential outdated info
      return {
        type: 'outdated',
        reason: 'Same topic with different information - may need update'
      };
    }

    // Exact duplicate
    if (existingSummary === newSummary) {
      return {
        type: 'duplicate',
        reason: 'Duplicate knowledge entry'
      };
    }
  }

  return null;
}

/**
 * Flag a conflict for dev review
 */
async function flagConflict(projectPath, existingRecord, newKnowledge, source) {
  const { error } = await from('dev_ai_conflicts').insert({
    project_path: projectPath,
    existing_table: 'dev_ai_knowledge',
    existing_id: existingRecord.id,
    existing_content: existingRecord.details,
    existing_summary: existingRecord.summary,
    new_content: newKnowledge.details || newKnowledge.summary,
    new_source: source,
    conflict_type: 'contradiction',
    conflict_description: `New knowledge about "${newKnowledge.title}" may conflict with existing "${existingRecord.title}"`,
    status: 'pending',
    flagged_by: 'susan',
    priority: newKnowledge.importance >= 7 ? 'high' : 'medium'
  });

  if (error) {
    logger.error('Failed to flag conflict', { error: error.message });
  }

  // Create notification
  await from('dev_ai_notifications').insert({
    dev_id: 'assigned',
    project_path: projectPath,
    notification_type: 'conflict',
    title: `Knowledge Conflict: ${newKnowledge.title}`,
    message: `New information may conflict with existing knowledge. Please review.`,
    related_table: 'dev_ai_knowledge',
    related_id: existingRecord.id,
    status: 'unread'
  });
}

/**
 * Search knowledge base
 */
async function search(query, options = {}) {
  const { projectPath, category, limit = 10 } = options;

  let dbQuery = from('dev_ai_knowledge')
    .select('id, category, title, summary, tags, importance, created_at')
    .order('importance', { ascending: false })
    .limit(limit);

  if (query) {
    dbQuery = dbQuery.or(`title.ilike.%${query}%,summary.ilike.%${query}%`);
  }

  if (projectPath) {
    dbQuery = dbQuery.or(`project_path.eq.${projectPath},project_path.is.null`);
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
    query = query.eq('project_path', projectPath);
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
    query = query.or(`project_path.eq.${projectPath},project_path.is.null`);
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
 * Get knowledge stats
 */
async function getStats(projectPath = null) {
  let query = from('dev_ai_knowledge')
    .select('category, importance');

  if (projectPath) {
    query = query.eq('project_path', projectPath);
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

module.exports = {
  initialize,
  processContent,
  storeKnowledge,
  checkForConflicts,
  search,
  getByCategory,
  getMostImportant,
  updateImportance,
  getStats
};

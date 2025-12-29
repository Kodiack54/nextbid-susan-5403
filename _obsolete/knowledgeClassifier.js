/**
 * Susan Knowledge Classifier
 * Receives categorized knowledge from Chad, validates/confirms categories,
 * and stores in the new dev_knowledge table with proper classification
 * 
 * Categories: decision, lesson, system, procedure, issue, reference, idea, log
 */

const { from } = require('../lib/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:Classifier');

// Susan's validation rules for each category
const CATEGORY_VALIDATORS = {
  decision: {
    requiredSignals: ['decided', 'chose', 'going with', 'will use', 'the decision'],
    minConfidence: 0.70,
    boostSignals: ['instead of', 'rather than', 'alternatives']
  },
  lesson: {
    requiredSignals: ['learned', 'realized', 'gotcha', 'mistake', 'turns out'],
    minConfidence: 0.65,
    boostSignals: ['next time', 'avoid', 'remember']
  },
  system: {
    requiredSignals: ['architecture', 'component', 'service', 'database', 'api', 'schema'],
    minConfidence: 0.65,
    boostSignals: ['how it works', 'connects to', 'data flow']
  },
  procedure: {
    requiredSignals: ['steps', 'process', 'how to', 'setup', 'configure', 'deploy'],
    minConfidence: 0.70,
    boostSignals: ['first', 'then', 'finally', 'step']
  },
  issue: {
    requiredSignals: ['bug', 'error', 'broken', 'failed', 'not working', 'fix'],
    minConfidence: 0.75,
    boostSignals: ['stack trace', 'exception', 'crash']
  },
  reference: {
    requiredSignals: ['port', 'path', 'url', 'endpoint', 'config', 'credential'],
    minConfidence: 0.60,
    boostSignals: ['located at', 'runs on', 'stored in']
  },
  idea: {
    requiredSignals: ['could', 'might', 'should', 'maybe', 'future', 'consider'],
    minConfidence: 0.55,
    boostSignals: ['enhancement', 'v2', 'eventually']
  },
  log: {
    requiredSignals: [],  // Fallback category
    minConfidence: 0.30,
    boostSignals: ['today', 'session', 'worked on']
  }
};

/**
 * Validate Chad's category suggestion
 * Returns { valid, finalCategory, confidence, reason }
 */
function validateCategory(item) {
  const { suggestedCategory, categoryConfidence, categorySignals = [], title, summary } = item;
  const text = `${title || ''} ${summary || ''}`.toLowerCase();
  
  const validator = CATEGORY_VALIDATORS[suggestedCategory];
  if (!validator) {
    return { valid: false, finalCategory: 'log', confidence: 0.30, reason: 'unknown_category' };
  }
  
  // Check if confidence meets threshold
  if (categoryConfidence >= validator.minConfidence) {
    // High confidence - trust Chad
    return { 
      valid: true, 
      finalCategory: suggestedCategory, 
      confidence: categoryConfidence,
      reason: 'chad_high_confidence'
    };
  }
  
  // Low confidence - Susan validates
  let validationScore = 0;
  let matchedSignals = [];
  
  // Check required signals in text
  for (const signal of validator.requiredSignals) {
    if (text.includes(signal)) {
      validationScore += 2;
      matchedSignals.push(signal);
    }
  }
  
  // Check boost signals
  for (const signal of validator.boostSignals) {
    if (text.includes(signal)) {
      validationScore += 1;
      matchedSignals.push(signal);
    }
  }
  
  // If Susan finds enough signals, accept Chad's suggestion
  if (validationScore >= 3) {
    const newConfidence = Math.min(0.90, categoryConfidence + (validationScore * 0.05));
    return {
      valid: true,
      finalCategory: suggestedCategory,
      confidence: newConfidence,
      reason: 'susan_validated',
      susanSignals: matchedSignals
    };
  }
  
  // Check if another category fits better
  let bestAlt = null;
  let bestAltScore = 0;
  
  for (const [cat, val] of Object.entries(CATEGORY_VALIDATORS)) {
    if (cat === suggestedCategory) continue;
    
    let altScore = 0;
    for (const signal of val.requiredSignals) {
      if (text.includes(signal)) altScore += 2;
    }
    for (const signal of val.boostSignals) {
      if (text.includes(signal)) altScore += 1;
    }
    
    if (altScore > bestAltScore) {
      bestAltScore = altScore;
      bestAlt = cat;
    }
  }
  
  // If alternative is significantly better, override
  if (bestAlt && bestAltScore > validationScore + 2) {
    return {
      valid: false,
      finalCategory: bestAlt,
      confidence: Math.min(0.80, 0.50 + (bestAltScore * 0.05)),
      reason: 'susan_override',
      originalCategory: suggestedCategory
    };
  }
  
  // Accept Chad's suggestion with low confidence
  return {
    valid: true,
    finalCategory: suggestedCategory,
    confidence: Math.max(0.40, categoryConfidence),
    reason: 'chad_accepted_low_confidence'
  };
}

/**
 * Process knowledge items from Chad's extraction
 * Stores in dev_knowledge with validated categories
 */
async function processKnowledgeItems(items, context = {}) {
  const { sessionId, projectPath, clientId, projectId } = context;
  
  const results = {
    processed: 0,
    stored: 0,
    overridden: 0,
    errors: 0,
    items: []
  };
  
  for (const item of items) {
    try {
      // Validate category
      const validation = validateCategory(item);
      
      if (validation.reason === 'susan_override') {
        results.overridden++;
        logger.info('Category overridden', {
          title: item.title?.substring(0, 50),
          from: validation.originalCategory,
          to: validation.finalCategory
        });
      }
      
      // Determine importance from confidence and source
      let importance = 'normal';
      if (validation.confidence >= 0.85) importance = 'high';
      if (item.sourceType === 'decision') importance = 'high';
      if (item.sourceType === 'issue' && item.issueStatus === 'unresolved') importance = 'high';
      
      // Store in new dev_knowledge table
      const { data, error } = await from('dev_knowledge').insert({
        title: item.title || 'Untitled',
        summary: item.summary || '',
        full_content: item.fullContent || null,
        category: validation.finalCategory,
        category_confidence: validation.confidence,
        category_suggested_by: validation.reason === 'susan_override' ? 'susan' : 'chad',
        client_id: clientId || null,
        project_id: projectId || null,
        location_confidence: 0.70,  // Default - Chad's location routing
        importance: importance,
        status: 'active',
        confidence: validation.confidence >= 0.75 ? 'likely' : 'uncertain',
        scope: projectId ? 'project' : (clientId ? 'client' : 'global'),
        source_type: 'session',
        
        extracted_by: 'chad'
      }).select('id').single();
      
      if (error) {
        logger.error('Failed to store knowledge', { error: error.message, title: item.title });
        results.errors++;
        continue;
      }
      
      results.stored++;
      results.items.push({
        id: data.id,
        title: item.title,
        category: validation.finalCategory,
        confidence: validation.confidence,
        validated: validation.reason
      });
      
      // Log correction if Susan overrode
      if (validation.reason === 'susan_override') {
        await logCorrection(data.id, 'category', validation.originalCategory, validation.finalCategory, 'susan_validation');
      }
      
      results.processed++;
    } catch (err) {
      logger.error('Error processing knowledge item', { error: err.message });
      results.errors++;
    }
  }
  
  logger.info('Knowledge processing complete', {
    processed: results.processed,
    stored: results.stored,
    overridden: results.overridden,
    errors: results.errors
  });
  
  return results;
}

/**
 * Log a correction for the learning loop
 */
async function logCorrection(knowledgeId, field, originalValue, correctedValue, reason) {
  try {
    await from('dev_knowledge_corrections').insert({
      knowledge_id: knowledgeId,
      field_corrected: field,
      original_value: originalValue,
      corrected_value: correctedValue,
      correction_reason: reason,
      corrected_by: 'susan',
      learned: false
    });
  } catch (err) {
    logger.error('Failed to log correction', { error: err.message });
  }
}

/**
 * Add tags to a knowledge item
 */
async function addTags(knowledgeId, tags, tagType = 'general') {
  const inserts = tags.map(tag => ({
    knowledge_id: knowledgeId,
    tag: tag.toLowerCase(),
    tag_type: tagType
  }));
  
  try {
    await from('dev_knowledge_tags').insert(inserts);
  } catch (err) {
    // Ignore duplicate tag errors
    if (!err.message.includes('duplicate')) {
      logger.error('Failed to add tags', { error: err.message });
    }
  }
}

/**
 * Link two knowledge items
 */
async function linkKnowledge(sourceId, targetId, linkType, description = null) {
  try {
    await from('dev_knowledge_links').insert({
      source_id: sourceId,
      target_id: targetId,
      link_type: linkType,
      description: description,
      created_by: 'susan'
    });
  } catch (err) {
    if (!err.message.includes('duplicate')) {
      logger.error('Failed to link knowledge', { error: err.message });
    }
  }
}

/**
 * Get unlearned corrections for improving Chad's patterns
 */
async function getUnlearnedCorrections(limit = 50) {
  const { data, error } = await from('dev_knowledge_corrections')
    .select('*')
    .eq('learned', false)
    .order('corrected_at', { ascending: true })
    .limit(limit);
  
  if (error) {
    logger.error('Failed to get corrections', { error: error.message });
    return [];
  }
  
  return data || [];
}

/**
 * Mark corrections as learned
 */
async function markCorrectionsLearned(correctionIds) {
  const { error } = await from('dev_knowledge_corrections')
    .update({ learned: true, learned_at: new Date().toISOString() })
    .in('id', correctionIds);
  
  if (error) {
    logger.error('Failed to mark corrections learned', { error: error.message });
  }
}

/**
 * Get knowledge by category with pagination
 */
async function getByCategory(category, options = {}) {
  const { projectId, clientId, limit = 20, offset = 0 } = options;
  
  let query = from('dev_knowledge')
    .select('*')
    .eq('category', category)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  
  if (projectId) query = query.eq('project_id', projectId);
  if (clientId) query = query.eq('client_id', clientId);
  
  const { data, error } = await query;
  if (error) throw error;
  
  return data || [];
}

/**
 * Search knowledge across all categories
 */
async function searchKnowledge(searchQuery, options = {}) {
  const { category, projectId, limit = 20 } = options;
  
  let query = from('dev_knowledge')
    .select('*')
    .eq('status', 'active')
    .or(`title.ilike.%${searchQuery}%,summary.ilike.%${searchQuery}%`)
    .order('importance', { ascending: false })
    .limit(limit);
  
  if (category) query = query.eq('category', category);
  if (projectId) query = query.eq('project_id', projectId);
  
  const { data, error } = await query;
  if (error) throw error;
  
  return data || [];
}

/**
 * Get category statistics
 */
async function getCategoryStats(projectId = null) {
  let query = from('dev_knowledge')
    .select('category')
    .eq('status', 'active');
  
  if (projectId) query = query.eq('project_id', projectId);
  
  const { data, error } = await query;
  if (error) throw error;
  
  const stats = {
    decision: 0, lesson: 0, system: 0, procedure: 0,
    issue: 0, reference: 0, idea: 0, log: 0, total: 0
  };
  
  for (const item of (data || [])) {
    stats[item.category] = (stats[item.category] || 0) + 1;
    stats.total++;
  }
  
  return stats;
}

module.exports = {
  validateCategory,
  processKnowledgeItems,
  logCorrection,
  addTags,
  linkKnowledge,
  getUnlearnedCorrections,
  markCorrectionsLearned,
  getByCategory,
  searchKnowledge,
  getCategoryStats,
  CATEGORY_VALIDATORS
};

// ========================================
// REVIEW QUEUE - Ask when uncertain
// ========================================

const CONFIDENCE_THRESHOLD = 0.50;  // Below this, ask the user

/**
 * Queue an uncertain item for human review
 */
async function queueForReview(knowledgeId, item, validation) {
  const preview = `${item.title || ''}: ${(item.summary || '').substring(0, 100)}...`;
  
  const questionText = `I found this but I'm not sure how to categorize it:\n\n"${preview}"\n\nIs this a **${validation.finalCategory}** or a **${validation.alternateCategory || 'log'}**?`;
  
  try {
    const { data, error } = await from('dev_knowledge_review_queue').insert({
      knowledge_id: knowledgeId,
      question_type: 'category',
      question_text: questionText,
      option_a: validation.finalCategory,
      option_a_confidence: validation.confidence,
      option_b: validation.alternateCategory || 'log',
      option_b_confidence: validation.alternateConfidence || 0.30,
      content_preview: preview,
      suggested_by: 'susan',
      status: 'pending'
    }).select('id').single();
    
    if (error) throw error;
    
    logger.info('Queued for review', { 
      knowledgeId, 
      questionId: data.id,
      options: [validation.finalCategory, validation.alternateCategory]
    });
    
    return data.id;
  } catch (err) {
    logger.error('Failed to queue for review', { error: err.message });
    return null;
  }
}

/**
 * Get pending review questions for Susan to ask
 */
async function getPendingReviews(limit = 5) {
  const { data, error } = await from('dev_knowledge_review_queue')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);
  
  if (error) {
    logger.error('Failed to get pending reviews', { error: error.message });
    return [];
  }
  
  return data || [];
}

/**
 * Process user's answer to a review question
 */
async function processReviewAnswer(reviewId, answer, answeredBy = 'user') {
  // Get the review question
  const { data: review, error: fetchError } = await from('dev_knowledge_review_queue')
    .select('*')
    .eq('id', reviewId)
    .single();
  
  if (fetchError || !review) {
    logger.error('Review not found', { reviewId });
    return { success: false, error: 'Review not found' };
  }
  
  // Update the knowledge item with the correct category
  const { error: updateError } = await from('dev_knowledge')
    .update({
      category: answer,
      category_confidence: 0.95,  // User confirmed = high confidence
      category_suggested_by: answeredBy,
      status: 'active'  // No longer needs review
    })
    .eq('id', review.knowledge_id);
  
  if (updateError) {
    logger.error('Failed to update knowledge', { error: updateError.message });
    return { success: false, error: updateError.message };
  }
  
  // Mark review as answered
  await from('dev_knowledge_review_queue')
    .update({
      status: 'answered',
      answer: answer,
      answered_by: answeredBy,
      answered_at: new Date().toISOString()
    })
    .eq('id', reviewId);
  
  // Log correction for learning
  const originalCategory = review.option_a;
  if (answer !== originalCategory) {
    await logCorrection(
      review.knowledge_id,
      'category',
      originalCategory,
      answer,
      'user_review_correction'
    );
  }
  
  logger.info('Review answered', {
    reviewId,
    knowledgeId: review.knowledge_id,
    answer,
    wasCorrection: answer !== originalCategory
  });
  
  return { 
    success: true, 
    knowledgeId: review.knowledge_id,
    category: answer,
    wasCorrection: answer !== originalCategory
  };
}

/**
 * Format a review question for chat display
 */
function formatReviewQuestion(review) {
  return {
    id: review.id,
    type: 'category_question',
    message: review.question_text,
    options: [
      { label: review.option_a, value: review.option_a, confidence: review.option_a_confidence },
      { label: review.option_b, value: review.option_b, confidence: review.option_b_confidence },
      { label: 'Neither - it\'s something else', value: 'other' }
    ],
    preview: review.content_preview,
    createdAt: review.created_at
  };
}

/**
 * Check if there are pending questions Susan should ask
 */
async function hasPendingQuestions() {
  const { count, error } = await from('dev_knowledge_review_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');
  
  return !error && count > 0;
}

// Export new functions
module.exports.CONFIDENCE_THRESHOLD = CONFIDENCE_THRESHOLD;
module.exports.queueForReview = queueForReview;
module.exports.getPendingReviews = getPendingReviews;
module.exports.processReviewAnswer = processReviewAnswer;
module.exports.formatReviewQuestion = formatReviewQuestion;
module.exports.hasPendingQuestions = hasPendingQuestions;

/**
 * UPDATED: Process knowledge items - queues uncertain ones for review
 */
async function processKnowledgeItemsWithReview(items, context = {}) {
  const { sessionId, projectPath, clientId, projectId } = context;
  
  const results = {
    processed: 0,
    stored: 0,
    queued: 0,  // Items queued for human review
    overridden: 0,
    errors: 0,
    items: [],
    reviewQuestions: []  // Questions to ask the user
  };
  
  for (const item of items) {
    try {
      const validation = validateCategory(item);
      
      // Determine importance
      let importance = 'normal';
      if (validation.confidence >= 0.85) importance = 'high';
      if (item.sourceType === 'decision') importance = 'high';
      if (item.sourceType === 'issue' && item.issueStatus === 'unresolved') importance = 'high';
      
      // Store the item (might be pending review)
      const needsReview = validation.confidence < CONFIDENCE_THRESHOLD;
      
      const { data, error } = await from('dev_knowledge').insert({
        title: item.title || 'Untitled',
        summary: item.summary || '',
        full_content: item.fullContent || null,
        category: validation.finalCategory,
        category_confidence: validation.confidence,
        category_suggested_by: validation.reason === 'susan_override' ? 'susan' : 'chad',
        client_id: clientId || null,
        project_id: projectId || null,
        location_confidence: 0.70,
        importance: importance,
        status: needsReview ? 'needs_review' : 'active',
        confidence: validation.confidence >= 0.75 ? 'likely' : 'uncertain',
        scope: projectId ? 'project' : (clientId ? 'client' : 'global'),
        source_type: 'session',
        
        extracted_by: 'chad'
      }).select('id').single();
      
      if (error) {
        logger.error('Failed to store knowledge', { error: error.message });
        results.errors++;
        continue;
      }
      
      results.stored++;
      
      // Queue for review if uncertain
      if (needsReview) {
        const reviewId = await queueForReview(data.id, item, validation);
        if (reviewId) {
          results.queued++;
          results.reviewQuestions.push({
            reviewId,
            knowledgeId: data.id,
            title: item.title,
            options: [validation.finalCategory, validation.alternateCategory || 'log'],
            confidence: validation.confidence
          });
        }
      }
      
      // Log override correction
      if (validation.reason === 'susan_override') {
        results.overridden++;
        await logCorrection(data.id, 'category', validation.originalCategory, validation.finalCategory, 'susan_validation');
      }
      
      results.items.push({
        id: data.id,
        title: item.title,
        category: validation.finalCategory,
        confidence: validation.confidence,
        needsReview: needsReview
      });
      
      results.processed++;
    } catch (err) {
      logger.error('Error processing knowledge item', { error: err.message });
      results.errors++;
    }
  }
  
  logger.info('Knowledge processing complete', {
    processed: results.processed,
    stored: results.stored,
    queued: results.queued,
    overridden: results.overridden
  });
  
  return results;
}

module.exports.processKnowledgeItemsWithReview = processKnowledgeItemsWithReview;

// Import team chat for asking questions
const teamChat = require('./teamChat');

/**
 * UPDATED: Queue for review AND post to team chat
 */
async function queueForReviewWithChat(knowledgeId, item, validation) {
  // Post to team chat (visible to user)
  const chatId = await teamChat.askCategoryQuestion(
    knowledgeId,
    item.title || 'Untitled',
    item.summary || '',
    validation.finalCategory,
    validation.alternateCategory || 'log',
    validation.confidence
  );
  
  // Also track in review queue (for internal tracking)
  const preview = `${item.title || ''}: ${(item.summary || '').substring(0, 100)}...`;
  
  try {
    await from('dev_knowledge_review_queue').insert({
      knowledge_id: knowledgeId,
      question_type: 'category',
      question_text: `Is this a ${validation.finalCategory} or ${validation.alternateCategory || 'log'}?`,
      option_a: validation.finalCategory,
      option_a_confidence: validation.confidence,
      option_b: validation.alternateCategory || 'log',
      option_b_confidence: validation.alternateConfidence || 0.30,
      content_preview: preview,
      suggested_by: 'susan',
      status: 'pending'
    });
  } catch (err) {
    // Non-critical - chat question is what matters
    logger.warn('Failed to add to review queue', { error: err.message });
  }
  
  logger.info('Category question posted to team chat', { 
    knowledgeId, 
    chatId,
    options: [validation.finalCategory, validation.alternateCategory]
  });
  
  return chatId;
}

// Export updated function
module.exports.queueForReviewWithChat = queueForReviewWithChat;

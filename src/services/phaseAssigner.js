/**
 * Susan Phase Assigner
 * Assigns bugs/todos to the correct phase based on keywords
 * Matches item titles against phase item keywords
 */

const { from } = require('../../../shared/db');
const { Logger } = require('../lib/logger');
const duplicateChecker = require('./duplicateChecker');

const logger = new Logger('Susan:PhaseAssigner');

/**
 * Get all phases and phase items for a project
 */
async function getProjectPhases(projectId) {
  try {
    // Get phases for this project
    const { data: phases } = await from('dev_project_phases')
      .select('id, phase_num, name, status')
      .eq('parent_id', projectId)
      .order('phase_num', { ascending: true });
    
    if (!phases?.length) return [];
    
    // Get phase items for each phase
    const phasesWithItems = [];
    for (const phase of phases) {
      const { data: items } = await from('dev_phase_items')
        .select('id, title, status')
        .eq('phase_id', phase.id)
        .order('sort_order', { ascending: true });
      
      phasesWithItems.push({
        ...phase,
        items: items || [],
        keywords: extractPhaseKeywords(phase.name, items || [])
      });
    }
    
    return phasesWithItems;
  } catch (err) {
    logger.error('getProjectPhases failed', { projectId, error: err.message });
    return [];
  }
}

/**
 * Extract keywords from phase name and items
 */
function extractPhaseKeywords(phaseName, items) {
  const keywords = new Set();
  
  // Add keywords from phase name
  duplicateChecker.extractTerms(phaseName).forEach(t => keywords.add(t));
  
  // Add keywords from phase items
  items.forEach(item => {
    duplicateChecker.extractTerms(item.title).forEach(t => keywords.add(t));
  });
  
  return [...keywords];
}

/**
 * Calculate match score between an item and a phase
 * Higher score = better match
 */
function calculatePhaseMatch(itemTitle, phase) {
  const itemTerms = duplicateChecker.extractTerms(itemTitle);
  
  if (itemTerms.length === 0 || phase.keywords.length === 0) return 0;
  
  // Count matching keywords
  const matches = itemTerms.filter(t => phase.keywords.includes(t));
  
  // Score = percentage of item terms that match phase keywords
  return matches.length / itemTerms.length;
}

/**
 * Find best phase match for an item
 * @returns {object|null} { phaseId, phaseName, score } or null if no good match
 */
function findBestPhase(itemTitle, phases, minScore = 0.3) {
  let bestMatch = null;
  let bestScore = 0;
  
  for (const phase of phases) {
    const score = calculatePhaseMatch(itemTitle, phase);
    if (score > bestScore && score >= minScore) {
      bestScore = score;
      bestMatch = {
        phaseId: phase.id,
        phaseName: phase.name,
        phaseNum: phase.phase_num,
        score
      };
    }
  }
  
  return bestMatch;
}

/**
 * Assign unassigned items to phases for a project
 * @param {string} table - Table name (dev_ai_todos, dev_ai_bugs)
 * @param {string} projectId - Project ID (child project)
 * @param {string} parentId - Parent project ID (where phases are defined)
 */
async function assignPhases(table, projectId, parentId) {
  try {
    // Get phases for the parent project
    const phases = await getProjectPhases(parentId);
    
    if (phases.length === 0) {
      return { assigned: 0, skipped: 0, noPhases: true };
    }
    
    // Get unassigned items (no phase_id)
    const { data: items } = await from(table)
      .select('id, title, status')
      .eq('project_id', projectId)
      .is('phase_id', null)
      .in('status', ['unassigned', 'open', 'pending', 'active']);
    
    if (!items?.length) {
      return { assigned: 0, skipped: 0 };
    }
    
    let assigned = 0;
    let skipped = 0;
    
    for (const item of items) {
      const match = findBestPhase(item.title, phases);
      
      if (match) {
        // Assign to phase
        await from(table)
          .update({ 
            phase_id: match.phaseId,
            updated_at: new Date().toISOString()
          })
          .eq('id', item.id);
        
        assigned++;
        logger.info('Assigned item to phase', {
          table,
          itemId: item.id,
          title: item.title.substring(0, 50),
          phase: match.phaseName,
          score: match.score.toFixed(2)
        });
      } else {
        skipped++;
      }
    }
    
    return { assigned, skipped };
  } catch (err) {
    logger.error('assignPhases failed', { table, projectId, error: err.message });
    return { assigned: 0, skipped: 0, error: err.message };
  }
}

/**
 * Get parent project ID for a child project
 */
async function getParentId(projectId) {
  try {
    const { data } = await from('dev_projects')
      .select('parent_id, is_parent')
      .eq('id', projectId)
      .single();
    
    if (!data) return null;
    
    // If this is a parent project, return itself
    if (data.is_parent) return projectId;
    
    // Otherwise return its parent
    return data.parent_id;
  } catch (err) {
    return null;
  }
}

/**
 * Run phase assignment for all tables in a project
 */
async function assignAllPhases(projectId) {
  try {
    const parentId = await getParentId(projectId);
    
    if (!parentId) {
      return { todos: 0, bugs: 0, noParent: true };
    }
    
    const todosResult = await assignPhases('dev_ai_todos', projectId, parentId);
    const bugsResult = await assignPhases('dev_ai_bugs', projectId, parentId);
    
    return {
      todos: todosResult.assigned,
      bugs: bugsResult.assigned,
      parentId
    };
  } catch (err) {
    logger.error('assignAllPhases failed', { projectId, error: err.message });
    return { todos: 0, bugs: 0, error: err.message };
  }
}

module.exports = {
  getProjectPhases,
  findBestPhase,
  assignPhases,
  assignAllPhases,
  getParentId
};

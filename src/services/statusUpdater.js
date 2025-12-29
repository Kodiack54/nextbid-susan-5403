/**
 * Susan Status Updater
 * Detects completed items and updates their status
 * - Bugs marked FIXED when mentioned in sessions
 * - Todos marked COMPLETE when done
 * Uses keyword matching from Jen's extraction status
 */

const { from } = require('../../../shared/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:StatusUpdater');

/**
 * Check if Jen has marked an item as complete in journal
 * Jen writes status: 'complete' when she extracts completion mentions
 */
async function checkJenCompletions(projectId) {
  try {
    // Look for recent journal entries with completion indicators
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    const { data: completions } = await from('dev_ai_journal')
      .select('id, content, metadata, created_at')
      .eq('project_id', projectId)
      .gte('created_at', cutoff)
      .ilike('content', '%complete%');
    
    return completions || [];
  } catch (err) {
    logger.error('checkJenCompletions failed', { projectId, error: err.message });
    return [];
  }
}

/**
 * Mark a todo as completed
 */
async function completeTodo(todoId, reason = 'Auto-detected as complete') {
  try {
    await from('dev_ai_todos')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        completion_note: reason,
        updated_at: new Date().toISOString()
      })
      .eq('id', todoId);
    
    logger.info('Marked todo complete', { todoId, reason });
    return true;
  } catch (err) {
    logger.error('completeTodo failed', { todoId, error: err.message });
    return false;
  }
}

/**
 * Mark a bug as fixed/resolved
 */
async function fixBug(bugId, reason = 'Auto-detected as fixed') {
  try {
    await from('dev_ai_bugs')
      .update({
        status: 'resolved',
        resolved_at: new Date().toISOString(),
        resolution_note: reason,
        updated_at: new Date().toISOString()
      })
      .eq('id', bugId);
    
    logger.info('Marked bug fixed', { bugId, reason });
    return true;
  } catch (err) {
    logger.error('fixBug failed', { bugId, error: err.message });
    return false;
  }
}

/**
 * Match completion keywords against active items
 * Returns items that appear to be completed
 */
function findCompletedItems(items, completionKeywords) {
  const completed = [];
  
  for (const item of items) {
    const itemTerms = item.title.toLowerCase().split(/\s+/);
    
    for (const keyword of completionKeywords) {
      const keywordTerms = keyword.toLowerCase().split(/\s+/);
      const matches = keywordTerms.filter(kt => 
        itemTerms.some(it => it.includes(kt) || kt.includes(it))
      );
      
      // If more than 50% of keyword terms match item title
      if (matches.length >= keywordTerms.length * 0.5) {
        completed.push({
          item,
          matchedKeyword: keyword,
          matchScore: matches.length / keywordTerms.length
        });
        break;
      }
    }
  }
  
  return completed;
}

/**
 * Process items written by Jen with status 'complete'
 * Jen writes directly to tables with status already set
 */
async function processJenUpdates(table, projectId) {
  try {
    // Find items that Jen marked with done-related statuses
    // but are still in the working statuses
    const { data: items } = await from(table)
      .select('id, title, status, metadata')
      .eq('project_id', projectId)
      .in('status', ['done', 'fixed', 'resolved', 'complete']);
    
    if (!items?.length) return { updated: 0 };
    
    let updated = 0;
    
    for (const item of items) {
      // Normalize status
      const newStatus = table === 'dev_ai_bugs' ? 'resolved' : 'completed';
      
      if (item.status !== newStatus) {
        await from(table)
          .update({
            status: newStatus,
            updated_at: new Date().toISOString()
          })
          .eq('id', item.id);
        updated++;
      }
    }
    
    return { updated };
  } catch (err) {
    logger.error('processJenUpdates failed', { table, projectId, error: err.message });
    return { updated: 0, error: err.message };
  }
}

/**
 * Run status updates for a project
 */
async function updateStatuses(projectId) {
  try {
    const todoResult = await processJenUpdates('dev_ai_todos', projectId);
    const bugResult = await processJenUpdates('dev_ai_bugs', projectId);
    
    return {
      todosUpdated: todoResult.updated,
      bugsUpdated: bugResult.updated
    };
  } catch (err) {
    logger.error('updateStatuses failed', { projectId, error: err.message });
    return { todosUpdated: 0, bugsUpdated: 0, error: err.message };
  }
}

/**
 * Mark phase items complete when all related todos/bugs are done
 */
async function updatePhaseItemStatuses(parentId) {
  try {
    // Get all phase items for this parent project
    const { data: phases } = await from('dev_project_phases')
      .select('id')
      .eq('parent_id', parentId);
    
    if (!phases?.length) return { updated: 0 };
    
    let updated = 0;
    
    for (const phase of phases) {
      const { data: items } = await from('dev_phase_items')
        .select('id, title, status')
        .eq('phase_id', phase.id)
        .eq('status', 'pending');
      
      if (!items?.length) continue;
      
      for (const item of items) {
        // Check if all related bugs/todos are complete
        const { data: relatedTodos } = await from('dev_ai_todos')
          .select('id, status')
          .eq('phase_id', phase.id)
          .ilike('title', '%' + item.title.substring(0, 20) + '%');
        
        const { data: relatedBugs } = await from('dev_ai_bugs')
          .select('id, status')
          .eq('phase_id', phase.id)
          .ilike('title', '%' + item.title.substring(0, 20) + '%');
        
        const allItems = [...(relatedTodos || []), ...(relatedBugs || [])];
        
        if (allItems.length > 0) {
          const allComplete = allItems.every(i => 
            ['completed', 'resolved', 'done', 'fixed'].includes(i.status)
          );
          
          if (allComplete) {
            await from('dev_phase_items')
              .update({
                status: 'completed',
                completed_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              })
              .eq('id', item.id);
            
            updated++;
            logger.info('Marked phase item complete', { 
              phaseItemId: item.id, 
              title: item.title 
            });
          }
        }
      }
    }
    
    return { updated };
  } catch (err) {
    logger.error('updatePhaseItemStatuses failed', { parentId, error: err.message });
    return { updated: 0, error: err.message };
  }
}

module.exports = {
  completeTodo,
  fixBug,
  updateStatuses,
  updatePhaseItemStatuses,
  processJenUpdates,
  findCompletedItems
};

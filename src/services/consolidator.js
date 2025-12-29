/**
 * Susan Consolidator
 * Merges similar/duplicate items into one
 * "fix X" + "fix Y on dashboard" -> "fix X and Y on dashboard"
 */

const { from } = require('../../../shared/db');
const { Logger } = require('../lib/logger');
const duplicateChecker = require('./duplicateChecker');

const logger = new Logger('Susan:Consolidator');

/**
 * Merge multiple titles into one
 * "fix X on dashboard" + "fix Y on dashboard" -> "fix X and Y on dashboard"
 */
function mergeTitles(titles) {
  if (!titles || titles.length === 0) return '';
  if (titles.length === 1) return titles[0];
  
  // Find common prefix and suffix
  const sorted = [...titles].sort((a, b) => a.length - b.length);
  const shortest = sorted[0].toLowerCase();
  
  // Extract unique key terms from each title
  const allTerms = titles.map(t => duplicateChecker.extractTerms(t));
  const uniqueTerms = new Set();
  
  allTerms.forEach(terms => terms.forEach(t => uniqueTerms.add(t)));
  
  // Find common context words
  const termCounts = {};
  allTerms.forEach(terms => {
    terms.forEach(t => {
      termCounts[t] = (termCounts[t] || 0) + 1;
    });
  });
  
  const commonTerms = Object.entries(termCounts)
    .filter(([_, count]) => count === titles.length)
    .map(([term]) => term);
  
  const uniqueOnlyTerms = [...uniqueTerms].filter(t => !commonTerms.includes(t));
  
  // Build merged title
  if (commonTerms.length > 0 && uniqueOnlyTerms.length > 0) {
    // Pattern: "fix X, Y, and Z on dashboard"
    const prefix = commonTerms.slice(0, 1).join(' ');
    const suffix = commonTerms.slice(1).join(' ');
    const items = uniqueOnlyTerms.join(', ');
    
    if (suffix) {
      return `${prefix} ${items} ${suffix}`;
    }
    return `${prefix} ${items}`;
  }
  
  // Fallback: just join with " and "
  return titles.slice(0, -1).join(', ') + ' and ' + titles[titles.length - 1];
}

/**
 * Consolidate a group of similar items into one
 * Keeps the oldest item, marks others as 'consolidated'
 */
async function consolidateGroup(table, group) {
  if (!group || group.length < 2) return null;
  
  try {
    // Sort by created_at - keep the oldest as the master
    const sorted = [...group].sort((a, b) => 
      new Date(a.created_at) - new Date(b.created_at)
    );
    
    const master = sorted[0];
    const duplicates = sorted.slice(1);
    
    // Merge titles
    const mergedTitle = mergeTitles(group.map(g => g.title));
    
    // Update master with merged title
    await from(table)
      .update({ 
        title: mergedTitle,
        updated_at: new Date().toISOString()
      })
      .eq('id', master.id);
    
    // Mark duplicates as 'consolidated'
    for (const dup of duplicates) {
      await from(table)
        .update({ 
          status: 'consolidated',
          consolidated_into: master.id,
          updated_at: new Date().toISOString()
        })
        .eq('id', dup.id);
    }
    
    logger.info('Consolidated group', {
      table,
      masterId: master.id,
      duplicateCount: duplicates.length,
      mergedTitle
    });
    
    return {
      masterId: master.id,
      mergedTitle,
      duplicatesConsolidated: duplicates.length
    };
  } catch (err) {
    logger.error('consolidateGroup failed', { table, error: err.message });
    return null;
  }
}

/**
 * Run consolidation for a table and project
 */
async function consolidateTable(table, projectId) {
  try {
    const { groups } = await duplicateChecker.findDuplicates(table, projectId);
    
    if (groups.length === 0) {
      return { consolidated: 0, groups: 0 };
    }
    
    let totalConsolidated = 0;
    
    for (const group of groups) {
      const result = await consolidateGroup(table, group);
      if (result) {
        totalConsolidated += result.duplicatesConsolidated;
      }
    }
    
    return { consolidated: totalConsolidated, groups: groups.length };
  } catch (err) {
    logger.error('consolidateTable failed', { table, projectId, error: err.message });
    return { consolidated: 0, groups: 0, error: err.message };
  }
}

/**
 * Run consolidation across all projects for a table
 */
async function consolidateAll(table) {
  try {
    const { data: projects } = await from('dev_projects').select('id, name');
    
    if (!projects?.length) return { totalConsolidated: 0, projectsProcessed: 0 };
    
    let totalConsolidated = 0;
    let projectsProcessed = 0;
    
    for (const project of projects) {
      const result = await consolidateTable(table, project.id);
      totalConsolidated += result.consolidated;
      if (result.consolidated > 0) {
        projectsProcessed++;
      }
    }
    
    return { totalConsolidated, projectsProcessed };
  } catch (err) {
    logger.error('consolidateAll failed', { table, error: err.message });
    return { totalConsolidated: 0, projectsProcessed: 0, error: err.message };
  }
}

module.exports = {
  mergeTitles,
  consolidateGroup,
  consolidateTable,
  consolidateAll
};

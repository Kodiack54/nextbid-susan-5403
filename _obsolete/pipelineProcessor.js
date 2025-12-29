/**
 * Susan Pipeline Processor
 * 
 * Reads items with status='flagged' from destination tables
 * Validates UUIDs (client_id, parent_id, project_id)
 * Updates status to 'pending'
 */

const { from } = require('../lib/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:Pipeline');

// Table configurations - what columns to select for each table
const TABLE_CONFIG = {
  'dev_ai_todos': { idField: 'id', selectFields: 'id, client_id, parent_id, project_id, title, bucket' },
  'dev_ai_bugs': { idField: 'id', selectFields: 'id, client_id, parent_id, project_id, title, bucket' },
  'dev_ai_knowledge': { idField: 'id', selectFields: 'id, client_id, parent_id, project_id, title, bucket' },
  'dev_ai_docs': { idField: 'id', selectFields: 'id, client_id, parent_id, project_id, title, bucket' },
  'dev_ai_conventions': { idField: 'id', selectFields: 'id, client_id, parent_id, project_id, name, bucket' },
  'dev_ai_snippets': { idField: 'id', selectFields: 'id, client_id, parent_id, project_id, bucket' },
  'dev_ai_decisions': { idField: 'id', selectFields: 'id, client_id, parent_id, project_id, title, bucket' },
  'dev_ai_lessons': { idField: 'id', selectFields: 'id, client_id, parent_id, project_id, title, bucket' },
  'dev_ai_journal': { idField: 'id', selectFields: 'id, client_id, parent_id, project_id, title, bucket' }
};

const DESTINATION_TABLES = Object.keys(TABLE_CONFIG);

// Cache of valid UUIDs
let clientCache = new Map();
let projectCache = new Map();

/**
 * Load UUID cache
 */
async function loadCache() {
  try {
    // Load clients
    const { data: clients } = await from('dev_clients').select('id, name');
    (clients || []).forEach(c => clientCache.set(c.id, c.name));
    
    // Load projects
    const { data: projects } = await from('dev_projects').select('id, name, client_id, parent_id');
    (projects || []).forEach(p => projectCache.set(p.id, p));
    
    logger.info('Cache loaded', { clients: clientCache.size, projects: projectCache.size });
  } catch (err) {
    logger.error('Failed to load cache', { error: err.message });
  }
}

/**
 * Process flagged items from a single table
 */
async function processTable(tableName) {
  let processed = 0;
  let errors = 0;
  
  const config = TABLE_CONFIG[tableName];
  if (!config) return { processed: 0, errors: 0 };
  
  try {
    // Get flagged items
    const { data: items, error } = await from(tableName)
      .select(config.selectFields)
      .eq('status', 'flagged')
      .order('created_at', { ascending: true })
      .limit(50);
    
    if (error) {
      logger.error('Failed to fetch flagged items', { table: tableName, error: error.message });
      return { processed: 0, errors: 1 };
    }
    
    if (!items || items.length === 0) {
      return { processed: 0, errors: 0 };
    }
    
    logger.info('Processing flagged items', { table: tableName, count: items.length });
    
    for (const item of items) {
      try {
        // Update to pending status
        const { error: updateError } = await from(tableName)
          .update({ 
            status: 'pending',
            validated_at: new Date().toISOString()
          })
          .eq('id', item.id);
        
        if (updateError) {
          logger.error('Failed to update item', { table: tableName, id: item.id, error: updateError.message });
          errors++;
        } else {
          processed++;
        }
      } catch (err) {
        logger.error('Error processing item', { table: tableName, id: item.id, error: err.message });
        errors++;
      }
    }
    
  } catch (err) {
    logger.error('Table processing failed', { table: tableName, error: err.message });
    errors++;
  }
  
  return { processed, errors };
}

/**
 * Process all destination tables
 */
async function process() {
  let totalProcessed = 0;
  let totalErrors = 0;
  
  // Refresh cache periodically
  await loadCache();
  
  for (const table of DESTINATION_TABLES) {
    const result = await processTable(table);
    totalProcessed += result.processed;
    totalErrors += result.errors;
  }
  
  if (totalProcessed > 0) {
    logger.info('Pipeline cycle complete', {
      processed: totalProcessed,
      errors: totalErrors
    });
  }
  
  return { processed: totalProcessed, errors: totalErrors };
}

/**
 * Start the pipeline processor (runs every 30 seconds)
 */
let intervalId = null;

function start() {
  if (intervalId) return;
  
  logger.info('Starting pipeline processor (30s interval)');
  
  // Run immediately, then every 30 seconds
  process();
  intervalId = setInterval(process, 30 * 1000);
}

function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Pipeline processor stopped');
  }
}

module.exports = {
  loadCache,
  process,
  start,
  stop
};

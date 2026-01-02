/**
 * Extraction Sorter - Routes staging items to final tables
 * 
 * Consumes from dev_ai_smart_extractions (status='pending')
 * Routes to final tables based on bucket mapping
 * 
 * Staging status = workflow state: pending → processed | duplicate | error
 * Final table status = bucket semantics (open/fixed/unassigned/active/pending)
 * 
 * Runs every 5 minutes to process Jason's extracted items
 */

const db = require('../lib/db');

const CYCLE_MS = 5 * 60 * 1000; // 5 minutes

// Complete bucket → table mapping (20 buckets)
const BUCKET_CONFIG = {
  // Bugs
  'Bugs Open':           { table: 'dev_ai_bugs',        status: 'open' },
  'Bugs Fixed':          { table: 'dev_ai_bugs',        status: 'fixed' },
  
  // Todos
  'Todos':               { table: 'dev_ai_todos',       status: 'unassigned' },
  
  // Journal
  'Journal':             { table: 'dev_ai_journal',     status: 'pending' },
  'Work Log':            { table: 'dev_ai_journal',     status: 'pending' },
  
  // Decisions & Lessons
  'Decisions':           { table: 'dev_ai_decisions',   status: 'pending' },
  'Lessons':             { table: 'dev_ai_lessons',     status: 'pending' },
  
  // Docs
  'System Breakdown':    { table: 'dev_ai_docs',        status: 'pending' },
  'How-To Guide':        { table: 'dev_ai_docs',        status: 'pending' },
  'Schematic':           { table: 'dev_ai_docs',        status: 'pending' },
  'Reference':           { table: 'dev_ai_docs',        status: 'pending' },
  
  // Conventions (active)
  'Naming Conventions':  { table: 'dev_ai_conventions', status: 'active' },
  'File Structure':      { table: 'dev_ai_conventions', status: 'active' },
  'Database Patterns':   { table: 'dev_ai_conventions', status: 'active' },
  'API Patterns':        { table: 'dev_ai_conventions', status: 'active' },
  'Component Patterns':  { table: 'dev_ai_conventions', status: 'active' },
  
  // Knowledge
  'Ideas':               { table: 'dev_ai_knowledge',   status: 'pending' },
  'Quirks & Gotchas':    { table: 'dev_ai_knowledge',   status: 'pending' },
  'Other':               { table: 'dev_ai_knowledge',   status: 'pending' },
  
  // Snippets
  'Snippets':            { table: 'dev_ai_snippets',    status: 'pending' }
};

let intervalHandle = null;
let isProcessing = false;  // Prevent overlapping runs

function start() {
  console.log('[ExtractionSorter] Starting (5 min cycle)');
  processStagingItems().catch(err => console.error('[ExtractionSorter] Initial run error:', err));
  intervalHandle = setInterval(() => {
    processStagingItems().catch(err => console.error('[ExtractionSorter] Cycle error:', err));
  }, CYCLE_MS);
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[ExtractionSorter] Stopped');
  }
}

async function processStagingItems(limit = 50) {
  // Prevent overlapping runs (race guard)
  if (isProcessing) {
    console.log('[ExtractionSorter] Already processing, skipping this cycle');
    return { skipped: true };
  }
  isProcessing = true;

  const stats = { processed: 0, errors: 0, duplicates: 0, byTable: {} };

  try {
    const { data: items, error } = await db.from('dev_ai_smart_extractions')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) {
      console.error('[ExtractionSorter] Error fetching staging:', error.message);
      return stats;
    }

    if (!items || items.length === 0) return stats;

    console.log(`[ExtractionSorter] Processing ${items.length} pending items`);

    for (const item of items) {
      try {
        const config = BUCKET_CONFIG[item.bucket];
        if (!config) {
          await markStaging(item.id, 'error', {
            error: `Unknown bucket: ${item.bucket}`,
            error_stage: 'bucket_lookup',
            error_table: null
          });
          stats.errors++;
          continue;
        }

        // Dedupe check by hash
        if (item.hash) {
          const dupeResult = await checkDuplicate(config.table, item.hash);
          if (dupeResult.error) {
            await markStaging(item.id, 'error', {
              error: dupeResult.error,
              error_stage: 'dedupe',
              error_table: config.table
            });
            stats.errors++;
            continue;
          }
          if (dupeResult.isDupe) {
            await markStaging(item.id, 'duplicate');
            stats.duplicates++;
            continue;
          }
        }

        // Route to appropriate table
        const insertResult = await insertToTable(config.table, config.status, item);
        
        if (insertResult.success) {
          await markStaging(item.id, 'processed');
          stats.processed++;
          stats.byTable[config.table] = (stats.byTable[config.table] || 0) + 1;
        } else {
          await markStaging(item.id, 'error', {
            error: insertResult.error,
            error_stage: 'insert',
            error_table: config.table
          });
          stats.errors++;
        }

      } catch (err) {
        console.error(`[ExtractionSorter] Error processing ${item.id}:`, err.message);
        await markStaging(item.id, 'error', {
          error: err.message,
          error_stage: 'processing',
          error_table: null
        });
        stats.errors++;
      }
    }

    if (stats.processed > 0 || stats.duplicates > 0 || stats.errors > 0) {
      console.log(`[ExtractionSorter] Complete: ${stats.processed} processed, ${stats.duplicates} dupes, ${stats.errors} errors`, stats.byTable);
    }
    return stats;

  } catch (err) {
    console.error('[ExtractionSorter] Fatal error:', err.message);
    return stats;
  } finally {
    isProcessing = false;
  }
}

// Returns { isDupe: boolean, error: string|null }
// On query failure, skip dedupe rather than block insert (better to have dupe than lose data)
async function checkDuplicate(table, hash) {
  if (!hash) return { isDupe: false, error: null };
  
  try {
    // Dedupe is best-effort - if query fails, proceed with insert
    const { data, error } = await db.from(table)
      .select("id, metadata")
      .limit(100);
    
    if (error || !data) {
      return { isDupe: false, error: null };  // Skip dedupe on error
    }
    
    // Check in JS if hash matches
    const isDupe = data.some(row => row.metadata?.hash === hash);
    return { isDupe, error: null };
  } catch (err) {
    return { isDupe: false, error: null };  // Skip dedupe on error
  }
}

// Returns { success: boolean, error: string|null }
async function insertToTable(table, status, item) {
  const baseMetadata = {
    ...(item.metadata || {}),
    hash: item.hash,
    source: 'jason',
    staging_id: item.id
  };

  let payload;

  switch (table) {
    case 'dev_ai_todos':
      payload = {
        title: item.title || item.content?.substring(0, 200) || 'Untitled',
        description: item.content,
        status: status,
        priority: item.priority || 'medium',
        project_id: item.project_id,
        source_session_id: item.session_id,
        metadata: baseMetadata
      };
      break;

    case 'dev_ai_bugs':
      payload = {
        title: item.title || item.content?.substring(0, 200) || 'Untitled',
        description: item.content,
        status: status,
        severity: item.priority || 'medium',
        project_id: item.project_id,
        source_session_id: item.session_id,
        metadata: baseMetadata
      };
      break;

    case 'dev_ai_journal':
      payload = {
        title: item.title || item.content?.substring(0, 200) || 'Journal Entry',
        content: item.content || '',
        entry_type: item.bucket === 'Work Log' ? 'worklog' : 'journal',
        bucket: item.bucket,
        status: status,
        project_id: item.project_id,
        source_session_id: item.session_id,
        metadata: baseMetadata
      };
      break;

    case 'dev_ai_decisions':
      payload = {
        title: item.title || item.content?.substring(0, 200) || 'Decision',
        context: item.content,
        status: status,
        project_id: item.project_id,
        source_session_id: item.session_id,
        metadata: baseMetadata
      };
      break;

    case 'dev_ai_lessons':
      payload = {
        title: item.title || item.content?.substring(0, 200) || 'Lesson Learned',
        description: item.content,
        status: status,
        project_id: item.project_id,
        source_session_id: item.session_id,
        metadata: baseMetadata
      };
      break;

    case 'dev_ai_docs':
      payload = {
        title: item.title || item.content?.substring(0, 200) || 'Document',
        content: item.content,
        doc_type: item.bucket?.toLowerCase().replace(/\s+/g, '_') || 'reference',
        bucket: item.bucket,
        status: status,
        project_id: item.project_id,
        source_session_id: item.session_id,
        metadata: baseMetadata
      };
      break;

    case 'dev_ai_conventions':
      payload = {
        name: item.title || item.content?.substring(0, 200) || 'Convention',
        description: item.content,
        convention_type: item.bucket?.toLowerCase().replace(/\s+/g, '_') || 'general',
        bucket: item.bucket,
        status: status,
        project_id: item.project_id,
        source_session_id: item.session_id,
        metadata: baseMetadata
      };
      break;

    case 'dev_ai_knowledge':
      payload = {
        title: item.title || item.content?.substring(0, 200) || 'Knowledge Item',
        content: item.content,
        summary: item.content?.substring(0, 500),
        knowledge_type: item.bucket?.toLowerCase().replace(/\s+/g, '_') || 'general',
        bucket: item.bucket,
        status: status,
        project_id: item.project_id,
        source_session_id: item.session_id,
        metadata: baseMetadata
      };
      break;

    case 'dev_ai_snippets':
      payload = {
        content: item.content || '',
        context: item.title || 'Extracted snippet',
        snippet_type: 'extracted',
        bucket: item.bucket,
        status: status,
        project_id: item.project_id,
        source_session_id: item.session_id,
        metadata: baseMetadata
      };
      break;

    default:
      return { success: false, error: `No handler for table: ${table}` };
  }

  const { error } = await db.from(table).insert(payload);
  if (error) {
    console.error(`[ExtractionSorter] Insert error (${table}):`, error.message);
    return { success: false, error: error.message };
  }
  return { success: true, error: null };
}

// Mark staging row with status and optional error details
async function markStaging(id, status, errorDetails = null) {
  const update = { 
    status: status, 
    updated_at: new Date().toISOString() 
  };
  
  // If error, append to metadata for audit trail (never delete, only append)
  if (errorDetails && status === 'error') {
    const { data } = await db.from('dev_ai_smart_extractions')
      .select('metadata')
      .eq('id', id)
      .single();
    
    const currentMeta = data?.metadata || {};
    update.metadata = {
      ...currentMeta,
      error: String(errorDetails.error || '').substring(0, 500),
      error_stage: errorDetails.error_stage || 'unknown',
      error_table: errorDetails.error_table || null,
      error_at: new Date().toISOString()
    };
  }
  
  await db.from('dev_ai_smart_extractions')
    .update(update)
    .eq('id', id);
}

module.exports = { start, stop, processStagingItems };

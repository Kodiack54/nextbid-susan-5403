/**
 * Susan Validator - Validate flagged items and move to pending
 * 
 * PIPELINE STAGE 3: SUSAN
 * - Input: Items with status='flagged' from 6 destination tables
 * - Validates: client_id, parent_id, project_id exist in DB
 * - Output: Same items with status='pending'
 */

const supabase = require('../../../shared/db');

// The 6 destination tables + 3 more
const DESTINATION_TABLES = [
  'dev_ai_todos',
  'dev_ai_bugs',
  'dev_ai_knowledge',
  'dev_ai_docs',
  'dev_ai_conventions',
  'dev_ai_snippets',
  'dev_ai_decisions',
  'dev_ai_lessons',
  'dev_ai_journal'
];

// Cache for validation lookups
let validationCache = {
  clients: new Set(),
  projects: new Map(), // project_id -> { client_id, parent_id }
  expiry: 0
};

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Load validation cache from DB
 */
async function loadCache() {
  const now = Date.now();
  if (validationCache.expiry > now) return;

  try {
    // Load all clients
    const { data: clients } = await supabase.from('dev_clients').select('id');
    validationCache.clients = new Set((clients || []).map(c => c.id));

    // Load all projects with their relationships
    const { data: projects } = await supabase.from('dev_projects')
      .select('id, client_id, parent_id');
    
    validationCache.projects = new Map();
    for (const p of projects || []) {
      validationCache.projects.set(p.id, {
        client_id: p.client_id,
        parent_id: p.parent_id
      });
    }

    validationCache.expiry = now + CACHE_TTL;
    console.log('[Susan:Validator] Cache loaded:', validationCache.clients.size, 'clients,', validationCache.projects.size, 'projects');
  } catch (err) {
    console.error('[Susan:Validator] Cache load failed:', err.message);
  }
}

/**
 * Validate a single item's UUIDs
 * Returns { valid: boolean, corrections: {} }
 */
function validateItem(item) {
  const result = { valid: true, corrections: {} };

  // Check client_id exists
  if (item.client_id && !validationCache.clients.has(item.client_id)) {
    console.log('[Susan:Validator] Invalid client_id:', item.client_id);
    result.valid = false;
    result.corrections.client_id = null;
  }

  // Check project_id exists and get its relationships
  if (item.project_id) {
    const project = validationCache.projects.get(item.project_id);
    if (!project) {
      console.log('[Susan:Validator] Invalid project_id:', item.project_id);
      result.valid = false;
      result.corrections.project_id = null;
    } else {
      // Auto-fill parent_id from project if not set
      if (!item.parent_id && project.parent_id) {
        result.corrections.parent_id = project.parent_id;
      }
      // Auto-fill client_id from project if not set
      if (!item.client_id && project.client_id) {
        result.corrections.client_id = project.client_id;
      }
    }
  }

  return result;
}

/**
 * Process all flagged items in a table
 */
async function processTable(tableName) {
  let validated = 0;
  let errors = 0;

  try {
    // Get all flagged items
    const { data: items, error } = await supabase.from(tableName)
      .select('id, client_id, parent_id, project_id')
      .eq('status', 'flagged')
      .limit(100);

    if (error) throw error;
    if (!items || items.length === 0) return { validated: 0, errors: 0 };

    for (const item of items) {
      try {
        const validation = validateItem(item);

        // Build update object
        const update = {
          status: 'pending',
          validated_at: new Date().toISOString()
        };

        // Apply any corrections
        if (Object.keys(validation.corrections).length > 0) {
          Object.assign(update, validation.corrections);
        }

        // Update the item
        const { error: updateError } = await supabase.from(tableName)
          .update(update)
          .eq('id', item.id);

        if (updateError) throw updateError;
        validated++;

      } catch (err) {
        console.error('[Susan:Validator] Item update failed:', err.message);
        errors++;
      }
    }

  } catch (err) {
    console.error('[Susan:Validator] Table process failed:', tableName, err.message);
    errors++;
  }

  return { validated, errors };
}

/**
 * Main validation process - runs through all tables
 */
async function process() {
  await loadCache();

  let totalValidated = 0;
  let totalErrors = 0;

  console.log('[Susan:Validator] Starting validation cycle...');

  for (const table of DESTINATION_TABLES) {
    const result = await processTable(table);
    totalValidated += result.validated;
    totalErrors += result.errors;
    
    if (result.validated > 0) {
      console.log('[Susan:Validator]', table, ':', result.validated, 'validated');
    }
  }

  console.log('[Susan:Validator] Complete:', totalValidated, 'validated,', totalErrors, 'errors');
  return { validated: totalValidated, errors: totalErrors };
}

module.exports = {
  loadCache,
  process,
  processTable,
  validateItem
};

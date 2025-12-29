/**
 * Extraction Sorter - Processes pending extractions from Chad/Jen
 * Sorts items into proper destination tables
 * FIXED: Uses projectDetector.project_id directly instead of broken path lookup
 * FIXED: Added duplicate detection before inserting
 */

const { from, query } = require('../lib/db');
const { Logger } = require('../lib/logger');
const projectDetector = require('./projectDetector');
const stripAnsi = require('../../shared/stripAnsi');

const logger = new Logger('Sorter');

// NEW 20-bucket format mapping
const BUCKET_TO_TABLE = {
  'Bugs Open': 'dev_ai_bugs',
  'Bugs Fixed': 'dev_ai_bugs',
  'Todos': 'dev_ai_todos',
  'Journal': 'dev_ai_journal',
  'Work Log': 'dev_ai_journal',
  'Ideas': 'dev_ai_knowledge',
  'Decisions': 'dev_ai_decisions',
  'Lessons': 'dev_ai_lessons',
  'System Breakdown': 'dev_ai_docs',
  'How-To Guide': 'dev_ai_docs',
  'Schematic': 'dev_ai_docs',
  'Reference': 'dev_ai_docs',
  'Naming Conventions': 'dev_ai_conventions',
  'File Structure': 'dev_ai_conventions',
  'Database Patterns': 'dev_ai_conventions',
  'API Patterns': 'dev_ai_conventions',
  'Component Patterns': 'dev_ai_conventions',
  'Quirks & Gotchas': 'dev_ai_knowledge',
  'Snippets': 'dev_ai_snippets',
  'Other': 'dev_ai_knowledge'
};

// Legacy category mapping
const CATEGORY_TO_TABLE = {
  todo: 'dev_ai_todos',
  bug: 'dev_ai_bugs',
  issue: 'dev_ai_bugs',
  knowledge: 'dev_ai_knowledge',
  solution: 'dev_ai_knowledge',
  config: 'dev_ai_knowledge',
  infrastructure: 'dev_ai_knowledge',
  decision: 'dev_ai_decisions',
  lesson: 'dev_ai_lessons',
  general: 'dev_ai_knowledge',
  discovery: 'dev_ai_knowledge'
};

// Garbage patterns to filter
const GARBAGE_PATTERNS = [
  /^\|/,
  /^\(\d+\)/,
  /^- MMO/,
  /^be saved by/,
  /^GET\s+\/api/,
  /\[.*m$/,
  /^'\w+_ai/,
  /\\x1B/,
  /\\u001b/i,
];

function isGarbage(text) {
  if (!text || text.length < 10) return true;
  if (text.length > 5000) return true;
  return GARBAGE_PATTERNS.some(p => p.test(text));
}

// ============ DUPLICATE DETECTION ============

/**
 * Check if similar content already exists in a table
 * Uses title matching (first 100 chars) to detect duplicates
 */
async function isDuplicate(table, title, projectId) {
  if (!title) return false;

  const shortTitle = title.substring(0, 100);

  try {
    // Check for exact title match in same project
    let q = from(table).select('id').ilike('title', shortTitle + '%').limit(1);

    // If we have project_id, scope to that project
    if (projectId) {
      q = q.eq('project_id', projectId);
    }

    const { data } = await q;

    if (data && data.length > 0) {
      logger.info('Duplicate detected, skipping', { table, title: shortTitle.substring(0, 50) });
      return true;
    }
    return false;
  } catch (err) {
    // If check fails, allow insert (better to have dupe than lose data)
    return false;
  }
}

/**
 * Check for duplicate in tables that use 'name' instead of 'title'
 */
async function isDuplicateByName(table, name, projectId) {
  if (!name) return false;

  const shortName = name.substring(0, 100);

  try {
    let q = from(table).select('id').ilike('name', shortName + '%').limit(1);

    if (projectId) {
      q = q.eq('project_id', projectId);
    }

    const { data } = await q;
    return data && data.length > 0;
  } catch {
    return false;
  }
}

/**
 * Check for duplicate in tables that use 'content' for matching
 */
async function isDuplicateByContent(table, content, projectId) {
  if (!content) return false;

  // Use first 150 chars of content for matching
  const contentStart = content.substring(0, 150);

  try {
    let q = from(table).select('id').ilike('content', contentStart + '%').limit(1);

    if (projectId) {
      q = q.eq('project_id', projectId);
    }

    const { data } = await q;

    if (data && data.length > 0) {
      logger.info('Duplicate content detected, skipping', { table });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ============ MAIN PROCESSING ============

async function processPendingExtractions() {
  try {
    const { data: pending, error } = await from('dev_ai_smart_extractions')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(50);

    if (error) {
      logger.error('Error fetching pending extractions', { error: error.message });
      return { processed: 0, errors: 1 };
    }

    if (!pending || pending.length === 0) {
      return { processed: 0, errors: 0 };
    }

    logger.info('[Sorter] Processing ' + pending.length + ' pending extractions');

    let processed = 0;
    let errors = 0;
    let skipped = 0;

    for (const extraction of pending) {
      try {
        const cleanContent = stripAnsi(extraction.content || '');

        if (isGarbage(cleanContent)) {
          await from('dev_ai_smart_extractions')
            .update({ status: 'skipped' })
            .eq('id', extraction.id);
          skipped++;
          continue;
        }

        extraction.content = cleanContent;
        const result = await sortExtraction(extraction);
        if (result.success) {
          processed++;
        } else if (result.duplicate) {
          skipped++;
        } else {
          errors++;
        }
      } catch (err) {
        logger.error('Error processing extraction', { id: extraction.id, error: err.message });
        errors++;
      }
    }

    logger.info('[Sorter] Processed ' + processed + ', skipped ' + skipped + ', errors ' + errors);
    return { processed, errors, skipped };
  } catch (err) {
    logger.error('Error in processPendingExtractions', { error: err.message });
    return { processed: 0, errors: 1 };
  }
}

async function sortExtraction(extraction) {
  const { id, category, bucket, content, project_id, priority, metadata, session_id } = extraction;

  // FIXED: Detect project from CONTENT first - this gives us project_id directly!
  // This works even when project_id is a Windows path that wont match dev_project_ids
  let detected = null;
  if (content) {
    detected = await projectDetector.detectProject(content);
    logger.info('Project detected from content', {
      project_name: detected?.project_name,
      project_id: detected?.project_id,
      confidence: detected?.confidence,
      reason: detected?.reason
    });
  }

  // Use detected server_path, or fall back to extractions project_id
  const finalProjectPath = detected?.server_path || project_id;

  // Determine target table
  let targetTable;
  let usedBucket = bucket;

  if (bucket && BUCKET_TO_TABLE[bucket]) {
    targetTable = BUCKET_TO_TABLE[bucket];
  } else {
    targetTable = CATEGORY_TO_TABLE[category] || 'dev_ai_knowledge';
  }

  try {
    // FIXED: Pass detected project info (includes project_id!) to insert functions
    let inserted = false;

    if (targetTable === 'dev_ai_todos') {
      inserted = await insertTodo(extraction, finalProjectPath, detected);
    } else if (targetTable === 'dev_ai_bugs') {
      inserted = await insertBug(extraction, finalProjectPath, usedBucket, detected);
    } else if (targetTable === 'dev_ai_knowledge') {
      inserted = await insertKnowledge(extraction, finalProjectPath, usedBucket, detected);
    } else if (targetTable === 'dev_ai_decisions') {
      inserted = await insertDecision(extraction, finalProjectPath, detected);
    } else if (targetTable === 'dev_ai_lessons') {
      inserted = await insertLesson(extraction, finalProjectPath, detected);
    } else if (targetTable === 'dev_ai_journal') {
      inserted = await insertJournal(extraction, finalProjectPath, usedBucket, detected);
    } else if (targetTable === 'dev_ai_docs') {
      inserted = await insertDoc(extraction, finalProjectPath, usedBucket, detected);
    } else if (targetTable === 'dev_ai_conventions') {
      inserted = await insertConvention(extraction, finalProjectPath, usedBucket, detected);
    } else if (targetTable === 'dev_ai_snippets') {
      inserted = await insertSnippet(extraction, finalProjectPath, detected);
    } else {
      inserted = await insertKnowledge(extraction, finalProjectPath, usedBucket, detected);
    }

    // Mark as processed (or skipped if duplicate)
    await from('dev_ai_smart_extractions')
      .update({
        status: inserted ? 'processed' : 'duplicate',
        processed_at: new Date().toISOString()
      })
      .eq('id', id);

    return { success: inserted, duplicate: !inserted };
  } catch (err) {
    logger.error('Error sorting extraction', { id, bucket, category, error: err.message });

    await from('dev_ai_smart_extractions')
      .update({ status: 'failed', metadata: { ...(metadata || {}), error: err.message } })
      .eq('id', id);

    return { success: false, error: err.message };
  }
}

// ============ INSERT FUNCTIONS (with duplicate checking) ============

async function insertTodo(extraction, projectPath, detected) {
  const { content, priority, session_id } = extraction;
  const title = content.substring(0, 200).split('\n')[0];

  // Check for duplicate
  if (await isDuplicate('dev_ai_todos', title, detected?.project_id)) {
    return false;
  }

  await from('dev_ai_todos').insert({
    project_id: projectPath || '/var/www/Studio',
    title: title,
    description: content,
    priority: mapPriority(priority),
    status: 'pending',
    source_session_id: session_id,
    client_id: detected?.client_id || null,
    project_id: detected?.project_id || null
  });

  return true;
}

async function insertBug(extraction, projectPath, bucket, detected) {
  const { content, priority, session_id } = extraction;
  const title = content.substring(0, 200).split('\n')[0];
  const status = bucket === 'Bugs Fixed' ? 'fixed' : 'open';

  // Check for duplicate
  if (await isDuplicate('dev_ai_bugs', title, detected?.project_id)) {
    return false;
  }

  await from('dev_ai_bugs').insert({
    project_id: projectPath,
    title: title,
    description: content,
    severity: mapPriority(priority),
    status: status,
    source_session_id: session_id,
    client_id: detected?.client_id || null,
    project_id: detected?.project_id || null
  });

  return true;
}

async function insertKnowledge(extraction, projectPath, bucket, detected) {
  const { content, category, session_id } = extraction;
  const title = content.substring(0, 200).split('\n')[0];
  const knowledgeCategory = bucket || category || 'general';

  // Check for duplicate
  if (await isDuplicate('dev_ai_knowledge', title, detected?.project_id)) {
    return false;
  }

  await from('dev_ai_knowledge').insert({
    project_id: projectPath,
    title: title,
    content: content,
    category: knowledgeCategory,
    source_session_id: session_id,
    client_id: detected?.client_id || null,
    project_id: detected?.project_id || null
  });

  return true;
}

async function insertDecision(extraction, projectPath, detected) {
  const { content, session_id } = extraction;
  const title = content.substring(0, 200).split('\n')[0];

  // Check for duplicate
  if (await isDuplicate('dev_ai_decisions', title, detected?.project_id)) {
    return false;
  }

  await from('dev_ai_decisions').insert({
    project_id: projectPath,
    title: title,
    description: content,
    status: 'decided',
    session_id: session_id,
    client_id: detected?.client_id || null,
    project_id: detected?.project_id || null
  });

  return true;
}

async function insertLesson(extraction, projectPath, detected) {
  const { content, session_id } = extraction;
  const title = content.substring(0, 200).split('\n')[0];

  // Check for duplicate
  if (await isDuplicate('dev_ai_lessons', title, detected?.project_id)) {
    return false;
  }

  await from('dev_ai_lessons').insert({
    project_id: projectPath,
    title: title,
    description: content,
    client_id: detected?.client_id || null,
    project_id: detected?.project_id || null
  });

  return true;
}

async function insertJournal(extraction, projectPath, bucket, detected) {
  const { content, session_id } = extraction;
  const title = content.substring(0, 200).split('\n')[0];
  const entryType = bucket === 'Work Log' ? 'work_log' : 'journal';

  // Check for duplicate by content (journals may have similar titles)
  if (await isDuplicateByContent('dev_ai_journal', content, detected?.project_id)) {
    return false;
  }

  await from('dev_ai_journal').insert({
    project_id: projectPath,
    title: title,
    content: content,
    entry_type: entryType,
    client_id: detected?.client_id || null,
    project_id: detected?.project_id || null
  });

  return true;
}

async function insertDoc(extraction, projectPath, bucket, detected) {
  const { content, session_id } = extraction;
  const title = content.substring(0, 200).split('\n')[0];
  const docTypeMap = { 'System Breakdown': 'breakdown', 'How-To Guide': 'howto', 'Schematic': 'schematic', 'Reference': 'reference' };
  const docType = docTypeMap[bucket] || 'reference';

  // Check for duplicate
  if (await isDuplicate('dev_ai_docs', title, detected?.project_id)) {
    return false;
  }

  await from('dev_ai_docs').insert({
    project_id: projectPath,
    title: title,
    content: content,
    doc_type: docType,
    client_id: detected?.client_id || null,
    project_id: detected?.project_id || null
  });

  return true;
}

async function insertConvention(extraction, projectPath, bucket, detected) {
  const { content, session_id } = extraction;
  const title = content.substring(0, 200).split('\n')[0];
  const conventionTypeMap = {
    'Naming Conventions': 'naming',
    'File Structure': 'structure',
    'Database Patterns': 'database',
    'API Patterns': 'api',
    'Component Patterns': 'component',
    'Quirks & Gotchas': 'quirk'
  };
  const conventionType = conventionTypeMap[bucket] || 'naming';

  // Check for duplicate by name
  if (await isDuplicateByName('dev_ai_conventions', title, detected?.project_id)) {
    return false;
  }

  await from('dev_ai_conventions').insert({
    project_id: projectPath,
    name: title,
    description: content,
    convention_type: conventionType,
    client_id: detected?.client_id || null,
    project_id: detected?.project_id || null
  });

  return true;
}

async function insertSnippet(extraction, projectPath, detected) {
  const { content, session_id } = extraction;
  const title = content.substring(0, 200).split('\n')[0];

  // Check for duplicate by content
  if (await isDuplicateByContent('dev_ai_snippets', content, detected?.project_id)) {
    return false;
  }

  await from('dev_ai_snippets').insert({
    snippet_type: 'extracted',
    project_id: projectPath,
    content: content,
    session_id: session_id,
    client_id: detected?.client_id || null,
    project_id: detected?.project_id || null
  });

  return true;
}

// ============ HELPERS ============

function mapPriority(priority) {
  const map = { low: 'low', normal: 'medium', high: 'high', critical: 'critical' };
  return map[priority] || 'medium';
}

// ============ SORTER LIFECYCLE ============

let sortInterval = null;

function startSorter() {
  if (sortInterval) return;

  logger.info('[Sorter] Starting extraction sorter (30s interval)');
  processPendingExtractions();
  sortInterval = setInterval(processPendingExtractions, 30000);
}

function stopSorter() {
  if (sortInterval) {
    clearInterval(sortInterval);
    sortInterval = null;
    logger.info('[Sorter] Stopped extraction sorter');
  }
}

module.exports = {
  processPendingExtractions,
  sortExtraction,
  startSorter,
  stopSorter,
  BUCKET_TO_TABLE,
  CATEGORY_TO_TABLE
};

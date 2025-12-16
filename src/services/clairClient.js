/**
 * Susan's Clair Client
 * Forwards journal-worthy content to Clair's tables
 *
 * When Susan extracts knowledge, she also checks if it should
 * go to Clair's journal (work_log, idea, decision, lesson)
 */

const { from } = require('../lib/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:ClairClient');

// Map Susan's knowledge categories to Clair's journal types
const CATEGORY_TO_JOURNAL_TYPE = {
  'architecture': 'decision',
  'decision': 'decision',
  'bug-fix': 'lesson',
  'explanation': 'lesson',
  'feature': 'idea',
  'config': 'decision',
  'database': 'decision'
};

/**
 * Add a journal entry to Clair's dev_ai_journal table
 */
async function addJournalEntry(projectPath, entryType, title, content, createdBy = 'susan') {
  try {
    const { data, error } = await from('dev_ai_journal').insert({
      project_path: projectPath,
      entry_type: entryType,
      title,
      content,
      created_by: createdBy
    }).select().single();

    if (error) throw error;

    logger.info('Journal entry added for Clair', {
      entryType,
      title: title.slice(0, 50),
      projectPath
    });

    return data;
  } catch (err) {
    logger.error('Failed to add journal entry', { error: err.message });
    return null;
  }
}

/**
 * Log a work session summary to Clair's journal
 */
async function logWorkSession(projectPath, summary, sessionId) {
  const title = `Session ${new Date().toISOString().split('T')[0]}`;
  return addJournalEntry(
    projectPath,
    'work_log',
    title,
    summary,
    'chad'
  );
}

/**
 * Forward knowledge to Clair's journal if appropriate
 * Returns true if it was forwarded
 */
async function forwardKnowledgeToJournal(projectPath, knowledge) {
  const journalType = CATEGORY_TO_JOURNAL_TYPE[knowledge.category];

  if (!journalType) {
    // Not a journal-worthy category
    return false;
  }

  // Only forward high-importance items
  if (knowledge.importance < 6) {
    return false;
  }

  await addJournalEntry(
    projectPath,
    journalType,
    knowledge.title,
    knowledge.summary,
    'susan'
  );

  return true;
}

/**
 * Add a coding convention to Clair's conventions table
 */
async function addConvention(projectPath, category, pattern, example = null, notes = null) {
  try {
    const { data, error } = await from('dev_ai_conventions').insert({
      project_path: projectPath,
      category,
      pattern,
      example,
      notes
    }).select().single();

    if (error) throw error;

    logger.info('Convention added for Clair', {
      category,
      pattern: pattern.slice(0, 50)
    });

    return data;
  } catch (err) {
    logger.error('Failed to add convention', { error: err.message });
    return null;
  }
}

/**
 * Add a folder description for Clair's structure
 */
async function addFolderDescription(projectPath, folderPath, description) {
  try {
    const { data, error } = await from('dev_ai_folder_descriptions')
      .upsert({
        project_path: projectPath,
        folder_path: folderPath,
        description,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'project_path,folder_path'
      })
      .select()
      .single();

    if (error) throw error;

    logger.info('Folder description added for Clair', {
      folderPath
    });

    return data;
  } catch (err) {
    logger.error('Failed to add folder description', { error: err.message });
    return null;
  }
}

/**
 * Record an idea in Clair's journal
 */
async function recordIdea(projectPath, title, content) {
  return addJournalEntry(projectPath, 'idea', title, content, 'susan');
}

/**
 * Record a decision in Clair's journal
 */
async function recordDecision(projectPath, title, content) {
  return addJournalEntry(projectPath, 'decision', title, content, 'susan');
}

/**
 * Record a lesson learned in Clair's journal
 */
async function recordLesson(projectPath, title, content) {
  return addJournalEntry(projectPath, 'lesson', title, content, 'susan');
}

module.exports = {
  addJournalEntry,
  logWorkSession,
  forwardKnowledgeToJournal,
  addConvention,
  addFolderDescription,
  recordIdea,
  recordDecision,
  recordLesson
};

/**
 * Susan Session Archiver
 *
 * Pipeline: extracted (48h) → cleaned → archived
 *
 * 1. After 48h in 'extracted', clean the session (strip code/spam)
 * 2. Save cleaned conversation to dev_session_summaries
 * 3. Mark session as 'cleaned'
 * 4. After another 24h, mark as 'archived'
 */

const { from } = require('../../../shared/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:Archiver');

// Timing configuration
const PROCESS_TO_CLEAN_HOURS = 48;  // Wait 48h after processed before cleaning
const CLEAN_TO_ARCHIVE_HOURS = 24;  // Wait 24h after cleaned before archiving
const BATCH_SIZE = 20;

let isRunning = false;

/**
 * Start the archiver service
 */
function start(intervalMs = 60 * 60 * 1000) {  // Default: every hour
  logger.info('Archiver service started', {
    intervalMs,
    processToClean: `${PROCESS_TO_CLEAN_HOURS}h`,
    cleanToArchive: `${CLEAN_TO_ARCHIVE_HOURS}h`
  });

  // Run immediately then on interval
  setTimeout(runCycle, 10000);
  setInterval(runCycle, intervalMs);
}

/**
 * Run a single archiver cycle
 */
async function runCycle() {
  if (isRunning) {
    logger.debug('Archiver already running, skipping');
    return;
  }

  isRunning = true;
  const stats = { cleaned: 0, archived: 0, errors: 0 };

  try {
    // Step 1: Clean sessions that have been processed for 48h+
    stats.cleaned = await cleanProcessedSessions();

    // Step 2: Archive sessions that have been cleaned for 24h+
    stats.archived = await archiveCleanedSessions();

    if (stats.cleaned > 0 || stats.archived > 0) {
      logger.info('Archiver cycle complete', stats);
    }
  } catch (err) {
    logger.error('Archiver cycle failed', { error: err.message });
    stats.errors++;
  } finally {
    isRunning = false;
  }

  return stats;
}

/**
 * Find sessions processed 48h+ ago, clean them, save to summaries
 */
async function cleanProcessedSessions() {
  const cutoff = new Date(Date.now() - PROCESS_TO_CLEAN_HOURS * 60 * 60 * 1000).toISOString();

  try {
    // Find processed sessions older than 48h
    const { data: sessions, error } = await from('dev_ai_sessions')
      .select('id, project_id, raw_content, started_at, semantic_extracted_at')
      .eq('status', 'extracted')
      .lt('semantic_extracted_at', cutoff)
      .order('processed_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error) {
      logger.error('Failed to fetch processed sessions', { error: error.message });
      return 0;
    }

    if (!sessions || sessions.length === 0) {
      return 0;
    }

    logger.info('Found sessions to clean', { count: sessions.length });

    let cleaned = 0;
    for (const session of sessions) {
      try {
        // Clean the raw content
        const cleanedContent = cleanRawContent(session.raw_content || '');

        // Extract key information for summary
        const summary = extractSummary(cleanedContent, session);

        // Save to dev_session_summaries
        // Note: The FK references dev_chat_sessions, but we're using dev_ai_sessions
        // We'll store the summary with session_id = null and reference in summary text
        const { error: summaryError } = await from('dev_session_summaries')
          .insert({
            session_id: null,  // FK constraint to different table
            summary: `[AI Session ${session.id}]\n\n${summary.text}`,
            key_topics: summary.topics,
            decisions_made: summary.decisions,
            action_items: summary.actions
          });

        if (summaryError) {
          logger.warn('Failed to create summary', { sessionId: session.id, error: summaryError.message });
          // Continue anyway - still mark as cleaned
        }

        // Update session status to 'cleaned'
        await from('dev_ai_sessions')
          .update({
            status: 'cleaned',
            raw_content: cleanedContent  // Replace with cleaned version
          })
          .eq('id', session.id);

        cleaned++;
        logger.debug('Session cleaned', { sessionId: session.id });

      } catch (err) {
        logger.error('Failed to clean session', { sessionId: session.id, error: err.message });
      }
    }

    if (cleaned > 0) {
      logger.info('Cleaned sessions', { count: cleaned });
    }

    return cleaned;
  } catch (err) {
    logger.error('cleanProcessedSessions failed', { error: err.message });
    return 0;
  }
}

/**
 * Find sessions cleaned 24h+ ago, mark as archived
 */
async function archiveCleanedSessions() {
  // We need to track when session was cleaned
  // For now, use a simple approach: cleaned sessions older than 24h from now
  const cutoff = new Date(Date.now() - CLEAN_TO_ARCHIVE_HOURS * 60 * 60 * 1000).toISOString();

  try {
    // Find cleaned sessions (we'll use processed_at + 48h + 24h as estimate)
    // Better approach would be to add a cleaned_at column
    const archiveCutoff = new Date(Date.now() - (PROCESS_TO_CLEAN_HOURS + CLEAN_TO_ARCHIVE_HOURS) * 60 * 60 * 1000).toISOString();

    const { data: sessions, error } = await from('dev_ai_sessions')
      .select('id')
      .eq('status', 'cleaned')
      .lt('semantic_extracted_at', archiveCutoff)
      .limit(BATCH_SIZE);

    if (error) {
      logger.error('Failed to fetch cleaned sessions', { error: error.message });
      return 0;
    }

    if (!sessions || sessions.length === 0) {
      return 0;
    }

    // Mark as archived
    const ids = sessions.map(s => s.id);
    await from('dev_ai_sessions')
      .update({ status: 'archived' })
      .in('id', ids);

    logger.info('Archived sessions', { count: ids.length });
    return ids.length;

  } catch (err) {
    logger.error('archiveCleanedSessions failed', { error: err.message });
    return 0;
  }
}

/**
 * Clean raw content - remove code blocks, tool outputs, keep conversation
 */
function cleanRawContent(content) {
  if (!content) return '';

  let cleaned = content;

  // Remove tool_use blocks (JSON-like structures)
  cleaned = cleaned.replace(/"type"\s*:\s*"tool_use"[\s\S]*?"input"\s*:\s*\{[\s\S]*?\}\s*\}/g, '[tool call]');

  // Remove tool_result blocks
  cleaned = cleaned.replace(/"type"\s*:\s*"tool_result"[\s\S]*?"content"\s*:\s*"[\s\S]*?"/g, '[tool result]');

  // Remove large code blocks (more than 20 lines)
  cleaned = cleaned.replace(/```[\s\S]{500,}?```/g, '[code block removed]');

  // Remove base64 encoded content
  cleaned = cleaned.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]{100,}/g, '[image removed]');

  // Remove long file paths repeated many times
  cleaned = cleaned.replace(/((?:\/[\w.-]+){4,}\s*){5,}/g, '[file paths removed]');

  // Remove excessive whitespace
  cleaned = cleaned.replace(/\n{4,}/g, '\n\n\n');

  // Remove node_modules paths
  cleaned = cleaned.replace(/node_modules\/[\w\/@.-]+/g, '[node_modules path]');

  // Trim to reasonable size (keep last 50k chars if too long)
  if (cleaned.length > 50000) {
    cleaned = cleaned.slice(-50000);
  }

  return cleaned.trim();
}

/**
 * Extract summary information from cleaned content
 */
function extractSummary(content, session) {
  const summary = {
    text: '',
    topics: [],
    decisions: [],
    actions: []
  };

  // Extract user messages (simplified - look for common patterns)
  const userMessages = [];
  const lines = content.split('\n');

  let isUserMessage = false;
  let currentMessage = '';

  for (const line of lines) {
    // Detect user message starts
    if (line.match(/^(Human|User|Michael|>|YOU):/i) || line.match(/"role"\s*:\s*"user"/)) {
      if (currentMessage && isUserMessage) {
        userMessages.push(currentMessage.trim());
      }
      isUserMessage = true;
      currentMessage = line;
    } else if (line.match(/^(Assistant|Claude|AI):/i) || line.match(/"role"\s*:\s*"assistant"/)) {
      if (currentMessage && isUserMessage) {
        userMessages.push(currentMessage.trim());
      }
      isUserMessage = false;
      currentMessage = '';
    } else if (isUserMessage) {
      currentMessage += '\n' + line;
    }
  }

  // Build summary text
  const projectPath = session.project_id || 'unknown project';
  const sessionDate = session.started_at ? new Date(session.started_at).toLocaleString() : 'unknown date';

  summary.text = `Session from ${sessionDate}\nProject: ${projectPath}\n\n`;
  summary.text += `User messages (${userMessages.length} found):\n`;
  summary.text += userMessages.slice(0, 20).map((m, i) => `${i + 1}. ${m.slice(0, 200)}...`).join('\n');

  // Extract potential topics from content
  const topicPatterns = [
    /(?:working on|implementing|fixing|building|creating)\s+([^.!?\n]{10,50})/gi,
    /(?:the|this)\s+(feature|bug|issue|component|service|api|endpoint)\s+([^.!?\n]{5,30})/gi
  ];

  for (const pattern of topicPatterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      const topic = (match[1] || match[2] || '').trim();
      if (topic && !summary.topics.includes(topic)) {
        summary.topics.push(topic);
        if (summary.topics.length >= 10) break;
      }
    }
  }

  return summary;
}

/**
 * Get archiver stats
 */
async function getStats() {
  try {
    const statuses = ['active', 'processed', 'extracted', 'cleaned', 'archived'];
    const counts = {};

    for (const status of statuses) {
      const { data } = await from('dev_ai_sessions')
        .select('id', { count: 'exact', head: true })
        .eq('status', status);
      counts[status] = data?.length || 0;
    }

    const { data: summaries } = await from('dev_session_summaries')
      .select('id', { count: 'exact', head: true });
    counts.summaries = summaries?.length || 0;

    return counts;
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Manual trigger for testing
 */
async function runOnce() {
  return await runCycle();
}

module.exports = {
  start,
  runCycle,
  runOnce,
  getStats,
  cleanRawContent,
  extractSummary
};

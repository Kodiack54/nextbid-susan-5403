/**
 * Susan Clean Transcript Service v3
 * 
 * Extracts USER/ASSISTANT conversation from:
 * 1. JSONL format (Claude Code logs)
 * 2. Terminal capture format
 */

const { from } = require('../../../shared/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:CleanTranscript');
let isRunning = false;

function isValidUuid(str) {
  if (!str || typeof str !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

function stripAnsi(text = "") {
  return text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, '')
    .replace(/\x1B[P^_].*?\x1B\\/gs, '')
    .replace(/\r/g, '');
}

// Lines to drop - includes emoji variants
const DROP_LINE_PATTERNS = [
  /^\s*\[.*External Claude.*\]/i,           // Any [External Claude] variant
  /^\s*\[🤖.*\]/,                            // Emoji robot markers
  /^\s*root@.+?:.*?[#\$]\s*$/,
  /^\s*●\s*kodiack/i,
  /^\s*⎿/,
  /^\s*\(MCP\)/i,
  /^\s*Use --update-env/i,
  /^\s*\[PM2\]/i,
  /^\s*pm2\s+/i,
  /^\s*node\s+-[ec]/i,
  /^\s*sudo\s/i,
  /^\s*psql\s/i,
  /^\s*\(END\)\s*$/i,
  /^\s*INSERT INTO/i,
  /^\s*VALUES\s*\(/i,
  /^\s*SELECT\s+/i,
  /^\s*UPDATE\s+\w/i,
  /^\s*DELETE\s+FROM/i,
  /^\s*--\s*(Session|Project|Work Log|Todo|Bug):/i,
  /"signature"\s*:/,
  /^[A-Za-z0-9+\/=]{60,}$/,
  /refuse to improve or augment/i,
  /considered malware/i,
  /<\/?system-reminder>/i,
  /^\s*\{.*"parentUuid"/,                    // Raw JSON with parentUuid
  /^\s*\{.*"sessionId"/,                     // Raw JSON with sessionId
  /^\s*\{.*"type"\s*:\s*"queue/,             // Queue operation JSON
  /^\s*\{.*"tool_use_id"/,                   // Tool use JSON
  /^\s*\{.*"message"\s*:\s*\{/,              // Message wrapper JSON
  /^\s*ls\s+-la?\s*$/i,
  /^\s*cat\s+\//i,
  /^\s*grep\s+-/i,
  /^\s*cd\s+\//i,
  /^\s*echo\s+"/i,
];

function shouldDropLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 3) return true;
  return DROP_LINE_PATTERNS.some(rx => rx.test(trimmed));
}

/**
 * Extract from JSONL - find text blocks in user/assistant messages
 */
function extractFromJsonl(raw) {
  const lines = raw.split('\n');
  const conversation = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    
    try {
      const obj = JSON.parse(trimmed);
      const role = obj.message?.role || obj.role || obj.type;
      const content = obj.message?.content || obj.content;
      
      if (!content) continue;
      if (role !== 'user' && role !== 'assistant') continue;
      
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text && block.text.length > 20) {
            const text = block.text.trim();
            // Skip if it looks like junk
            if (shouldDropLine(text)) continue;
            if (text.startsWith('{') && text.includes('"')) continue; // JSON
            
            const prefix = role === 'user' ? 'USER: ' : 'ASSISTANT: ';
            conversation.push(prefix + text);
          }
        }
      } else if (typeof content === 'string' && content.length > 20) {
        if (shouldDropLine(content)) continue;
        if (content.startsWith('{') && content.includes('"')) continue;
        
        const prefix = role === 'user' ? 'USER: ' : 'ASSISTANT: ';
        conversation.push(prefix + content.trim());
      }
    } catch (e) {
      // Not JSON
    }
  }
  
  return conversation.join('\n\n');
}

/**
 * Clean any format - aggressive filtering
 */
function cleanTranscript(rawText = "") {
  if (!rawText || rawText.length < 50) return '';
  
  let text = stripAnsi(rawText);
  
  // Try JSONL extraction first if it looks like JSON
  if (text.trim().startsWith('{')) {
    const extracted = extractFromJsonl(text);
    if (extracted && extracted.length > 100) {
      return extracted.replace(/\n{3,}/g, '\n\n').trim();
    }
  }
  
  // Fallback: line-by-line filtering
  const lines = text.split('\n');
  const out = [];
  
  for (const line of lines) {
    if (shouldDropLine(line)) continue;
    
    // Skip table-like output
    if (/^\s*[│├└┌┐┘┬┴┼─]+/.test(line)) continue;
    if (/^\s*\+[-+]+\+\s*$/.test(line)) continue;
    if (/^\s*\d+\s*\|/.test(line)) continue;
    
    out.push(line);
  }
  
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function start(intervalMs = 5 * 60 * 1000) {
  logger.info('Clean transcript service v3 started', { intervalMs: intervalMs / 1000 + 's' });
  setTimeout(runCycle, 10000);
  setInterval(runCycle, intervalMs);
}

async function runCycle() {
  if (isRunning) return;
  isRunning = true;
  const stats = { processed: 0, cleaned: 0, errors: 0, skipped: 0 };

  try {
    const { data: sessions, error } = await from('dev_ai_sessions')
      .select('id, raw_content, project_id, project_slug')
      .eq('status', 'processed')
      .not('raw_content', 'is', null)
      .order('created_at', { ascending: true })
      .limit(100);

    if (error) {
      logger.error('Failed to fetch', { error: error.message });
      return;
    }
    if (!sessions || sessions.length === 0) return;

    stats.processed = sessions.length;
    logger.info(`Processing ${sessions.length} sessions`);

    for (const session of sessions) {
      try {
        const cleanText = cleanTranscript(session.raw_content);
        
        if (!cleanText || cleanText.length < 100) {
          await from('dev_ai_sessions').update({ status: 'cleaned' }).eq('id', session.id);
          stats.skipped++;
          continue;
        }

        const { data: existing } = await from('dev_ai_clean_transcripts')
          .select('id').eq('session_id', session.id).single();

        if (existing) {
          await from('dev_ai_sessions').update({ status: 'cleaned' }).eq('id', session.id);
          continue;
        }

        const { error: insertError } = await from('dev_ai_clean_transcripts').insert({
          session_id: session.id,
          project_id: isValidUuid(session.project_id) ? session.project_id : null,
          clean_text: cleanText,
          file_refs: JSON.stringify(extractFileRefs(session.raw_content))
        });

        if (insertError) {
          stats.errors++;
          continue;
        }

        await from('dev_ai_sessions').update({ status: 'cleaned' }).eq('id', session.id);
        stats.cleaned++;
      } catch (err) {
        stats.errors++;
      }
    }

    if (stats.cleaned > 0 || stats.skipped > 0) {
      logger.info('Cycle complete', stats);
    }
  } catch (err) {
    logger.error('Cycle failed', { error: err.message });
  } finally {
    isRunning = false;
  }
}

function extractFileRefs(content) {
  if (!content) return [];
  const refs = new Set();
  const matches = content.match(/(?:\/var\/www\/|C:[\/\\]Projects[\/\\])[^\s\n"'`\]})]+/g) || [];
  for (const m of matches) {
    const clean = m.replace(/[,;:'")\]}>]+$/, '');
    if (clean.length > 10) refs.add(clean);
  }
  return Array.from(refs).slice(0, 50);
}

module.exports = { start, runCycle, cleanTranscript, extractFileRefs };

/**
 * Susan - AI Team Librarian (Port 5403)
 *
 * Catalogs knowledge, organizes conversations, provides Claude with
 * persistent memory across sessions.
 *
 * When Claude connects, Susan provides:
 * - Last session summary
 * - Recent conversations
 * - Relevant knowledge items
 * - Database schemas
 * - Project context
 */

require('dotenv').config();
const express = require('express');
// Using local PostgreSQL instead of Supabase
const supabase = require('../shared/db');
const OpenAI = require('openai');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Import modular routes
const catalogRoutes = require('./src/routes/catalog');
const teamChatRoutes = require('./src/routes/teamChat');
app.use('/api', catalogRoutes);
app.use('/api/team-chat', teamChatRoutes);

const PORT = process.env.PORT || 5403;


// OpenAI for knowledge extraction
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ============================================
// CONTEXT - What Claude needs on startup
// ============================================

/**
 * Get startup context for Claude
 * Called when Claude connects to give him memory
 */
app.get('/api/context', async (req, res) => {
  const projectPath = req.query.project || req.query.path;
  const userId = req.query.userId;

  try {
    const context = await buildStartupContext(projectPath, userId);
    res.json(context);
  } catch (err) {
    console.error('[Susan] Context error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function buildStartupContext(projectPath, userId) {
  const context = {
    greeting: null,
    lastSession: null,
    recentMessages: [],
    relevantKnowledge: [],
    pendingTasks: [],
    projectInfo: null
  };

  // 1. Get last session for this project
  let sessionQuery = supabase.from('dev_ai_sessions')
    .select('id, project_path, started_at, ended_at, summary')
    .eq('status', 'completed')
    .order('ended_at', { ascending: false })
    .limit(1);

  if (projectPath) {
    sessionQuery = sessionQuery.eq('project_path', projectPath);
  }
  if (userId) {
    sessionQuery = sessionQuery.eq('user_id', userId);
  }

  const { data: sessions } = await sessionQuery;

  if (sessions && sessions.length > 0) {
    const session = sessions[0];
    context.lastSession = {
      id: session.id,
      projectPath: session.project_path,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      summary: session.summary
    };

    // Get messages from last session
    const { data: messages } = await supabase.from('dev_ai_messages')
      .select('role, content, created_at')
      .eq('session_id', session.id)
      .order('sequence_num', { ascending: false })
      .limit(20);

    context.recentMessages = (messages || []).reverse();
  }

  // 2. Get relevant knowledge for this project
  let knowledgeQuery = supabase.from('dev_ai_knowledge')
    .select('id, category, title, summary, tags, importance')
    .order('importance', { ascending: false })
    .limit(10);

  if (projectPath) {
    knowledgeQuery = knowledgeQuery.or(`project_path.eq.${projectPath},project_path.is.null`);
  }

  const { data: knowledge } = await knowledgeQuery;
  context.relevantKnowledge = knowledge || [];

  // 3. Get any pending decisions or notes
  let decisionsQuery = supabase.from('dev_ai_decisions')
    .select('title, decision, rationale, created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  if (projectPath) {
    decisionsQuery = decisionsQuery.eq('project_path', projectPath);
  }

  const { data: decisions } = await decisionsQuery;
  context.pendingTasks = decisions || [];

  // 4. Build greeting message
  context.greeting = buildGreeting(context);

  return context;
}

function buildGreeting(context) {
  const parts = [];

  parts.push("Hey Claude, welcome back! Here's where we left off:");

  if (context.lastSession) {
    const ago = timeAgo(new Date(context.lastSession.endedAt));
    parts.push(`\nLast session was ${ago}.`);

    if (context.lastSession.summary) {
      parts.push(`Summary: ${context.lastSession.summary}`);
    }
  } else {
    parts.push("\nThis looks like a new project - no previous sessions found.");
  }

  if (context.recentMessages.length > 0) {
    parts.push("\n**Recent conversation:**");
    context.recentMessages.slice(-5).forEach(m => {
      const role = m.role === 'user' ? 'User' : 'Claude';
      const preview = m.content.length > 100 ?
        m.content.slice(0, 100) + '...' : m.content;
      parts.push(`- ${role}: ${preview}`);
    });
  }

  if (context.relevantKnowledge.length > 0) {
    parts.push("\n**Things I remember about this project:**");
    context.relevantKnowledge.slice(0, 5).forEach(k => {
      parts.push(`- [${k.category}] ${k.title}`);
    });
  }

  parts.push("\nWhat would you like to work on?");

  return parts.join('\n');
}

function timeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  const intervals = [
    { label: 'year', seconds: 31536000 },
    { label: 'month', seconds: 2592000 },
    { label: 'week', seconds: 604800 },
    { label: 'day', seconds: 86400 },
    { label: 'hour', seconds: 3600 },
    { label: 'minute', seconds: 60 }
  ];

  for (const interval of intervals) {
    const count = Math.floor(seconds / interval.seconds);
    if (count > 0) {
      return `${count} ${interval.label}${count > 1 ? 's' : ''} ago`;
    }
  }
  return 'just now';
}

// ============================================
// MESSAGE - Receive from Chad, extract knowledge
// ============================================

app.post('/api/message', async (req, res) => {
  const { sessionId, projectPath, message } = req.body;

  try {
    // Check if this message contains something worth remembering
    if (message.role === 'assistant' && message.content.length > 50) {
      await extractKnowledge(sessionId, projectPath, message.content);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[Susan] Message processing error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function extractKnowledge(sessionId, projectPath, content) {
  // Skip short or trivial messages
  if (content.length < 100) return;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are Susan, an AI librarian. Analyze Claude's response and extract any knowledge worth remembering.

Look for:
- Solutions to problems
- Code patterns used
- Architectural decisions
- Bug fixes and their causes
- File structures explained
- Database changes
- Important configurations

Return JSON:
{
  "shouldRemember": boolean,
  "knowledge": {
    "category": "bug-fix" | "feature" | "architecture" | "database" | "config" | "explanation" | "other",
    "title": "Short descriptive title",
    "summary": "2-3 sentence summary",
    "tags": ["tag1", "tag2"],
    "importance": 1-10
  }
}

If nothing worth remembering, set shouldRemember: false.`
        },
        {
          role: 'user',
          content: `Analyze this Claude response:\n\n${content.slice(0, 4000)}`
        }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 500,
      temperature: 0.1
    });

    const result = JSON.parse(response.choices[0].message.content);

    if (result.shouldRemember && result.knowledge) {
      const k = result.knowledge;
      const { error } = await supabase.from('dev_ai_knowledge').insert({
        session_id: sessionId,
        project_path: projectPath,
        category: k.category,
        title: k.title,
        summary: k.summary,
        tags: k.tags || [],
        importance: k.importance || 5
      });

      if (error) throw error;
      console.log(`[Susan] Remembered: [${k.category}] ${k.title}`);
    }
  } catch (err) {
    console.error('[Susan] Knowledge extraction error:', err.message);
  }
}

// ============================================
// SUMMARIZE - Called when session ends
// ============================================

app.post('/api/summarize', async (req, res) => {
  const { sessionId } = req.body;

  try {
    // Get all messages from session
    const { data: messages, error: msgError } = await supabase.from('dev_ai_messages')
      .select('role, content')
      .eq('session_id', sessionId)
      .order('sequence_num', { ascending: true });

    if (msgError) throw msgError;

    if (!messages || messages.length === 0) {
      return res.json({ success: true, summary: null });
    }

    // Build conversation for summarization
    const conversation = messages
      .map(m => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.content}`)
      .join('\n\n');

    // Summarize with GPT-4o-mini
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Summarize this development session in 2-3 sentences. Focus on:
- What was the main task/goal?
- What was accomplished?
- Any important decisions or blockers?`
        },
        {
          role: 'user',
          content: conversation.slice(0, 8000)
        }
      ],
      max_tokens: 200
    });

    const summary = response.choices[0].message.content;

    // Update session with summary
    const { error: updateError } = await supabase.from('dev_ai_sessions')
      .update({ summary })
      .eq('id', sessionId);

    if (updateError) throw updateError;

    console.log(`[Susan] Session summarized: ${summary.slice(0, 50)}...`);
    res.json({ success: true, summary });
  } catch (err) {
    console.error('[Susan] Summarization error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// PROCESS-DUMP - Process Chad's session dumps
// ============================================

app.post('/api/process-dump', async (req, res) => {
  const { sessionId, sourceId, sourceName } = req.body;

  console.log(`[Susan] Processing dump from ${sourceName} (${sessionId})`);

  try {
    // Get the raw content from the session
    const { data: session, error: sessError } = await supabase.from('dev_ai_sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    if (sessError) throw sessError;
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const rawContent = session.raw_content || '';
    if (!rawContent) {
      // Mark as processed even if no content
      await supabase.from('dev_ai_sessions')
        .update({ status: 'processed', processed_at: new Date().toISOString() })
        .eq('id', sessionId);
      return res.json({ success: true, extracted: 0 });
    }

    // Use GPT to extract structured info from the dump
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are Susan, the AI Librarian. Analyze this terminal/chat dump and extract:
1. Key decisions made
2. Tasks/todos mentioned
3. Important code changes or file modifications
4. Bugs or issues found
5. Knowledge worth remembering

Return JSON:
{
  "summary": "Brief summary of what happened",
  "decisions": [{"title": "", "content": ""}],
  "todos": [{"title": "", "description": "", "priority": "low|medium|high"}],
  "knowledge": [{"title": "", "content": "", "category": "architecture|bug-fix|config|workflow"}],
  "project_path": "/detected/project/path or null"
}`
        },
        {
          role: 'user',
          content: `Source: ${sourceName}\n\nDump content:\n${rawContent.slice(0, 10000)}`
        }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1500
    });

    const extracted = JSON.parse(response.choices[0].message.content);
    const projectPath = extracted.project_path || session.project_path || '/var/www/Studio';

    // Store extracted items
    let itemsStored = 0;
    const conflicts = [];

    // Store todos - check for conflicts first
    if (extracted.todos?.length > 0) {
      for (const todo of extracted.todos) {
        // Check for similar existing todos
        const { data: existingTodos } = await supabase.from('dev_ai_todos')
          .select('id, title, description, priority, status')
          .eq('project_path', projectPath)
          .ilike('title', `%${todo.title.split(' ').slice(0, 3).join('%')}%`)
          .limit(3);

        if (existingTodos && existingTodos.length > 0) {
          // Check if any existing todo conflicts with new one
          const conflict = await checkForConflict('todo', todo, existingTodos);
          if (conflict) {
            conflicts.push(conflict);
            continue; // Skip storing this one until conflict resolved
          }
        }

        await supabase.from('dev_ai_todos').insert({
          project_path: projectPath,
          title: todo.title,
          description: todo.description,
          priority: todo.priority || 'medium',
          status: 'pending',
          source_session_id: sessionId
        });
        itemsStored++;
      }
    }

    // Store knowledge - check for conflicts first
    if (extracted.knowledge?.length > 0) {
      for (const k of extracted.knowledge) {
        // Check for similar existing knowledge
        const { data: existingKnowledge } = await supabase.from('dev_ai_knowledge')
          .select('id, title, summary, category')
          .eq('project_path', projectPath)
          .ilike('title', `%${k.title.split(' ').slice(0, 3).join('%')}%`)
          .limit(3);

        if (existingKnowledge && existingKnowledge.length > 0) {
          // Check if any existing knowledge conflicts with new one
          const conflict = await checkForConflict('knowledge', k, existingKnowledge);
          if (conflict) {
            conflicts.push(conflict);
            continue; // Skip storing until resolved
          }
        }

        await supabase.from('dev_ai_knowledge').insert({
          project_path: projectPath,
          title: k.title,
          summary: k.content,
          category: k.category || 'general',
          importance: 5,
          source_session_id: sessionId
        });
        itemsStored++;
      }
    }

    // Store decisions - check for conflicts
    if (extracted.decisions?.length > 0) {
      for (const decision of extracted.decisions) {
        // Check for conflicting decisions
        const { data: existingDecisions } = await supabase.from('dev_ai_decisions')
          .select('id, title, decision, rationale')
          .eq('project_path', projectPath)
          .ilike('title', `%${decision.title.split(' ').slice(0, 3).join('%')}%`)
          .limit(3);

        if (existingDecisions && existingDecisions.length > 0) {
          const conflict = await checkForConflict('decision', decision, existingDecisions);
          if (conflict) {
            conflicts.push(conflict);
            continue;
          }
        }

        await supabase.from('dev_ai_decisions').insert({
          project_path: projectPath,
          title: decision.title,
          decision: decision.content,
          rationale: decision.rationale || '',
          session_id: sessionId
        });
        itemsStored++;
      }
    }

    // If conflicts found, notify user via chat
    if (conflicts.length > 0) {
      await notifyUserOfConflicts(projectPath, conflicts);
    }

    // Update session as processed with summary
    await supabase.from('dev_ai_sessions')
      .update({
        status: 'processed',
        summary: extracted.summary,
        processed_at: new Date().toISOString(),
        processed_by: 'susan',
        items_extracted: itemsStored,
        conflicts_found: conflicts.length
      })
      .eq('id', sessionId);

    console.log(`[Susan] Processed dump ${sessionId}: ${itemsStored} items extracted, ${conflicts.length} conflicts found`);

    res.json({
      success: true,
      summary: extracted.summary,
      extracted: itemsStored,
      todos: extracted.todos?.length || 0,
      knowledge: extracted.knowledge?.length || 0,
      conflicts: conflicts.length
    });
  } catch (err) {
    console.error('[Susan] Process-dump error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Check if new item conflicts with existing items using GPT
 */
async function checkForConflict(itemType, newItem, existingItems) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are Susan, checking for conflicts in a knowledge base.
Compare the NEW ${itemType} with EXISTING items. A conflict exists if:
- They describe the same thing but with different/contradicting information
- One supersedes or invalidates the other
- They have incompatible priorities or statuses

Return JSON:
{
  "hasConflict": boolean,
  "conflictType": "contradiction|supersedes|duplicate|priority_mismatch" or null,
  "explanation": "Brief explanation of the conflict" or null,
  "recommendation": "keep_new|keep_existing|merge|ask_user" or null
}`
        },
        {
          role: 'user',
          content: `NEW ${itemType}:\n${JSON.stringify(newItem, null, 2)}\n\nEXISTING items:\n${JSON.stringify(existingItems, null, 2)}`
        }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 300,
      temperature: 0.1
    });

    const result = JSON.parse(response.choices[0].message.content);

    if (result.hasConflict && result.recommendation === 'ask_user') {
      return {
        type: itemType,
        conflictType: result.conflictType,
        newItem,
        existingItems,
        explanation: result.explanation,
        recommendation: result.recommendation
      };
    }

    return null; // No conflict that needs user input
  } catch (err) {
    console.error('[Susan] Conflict check error:', err.message);
    return null; // On error, just proceed without conflict detection
  }
}

/**
 * Notify user of conflicts via chat message
 */
async function notifyUserOfConflicts(projectPath, conflicts) {
  try {
    // Store conflicts for later resolution
    for (const conflict of conflicts) {
      await supabase.from('dev_ai_conflicts').insert({
        project_path: projectPath,
        conflict_type: conflict.type,
        new_item: conflict.newItem,
        existing_items: conflict.existingItems,
        explanation: conflict.explanation,
        status: 'pending'
      });
    }

    // Create a notification message
    const conflictSummary = conflicts.map(c =>
      `- ${c.type}: "${c.newItem.title}" - ${c.explanation}`
    ).join('\n');

    const message = `Hey! I found ${conflicts.length} potential conflict${conflicts.length > 1 ? 's' : ''} while processing recent sessions:

${conflictSummary}

Can you help me sort these out? I don't want to overwrite something important with outdated info.

You can resolve these in the Session Hub under "Pending Conflicts" or just tell me here which version to keep.`;

    // Store as a Susan notification
    await supabase.from('dev_ai_notifications').insert({
      type: 'conflict',
      from_worker: 'susan',
      project_path: projectPath,
      title: `${conflicts.length} Conflict${conflicts.length > 1 ? 's' : ''} Found`,
      message,
      status: 'unread',
      metadata: { conflicts }
    });

    console.log(`[Susan] Created notification for ${conflicts.length} conflicts`);
  } catch (err) {
    console.error('[Susan] Failed to notify user of conflicts:', err.message);
  }
}

// ============================================
// CONFLICTS - Manage pending conflicts
// ============================================

app.get('/api/conflicts', async (req, res) => {
  const { project_path, status = 'pending' } = req.query;

  try {
    let query = supabase.from('dev_ai_conflicts')
      .select('*')
      .order('created_at', { ascending: false });

    if (project_path) {
      query = query.ilike('project_path', `%${project_path}%`);
    }
    if (status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, error } = await query.limit(50);
    if (error) throw error;

    res.json({ success: true, conflicts: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/conflicts/resolve', async (req, res) => {
  const { conflict_id, resolution, keep_item } = req.body;
  // resolution: 'keep_new' | 'keep_existing' | 'keep_both' | 'discard_both'
  // keep_item: for 'keep_existing', which existing item ID to keep

  try {
    const { data: conflict, error: fetchErr } = await supabase.from('dev_ai_conflicts')
      .select('*')
      .eq('id', conflict_id)
      .single();

    if (fetchErr) throw fetchErr;
    if (!conflict) return res.status(404).json({ error: 'Conflict not found' });

    // Apply resolution
    if (resolution === 'keep_new') {
      // Store the new item
      const newItem = conflict.new_item;
      const tableName = `dev_ai_${conflict.conflict_type}s`; // todos, knowledge, decisions

      await supabase.from(tableName).insert({
        project_path: conflict.project_path,
        title: newItem.title,
        ...newItem
      });
    }
    // For 'keep_existing', we don't need to do anything - item is already there
    // For 'keep_both', store the new one alongside existing
    // For 'discard_both', optionally remove existing items

    // Mark conflict as resolved
    await supabase.from('dev_ai_conflicts')
      .update({ status: 'resolved', resolution, resolved_at: new Date().toISOString() })
      .eq('id', conflict_id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// NOTIFICATIONS - Susan's messages to user
// ============================================

app.get('/api/notifications', async (req, res) => {
  const { status = 'unread', limit = 20 } = req.query;

  try {
    let query = supabase.from('dev_ai_notifications')
      .select('*')
      .eq('from_worker', 'susan')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, notifications: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/mark-read', async (req, res) => {
  const { notification_id, mark_all } = req.body;

  try {
    if (mark_all) {
      await supabase.from('dev_ai_notifications')
        .update({ status: 'read' })
        .eq('status', 'unread')
        .eq('from_worker', 'susan');
    } else if (notification_id) {
      await supabase.from('dev_ai_notifications')
        .update({ status: 'read' })
        .eq('id', notification_id);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// TODOS - Manage project todos
// ============================================

app.get('/api/todos', async (req, res) => {
  const { project, status, limit = 50 } = req.query;

  try {
    let query = supabase.from('dev_ai_todos')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (project) {
      query = query.ilike('project_path', `%${project}%`);
    }
    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, todos: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/todo', async (req, res) => {
  const { title, description, priority, status, project_path } = req.body;

  if (!title || !project_path) {
    return res.status(400).json({ error: 'title and project_path required' });
  }

  try {
    const { data, error } = await supabase.from('dev_ai_todos')
      .insert({
        title,
        description,
        priority: priority || 'medium',
        status: status || 'pending',
        project_path
      })
      .select()
      .single();

    if (error) throw error;
    console.log(`[Susan] Todo created: ${title}`);
    res.json({ success: true, todo: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/todo/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  try {
    const { data, error } = await supabase.from('dev_ai_todos')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, todo: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/todo/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase.from('dev_ai_todos')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// DOCS - Manage project documentation
// ============================================

app.get('/api/docs', async (req, res) => {
  const { project, category, limit = 50 } = req.query;

  try {
    let query = supabase.from('dev_ai_docs')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(parseInt(limit));

    if (project) {
      query = query.ilike('project_path', `%${project}%`);
    }
    if (category) {
      query = query.eq('category', category);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, docs: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/doc', async (req, res) => {
  const { title, content, category, project_path } = req.body;

  if (!title || !content || !project_path) {
    return res.status(400).json({ error: 'title, content, and project_path required' });
  }

  try {
    const { data, error } = await supabase.from('dev_ai_docs')
      .insert({
        title,
        content,
        category: category || 'general',
        project_path
      })
      .select()
      .single();

    if (error) throw error;
    console.log(`[Susan] Doc created: ${title}`);
    res.json({ success: true, doc: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/doc/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  try {
    const { data, error } = await supabase.from('dev_ai_docs')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, doc: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/doc/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase.from('dev_ai_docs')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// QUERY - Search knowledge base
// ============================================

app.get('/api/query', async (req, res) => {
  const { q, project, category, limit = 10 } = req.query;

  try {
    let query = supabase.from('dev_ai_knowledge')
      .select('id, category, title, summary, tags, importance, created_at')
      .order('importance', { ascending: false })
      .limit(parseInt(limit));

    if (q) {
      // Text search using ilike since Supabase doesn't support full-text search easily
      query = query.or(`title.ilike.%${q}%,summary.ilike.%${q}%`);
    }

    if (project) {
      query = query.ilike('project_path', `%${project}%`);
    }

    if (category) {
      query = query.eq('category', category);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Update reference counts for queried items
    if (data && data.length > 0 && q) {
      const ids = data.map(r => r.id);
      // Note: Supabase doesn't support increment directly, would need RPC for this
      // For now, skip the reference count update
    }

    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// REMEMBER - Manually add knowledge
// ============================================

app.post('/api/remember', async (req, res) => {
  const { category, title, summary, details, tags, projectPath, importance } = req.body;

  try {
    const { data, error } = await supabase.from('dev_ai_knowledge')
      .insert({
        category: category || 'note',
        title,
        summary,
        details,
        tags: tags || [],
        project_path: projectPath,
        importance: importance || 5
      })
      .select('id')
      .single();

    if (error) throw error;

    console.log(`[Susan] Manually remembered: ${title}`);
    res.json({ success: true, id: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// SCHEMA - Store/retrieve database schemas
// ============================================

app.post('/api/schema', async (req, res) => {
  const { databaseName, tableName, schema, description } = req.body;

  try {
    const { error } = await supabase.from('dev_ai_schemas')
      .upsert({
        database_name: databaseName,
        table_name: tableName,
        schema_definition: schema,
        description,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'database_name,table_name'
      });

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/schemas', async (req, res) => {
  const { database } = req.query;

  try {
    let query = supabase.from('dev_ai_schemas')
      .select('database_name, table_name, schema_definition, description')
      .order('database_name')
      .order('table_name');

    if (database) {
      query = query.eq('database_name', database);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// DECISIONS - Track architectural decisions
// ============================================

app.post('/api/decision', async (req, res) => {
  const { sessionId, title, context, decision, alternatives, rationale, projectPath, tags } = req.body;

  try {
    const { data, error } = await supabase.from('dev_ai_decisions')
      .insert({
        session_id: sessionId,
        title,
        context,
        decision,
        alternatives: alternatives || [],
        rationale,
        project_path: projectPath,
        tags: tags || []
      })
      .select('id')
      .single();

    if (error) throw error;

    console.log(`[Susan] Decision recorded: ${title}`);
    res.json({ success: true, id: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// CHAT - Direct conversation with Susan
// ============================================

app.post('/api/chat', async (req, res) => {
  const { message, context, projectPath } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message required' });
  }

  try {
    // Get knowledge base for context
    const { data: knowledge } = await supabase.from('dev_ai_knowledge')
      .select('category, title, summary')
      .order('importance', { ascending: false })
      .limit(10);

    // Get recent decisions
    const { data: decisions } = await supabase.from('dev_ai_decisions')
      .select('title, decision, rationale')
      .order('created_at', { ascending: false })
      .limit(5);

    // Get schemas if available
    const { data: schemas } = await supabase.from('dev_ai_schemas')
      .select('database_name, table_name, description')
      .limit(20);

    const knowledgeContext = knowledge?.length > 0
      ? `Knowledge I've cataloged:\n${knowledge.map(k =>
          `- [${k.category}] ${k.title}: ${k.summary?.slice(0, 100) || ''}`
        ).join('\n')}`
      : 'No knowledge cataloged yet.';

    const decisionContext = decisions?.length > 0
      ? `Recent decisions:\n${decisions.map(d =>
          `- ${d.title}: ${d.decision}`
        ).join('\n')}`
      : '';

    const schemaContext = schemas?.length > 0
      ? `Database tables I know about:\n${schemas.map(s =>
          `- ${s.database_name}.${s.table_name}: ${s.description || 'No description'}`
        ).join('\n')}`
      : '';

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are Susan, the AI Team Librarian at Kodiack Studios. You work on port 5403.

Your job:
- Catalog all conversations and extract knowledge
- Remember what Claude worked on across sessions
- Store database schemas, file structures, port assignments
- Provide context to Claude when he starts a new session
- Answer questions about the codebase, past work, and project details

Personality: Organized, helpful, great memory for details. You love categorizing and finding information.

${knowledgeContext}

${decisionContext}

${schemaContext}

${context ? `Additional context: ${context}` : ''}

Keep responses helpful and informative. You can tell the user about what's been cataloged, search for specific knowledge, explain database schemas, or help them understand the project history.

If the user wants you to remember something, acknowledge it and explain you'll catalog it. If they ask about something you don't know yet, say so and offer to learn it.`
        },
        {
          role: 'user',
          content: message
        }
      ],
      max_tokens: 500,
      temperature: 0.7
    });

    const reply = response.choices[0].message.content;
    console.log(`[Susan] Chat: "${message.slice(0, 50)}..." -> "${reply.slice(0, 50)}..."`);

    res.json({
      success: true,
      reply,
      from: 'susan'
    });
  } catch (err) {
    console.error('[Susan] Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// HEALTH
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'susan-librarian',
    port: PORT
  });
});

// ============================================
// Start Server
// ============================================

app.listen(PORT, () => {
  console.log(`
====================================
  Susan - AI Team Librarian
  Port: ${PORT}
====================================

  HTTP API:  http://localhost:${PORT}

  Endpoints:
    GET  /health
    GET  /api/context?project=...     Claude startup context
    POST /api/message                  From Chad - extract knowledge
    POST /api/summarize                Summarize ended session
    GET  /api/query?q=...             Search knowledge
    POST /api/remember                 Manually add knowledge
    POST /api/schema                   Store table schema
    GET  /api/schemas                  Get stored schemas
    POST /api/decision                 Record architecture decision
    POST /api/chat                     <-- NEW: Chat with Susan

  Ready to organize Claude's memory.
====================================
  `);
});

// Periodic processor removed - relying on Chad -> Susan catalog flow

// Queue stats endpoint - Chad's pending extractions
app.get('/api/queue-stats', async (req, res) => {
  try {
    const { from } = require('./src/lib/db');
    const { data: pending, error } = await from('dev_ai_smart_extractions')
      .select('id, extraction_type, created_at')
      .eq('status', 'pending');

    if (error) throw error;

    const byType = {};
    (pending || []).forEach(item => {
      const type = item.extraction_type || 'unknown';
      byType[type] = (byType[type] || 0) + 1;
    });

    res.json({
      success: true,
      pending: { total: pending?.length || 0, byType },
      oldestPending: pending?.[0]?.created_at || null
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

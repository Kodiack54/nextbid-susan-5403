/**
 * Susan Context Routes
 * Provides startup context to Claude
 *
 * 3-LAYER MEMORY SYSTEM:
 * 1. SHORT-TERM: Last 6 hours of transcripts (step-by-step what happened)
 * 2. LONG-TERM: Susan's stored knowledge, decisions, summaries
 * 3. CURRENT FOCUS: Ryan's todo list (what to work on NOW)
 *
 * INDEPENDENT - No reliance on Clair or other AI team members
 */

const express = require('express');
const router = express.Router();
const { from } = require('../lib/db');
const { Logger } = require('../lib/logger');
const config = require('../lib/config');

const logger = new Logger('Susan:Context');
const RYAN_URL = 'http://localhost:5402';

/**
 * Fetch data from Ryan's API
 */
async function fetchFromRyan(endpoint) {
  try {
    const response = await fetch(`${RYAN_URL}${endpoint}`);
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    logger.warn(`Ryan fetch failed: ${endpoint}`, { error: err.message });
    return null;
  }
}

/**
 * GET /api/context - Claude's startup context
 */
router.get('/context', async (req, res) => {
  const projectPath = req.query.project || req.query.path;
  const userId = req.query.userId;

  try {
    const context = await buildStartupContext(projectPath, userId);
    res.json(context);
  } catch (err) {
    logger.error('Context build failed', { error: err.message, projectPath });
    res.status(500).json({ error: err.message });
  }
});

/**
 * Build comprehensive startup context for Claude
 */
async function buildStartupContext(projectPath, userId) {
  const context = {
    greeting: null,
    // SHORT-TERM MEMORY: Last 6 hours
    recentTranscripts: [],
    lastSession: null,
    // LONG-TERM MEMORY: Stored knowledge
    relevantKnowledge: [],
    decisions: [],
    todos: [],
    bugs: [],
    // PROJECT INFO
    projectInfo: null,
    ports: [],
    schemas: [],
    fileStructure: null,
    // CURRENT FOCUS: Ryan's priorities
    ryanTodos: [],
    ryanBriefing: null
  };

  // =====================
  // 1. SHORT-TERM MEMORY: Last 6 hours of transcripts
  // =====================
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  // Get journal entries from last 6 hours (transcripts, work logs)
  const { data: recentJournal } = await from('dev_ai_journal')
    .select('id, entry_type, title, content, project_id, created_at, metadata')
    .gte('created_at', sixHoursAgo)
    .order('created_at', { ascending: false })
    .limit(50);

  if (recentJournal?.length > 0) {
    context.recentTranscripts = recentJournal.map(j => ({
      type: j.entry_type,
      title: j.title,
      content: j.content,
      project: j.project_id,
      time: j.created_at,
      metadata: j.metadata
    }));
  }

  // Get last completed session
  let sessionQuery = from('dev_ai_sessions')
    .select('id, project_id, started_at, ended_at, summary')
    .eq('status', 'completed')
    .order('ended_at', { ascending: false })
    .limit(1);

  if (projectPath) {
    sessionQuery = sessionQuery.eq('project_id', projectPath);
  }

  const { data: sessions } = await sessionQuery;
  if (sessions?.length > 0) {
    context.lastSession = {
      id: sessions[0].id,
      projectPath: sessions[0].project_id,
      startedAt: sessions[0].started_at,
      endedAt: sessions[0].ended_at,
      summary: sessions[0].summary
    };
  }

  // =====================
  // 2. LONG-TERM MEMORY: Stored knowledge
  // =====================

  // Knowledge base
  let knowledgeQuery = from('dev_ai_knowledge')
    .select('id, category, title, summary, tags, importance, project_id')
    .order('importance', { ascending: false })
    .limit(config.MAX_CONTEXT_ITEMS || 20);

  if (projectPath) {
    knowledgeQuery = knowledgeQuery.or(`project_id.eq.${projectPath},project_id.is.null`);
  }

  const { data: knowledge } = await knowledgeQuery;
  context.relevantKnowledge = knowledge || [];

  // Decisions
  let decisionsQuery = from('dev_ai_decisions')
    .select('id, title, decision, rationale, created_at, project_id')
    .order('created_at', { ascending: false })
    .limit(10);

  if (projectPath) {
    decisionsQuery = decisionsQuery.eq('project_id', projectPath);
  }

  const { data: decisions } = await decisionsQuery;
  context.decisions = decisions || [];

  // Todos (from Susan's tables, not Ryan's)
  let todosQuery = from('dev_ai_todos')
    .select('id, title, description, priority, category, status, created_at, project_id')
    .in('status', ['pending', 'in_progress', 'open', 'unassigned'])
    .order('priority', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(15);

  if (projectPath) {
    todosQuery = todosQuery.eq('project_id', projectPath);
  }

  const { data: todos } = await todosQuery;
  context.todos = todos || [];

  // Active bugs
  let bugsQuery = from('dev_ai_bugs')
    .select('id, title, description, severity, status, created_at, project_id')
    .in('status', ['open', 'in_progress', 'pending', 'unassigned'])
    .order('severity', { ascending: true })
    .limit(10);

  if (projectPath) {
    bugsQuery = bugsQuery.eq('project_id', projectPath);
  }

  const { data: bugs } = await bugsQuery;
  context.bugs = bugs || [];

  // =====================
  // 3. PROJECT INFO
  // =====================

  // Port assignments (all of them)
  const { data: allPorts } = await from('dev_ai_structures')
    .select('project_id, project_name, ports')
    .order('project_name', { ascending: true });

  if (allPorts) {
    const portsList = [];
    allPorts.forEach(struct => {
      if (struct.ports && Array.isArray(struct.ports)) {
        struct.ports.forEach(p => {
          portsList.push({
            port: p.port,
            service: p.service || p.name,
            project: struct.project_name
          });
        });
      }
    });
    context.ports = portsList.sort((a, b) => a.port - b.port);
  }

  // Project-specific structure
  if (projectPath) {
    const { data: structure } = await from('dev_ai_structures')
      .select('project_id, project_name, ports, services, databases')
      .eq('project_id', projectPath)
      .single();

    if (structure) {
      context.projectInfo = {
        name: structure.project_name,
        path: structure.project_id,
        services: structure.services || [],
        databases: structure.databases || []
      };
    }

    // File structure
    const { data: fileStructure } = await from('dev_ai_file_structures')
      .select('directories, key_files, updated_at')
      .eq('project_id', projectPath)
      .single();

    if (fileStructure) {
      context.fileStructure = {
        directories: fileStructure.directories || [],
        keyFiles: fileStructure.key_files || [],
        updatedAt: fileStructure.updated_at
      };
    }
  }

  // Schema info
  let schemaQuery = from('dev_ai_schemas')
    .select('table_name, prefix, column_count, description')
    .order('table_name', { ascending: true })
    .limit(30);

  const { data: schemas } = await schemaQuery;
  context.schemas = schemas || [];

  // =====================
  // 4. CURRENT FOCUS: Ryan's todos
  // =====================

  // Get Ryan's actual todo list (what to work on NOW)
  const ryanTodosData = await fetchFromRyan('/api/todos?status=pending,in_progress');
  if (ryanTodosData?.success && ryanTodosData.todos) {
    context.ryanTodos = ryanTodosData.todos.slice(0, 10).map(t => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      status: t.status,
      project: t.project_name
    }));
  }

  // Get Ryan's project briefing (priorities, blockers)
  const ryanBriefingData = await fetchFromRyan('/api/briefing');
  if (ryanBriefingData?.success && ryanBriefingData.data) {
    const rd = ryanBriefingData.data;
    context.ryanBriefing = {
      currentFocus: rd.current_focus,
      recommendation: rd.recommendation,
      inProgress: rd.in_progress?.slice(0, 5),
      blocked: rd.blocked?.slice(0, 3)
    };
  }

  // =====================
  // 5. BUILD GREETING
  // =====================
  context.greeting = buildGreeting(context);

  logger.info('Context built', {
    projectPath,
    shortTermItems: context.recentTranscripts.length,
    knowledgeCount: context.relevantKnowledge.length,
    todoCount: context.todos.length,
    bugCount: context.bugs.length,
    ryanTodos: context.ryanTodos.length
  });

  return context;
}

/**
 * Build personalized greeting for Claude
 */
function buildGreeting(context) {
  const parts = [];

  parts.push("=== SUSAN'S MEMORY BRIEFING ===");
  parts.push("Hey Claude, here's your 3-layer memory restore:");

  // =====================
  // LAYER 1: SHORT-TERM (Last 6 hours)
  // =====================
  parts.push("\n━━━ SHORT-TERM MEMORY (Last 6 Hours) ━━━");

  if (context.recentTranscripts?.length > 0) {
    parts.push(`📝 ${context.recentTranscripts.length} recent entries:`);

    // Group by type
    const workLogs = context.recentTranscripts.filter(t => t.type === 'work_log');
    const decisions = context.recentTranscripts.filter(t => t.type === 'decision');
    const discoveries = context.recentTranscripts.filter(t => t.type === 'discovery');

    if (workLogs.length > 0) {
      parts.push(`\n   WORK LOG (${workLogs.length} entries):`);
      workLogs.slice(0, 5).forEach(w => {
        const time = new Date(w.time).toLocaleTimeString();
        parts.push(`   [${time}] ${w.title}`);
        if (w.content) parts.push(`      ${w.content.slice(0, 150)}...`);
      });
    }

    if (decisions.length > 0) {
      parts.push(`\n   DECISIONS MADE (${decisions.length}):`);
      decisions.slice(0, 3).forEach(d => {
        parts.push(`   • ${d.title}`);
      });
    }

    if (discoveries.length > 0) {
      parts.push(`\n   DISCOVERIES (${discoveries.length}):`);
      discoveries.slice(0, 3).forEach(d => {
        parts.push(`   • ${d.title}`);
      });
    }
  } else {
    parts.push("   No activity in last 6 hours.");
  }

  if (context.lastSession) {
    const ago = timeAgo(new Date(context.lastSession.endedAt));
    parts.push(`\n   LAST SESSION: ${ago}`);
    if (context.lastSession.summary) {
      parts.push(`   ${context.lastSession.summary.slice(0, 200)}...`);
    }
  }

  // =====================
  // LAYER 2: CURRENT FOCUS (Ryan's Priorities)
  // =====================
  parts.push("\n━━━ CURRENT FOCUS (What To Work On) ━━━");

  if (context.ryanTodos?.length > 0) {
    parts.push("🎯 RYAN'S TODO LIST:");
    context.ryanTodos.forEach(t => {
      const priority = t.priority === 'high' ? '🔴' : t.priority === 'medium' ? '🟡' : '🟢';
      const status = t.status === 'in_progress' ? '⏳' : '⬜';
      parts.push(`   ${status} ${priority} ${t.title}`);
      if (t.project) parts.push(`      └─ ${t.project}`);
    });
  }

  if (context.ryanBriefing) {
    const rb = context.ryanBriefing;
    if (rb.currentFocus?.length > 0) {
      parts.push(`\n   🎯 CURRENT FOCUS:`);
      rb.currentFocus.slice(0, 2).forEach(cf => {
        parts.push(`      ${cf.project?.name} - ${cf.phase?.name}`);
      });
    }
    if (rb.blocked?.length > 0) {
      parts.push(`\n   ⚠️ BLOCKED:`);
      rb.blocked.forEach(b => {
        parts.push(`      🚫 ${b.project_name} - waiting on ${b.blocking_project}`);
      });
    }
  }

  // =====================
  // LAYER 3: LONG-TERM (Stored Knowledge)
  // =====================
  parts.push("\n━━━ LONG-TERM MEMORY (Stored Knowledge) ━━━");

  // Active bugs (important!)
  if (context.bugs?.length > 0) {
    parts.push("🐛 ACTIVE BUGS:");
    context.bugs.slice(0, 5).forEach(b => {
      const sev = b.severity === 'critical' ? '🔴' : b.severity === 'high' ? '🟠' : '🟡';
      parts.push(`   ${sev} ${b.title}`);
    });
  }

  // Pending todos
  if (context.todos?.length > 0) {
    parts.push("\n✅ PENDING TODOS:");
    context.todos.slice(0, 5).forEach(t => {
      const priority = t.priority === 'high' ? '🔴' : t.priority === 'medium' ? '🟡' : '🟢';
      parts.push(`   ${priority} ${t.title}`);
    });
  }

  // Decisions
  if (context.decisions?.length > 0) {
    parts.push("\n🎯 RECENT DECISIONS:");
    context.decisions.slice(0, 3).forEach(d => {
      parts.push(`   • ${d.title}`);
      if (d.decision) parts.push(`     └─ ${d.decision.slice(0, 80)}...`);
    });
  }

  // Knowledge
  if (context.relevantKnowledge?.length > 0) {
    parts.push("\n🧠 KEY KNOWLEDGE:");
    context.relevantKnowledge.slice(0, 5).forEach(k => {
      parts.push(`   [${k.category}] ${k.title}`);
    });
  }

  // Port Assignments
  if (context.ports?.length > 0) {
    parts.push("\n🔌 PORTS:");
    context.ports.slice(0, 10).forEach(p => {
      parts.push(`   :${p.port} - ${p.service}`);
    });
    if (context.ports.length > 10) {
      parts.push(`   ... and ${context.ports.length - 10} more`);
    }
  }

  parts.push("\n=== END BRIEFING ===");
  parts.push("Memory restored. What should we focus on?");

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

module.exports = router;

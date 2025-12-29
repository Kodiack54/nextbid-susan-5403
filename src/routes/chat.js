/**
 * Susan Chat Routes
 * Direct conversation with Susan
 *
 * NOTE: knowledgeClassifier removed - Jen handles classification now
 * Review queue routes return empty/disabled responses
 */

const express = require('express');
const router = express.Router();
const { from } = require('../lib/db');
const { chat } = require('../lib/openai');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:Chat');

/**
 * POST /api/chat - Chat with Susan
 */
router.post('/chat', async (req, res) => {
  const { message, context, projectPath } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message required' });
  }

  try {
    // Build context from database
    const chatContext = await buildChatContext(projectPath);

    const reply = await chat(message, {
      ...chatContext,
      additionalContext: context
    });

    logger.info('Chat response', {
      messagePreview: message.slice(0, 50),
      replyPreview: reply.slice(0, 50)
    });

    res.json({
      success: true,
      reply,
      from: 'susan'
    });
  } catch (err) {
    logger.error('Chat failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * Build context for chat from database
 */
async function buildChatContext(projectPath) {
  // Get knowledge base
  let knowledgeQuery = from('dev_ai_knowledge')
    .select('category, title, summary')
    .order('importance', { ascending: false })
    .limit(10);

  if (projectPath) {
    knowledgeQuery = knowledgeQuery.or(`project_id.eq.${projectPath},project_id.is.null`);
  }

  const { data: knowledge } = await knowledgeQuery;

  // Get recent decisions
  let decisionsQuery = from('dev_ai_decisions')
    .select('title, decision, rationale')
    .order('created_at', { ascending: false })
    .limit(5);

  if (projectPath) {
    decisionsQuery = decisionsQuery.eq('project_id', projectPath);
  }

  const { data: decisions } = await decisionsQuery;

  // Get schemas
  const { data: schemas } = await from('dev_ai_schemas')
    .select('database_name, table_name, description')
    .limit(20);

  // Get todos
  const { data: todos } = await from('dev_ai_todos')
    .select('title, description, priority, status, project_id')
    .in('status', ['pending', 'in_progress'])
    .order('priority', { ascending: true })
    .limit(10);

  // Get projects
  const { data: projects } = await from('dev_projects')
    .select('name, slug, description, server_path, port_dev')
    .eq('is_active', true)
    .limit(10);

  // Get recent sessions
  const { data: sessions } = await from('dev_ai_sessions')
    .select('project_id, summary, started_at, status')
    .order('started_at', { ascending: false })
    .limit(5);

  // Get port assignments
  const { data: ports } = await from('dev_port_assignments')
    .select('port, service_name, description')
    .order('port', { ascending: true })
    .limit(20);

  // Build context strings
  const knowledgeContext = knowledge?.length > 0
    ? `Knowledge I've cataloged:\n${knowledge.map(k =>
        `- [${k.category}] ${k.title}: ${k.summary?.slice(0, 100) || ''}`
      ).join('\n')}`
    : '';

  const decisionContext = decisions?.length > 0
    ? `Recent decisions:\n${decisions.map(d =>
        `- ${d.title}: ${d.decision}`
      ).join('\n')}`
    : '';

  const schemaContext = schemas?.length > 0
    ? `Database tables:\n${schemas.map(s =>
        `- ${s.database_name}.${s.table_name}: ${s.description || 'No description'}`
      ).join('\n')}`
    : '';

  const todoContext = todos?.length > 0
    ? `Active todos:\n${todos.map(t =>
        `- [${t.priority}] ${t.title} (${t.status})`
      ).join('\n')}`
    : '';

  const projectContext = projects?.length > 0
    ? `Projects I know about:\n${projects.map(p =>
        `- ${p.name} (${p.slug}): ${p.description || 'No description'} - Port ${p.port_dev}`
      ).join('\n')}`
    : '';

  const sessionContext = sessions?.length > 0
    ? `Recent Claude sessions:\n${sessions.map(s =>
        `- ${s.project_id}: ${s.summary || 'No summary'} (${s.status})`
      ).join('\n')}`
    : '';

  const portContext = ports?.length > 0
    ? `Port assignments:\n${ports.map(p =>
        `- ${p.port}: ${p.service_name} - ${p.description || ''}`
      ).join('\n')}`
    : '';

  // Team info - always include this
  const teamContext = `
AI Team at Kodiack Studios:
- Claude: Lead Programmer - he's the one who actually writes code in the terminal
- Chad: Developer's Assistant - he watches Claude's sessions and transcribes everything
- Susan: Developer's Librarian - that's me! I organize all the knowledge and help you find things
- Jen: Extraction Specialist - she processes all the raw transcripts and extracts knowledge
- Dev Studio: The dashboard where you interact with us`;

  return {
    knowledgeContext: [teamContext, projectContext, sessionContext, knowledgeContext, todoContext, decisionContext, schemaContext, portContext].filter(Boolean).join('\n\n'),
    decisionContext: '',
    schemaContext: ''
  };
}

module.exports = router;

// ========================================
// REVIEW QUEUE ROUTES - DISABLED
// knowledgeClassifier removed - Jen handles classification now
// ========================================

/**
 * GET /api/chat/pending-questions - Get questions Susan needs to ask
 * DISABLED - Jen handles classification now
 */
router.get('/pending-questions', async (req, res) => {
  res.json({
    success: true,
    count: 0,
    questions: [],
    note: 'Classification handled by Jen now'
  });
});

/**
 * POST /api/chat/answer-question - User answers Susan's question
 * DISABLED - Jen handles classification now
 */
router.post('/answer-question', async (req, res) => {
  res.json({
    success: false,
    error: 'Classification handled by Jen now'
  });
});

/**
 * GET /api/chat/has-questions - Quick check if Susan has questions
 * DISABLED - Jen handles classification now
 */
router.get('/has-questions', async (req, res) => {
  res.json({ hasQuestions: false });
});

/**
 * POST /api/chat/ask - Susan proactively asks in the chat
 * DISABLED - Jen handles classification now
 */
router.post('/ask', async (req, res) => {
  res.json({
    success: true,
    hasQuestion: false,
    message: null
  });
});

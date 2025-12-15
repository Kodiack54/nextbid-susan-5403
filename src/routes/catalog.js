/**
 * Susan Catalog Routes
 * Receives extracted knowledge from Chad and stores/updates all relevant tables
 */

const express = require('express');
const router = express.Router();
const { from } = require('../lib/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:Catalog');

/**
 * POST /api/catalog - Receive and process extracted knowledge from Chad
 *
 * Body: {
 *   sessionId: string,
 *   projectPath: string,
 *   extraction: {
 *     todos: [{ title, description, priority }],
 *     completedTodos: [{ title }],
 *     decisions: [{ title, rationale }],
 *     knowledge: [{ category, title, summary }],
 *     codeChanges: [{ file, action, summary }]
 *   },
 *   catalogedAt: string
 * }
 */
router.post('/catalog', async (req, res) => {
  const { sessionId, projectPath, extraction, catalogedAt } = req.body;

  if (!extraction) {
    return res.status(400).json({ error: 'extraction required' });
  }

  logger.info('Catalog received', {
    sessionId,
    projectPath,
    todos: extraction.todos?.length || 0,
    completedTodos: extraction.completedTodos?.length || 0,
    knowledge: extraction.knowledge?.length || 0
  });

  const results = {
    todosAdded: 0,
    todosCompleted: 0,
    decisionsAdded: 0,
    knowledgeAdded: 0,
    codeChangesLogged: 0,
    errors: []
  };

  try {
    // 1. Process new todos
    if (extraction.todos?.length > 0) {
      for (const todo of extraction.todos) {
        try {
          // Check if similar todo already exists
          const { data: existing } = await from('dev_ai_todos')
            .select('id')
            .eq('project_path', projectPath)
            .ilike('title', `%${todo.title.slice(0, 50)}%`)
            .limit(1);

          if (!existing || existing.length === 0) {
            await from('dev_ai_todos').insert({
              project_path: projectPath,
              title: todo.title,
              description: todo.description || null,
              priority: todo.priority || 'medium',
              status: 'pending',
              source_session_id: sessionId,
              category: 'extracted'
            });
            results.todosAdded++;
          }
        } catch (err) {
          results.errors.push(`Todo add failed: ${err.message}`);
        }
      }
    }

    // 2. Mark completed todos
    if (extraction.completedTodos?.length > 0) {
      for (const completed of extraction.completedTodos) {
        try {
          // Find matching pending todo
          const { data: matchingTodo } = await from('dev_ai_todos')
            .select('id')
            .eq('project_path', projectPath)
            .in('status', ['pending', 'in_progress'])
            .ilike('title', `%${completed.title.slice(0, 30)}%`)
            .limit(1);

          if (matchingTodo && matchingTodo.length > 0) {
            await from('dev_ai_todos')
              .update({
                status: 'completed',
                completed_at: new Date().toISOString(),
                completed_session_id: sessionId
              })
              .eq('id', matchingTodo[0].id);
            results.todosCompleted++;
          }
        } catch (err) {
          results.errors.push(`Todo complete failed: ${err.message}`);
        }
      }
    }

    // 3. Store decisions
    if (extraction.decisions?.length > 0) {
      for (const decision of extraction.decisions) {
        try {
          await from('dev_ai_decisions').insert({
            project_path: projectPath,
            title: decision.title,
            decision: decision.title,
            rationale: decision.rationale || null,
            session_id: sessionId
          });
          results.decisionsAdded++;
        } catch (err) {
          results.errors.push(`Decision add failed: ${err.message}`);
        }
      }
    }

    // 4. Store knowledge
    if (extraction.knowledge?.length > 0) {
      for (const item of extraction.knowledge) {
        try {
          // Check for duplicate
          const { data: existing } = await from('dev_ai_knowledge')
            .select('id')
            .eq('project_path', projectPath)
            .ilike('title', `%${item.title.slice(0, 50)}%`)
            .limit(1);

          if (!existing || existing.length === 0) {
            await from('dev_ai_knowledge').insert({
              project_path: projectPath,
              category: item.category || 'general',
              title: item.title,
              summary: item.summary,
              importance: getCategoryImportance(item.category),
              session_id: sessionId
            });
            results.knowledgeAdded++;
          }
        } catch (err) {
          results.errors.push(`Knowledge add failed: ${err.message}`);
        }
      }
    }

    // 5. Log code changes
    if (extraction.codeChanges?.length > 0) {
      for (const change of extraction.codeChanges) {
        try {
          await from('dev_ai_code_changes').insert({
            project_path: projectPath,
            file_path: change.file,
            action: change.action,
            summary: change.summary,
            session_id: sessionId
          });
          results.codeChangesLogged++;
        } catch (err) {
          // Table might not exist yet - that's ok
          logger.warn('Code change log failed', { error: err.message });
        }
      }
    }

    logger.info('Catalog processed', {
      sessionId,
      projectPath,
      results
    });

    res.json({
      success: true,
      ...results
    });

  } catch (err) {
    logger.error('Catalog processing failed', { error: err.message, sessionId });
    res.status(500).json({ error: err.message, partialResults: results });
  }
});

/**
 * Get importance level based on category
 */
function getCategoryImportance(category) {
  const importanceMap = {
    'bug': 9,
    'architecture': 8,
    'api': 7,
    'feature': 6,
    'code': 5,
    'general': 3
  };
  return importanceMap[category] || 5;
}

/**
 * POST /api/summarize - Summarize a completed session
 * Called by Chad when a session ends
 */
router.post('/summarize', async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId required' });
  }

  try {
    // Get session messages
    const { data: messages } = await from('dev_ai_messages')
      .select('role, content')
      .eq('session_id', sessionId)
      .order('sequence_num', { ascending: true });

    if (!messages || messages.length === 0) {
      return res.json({ success: true, summary: 'Empty session' });
    }

    // Build a simple summary
    const userMessages = messages.filter(m => m.role === 'user');
    const assistantMessages = messages.filter(m => m.role === 'assistant');

    const summary = `Session with ${messages.length} messages. ` +
      `User sent ${userMessages.length} messages. ` +
      `Assistant responded ${assistantMessages.length} times.`;

    // Update session with summary
    await from('dev_ai_sessions')
      .update({ summary })
      .eq('id', sessionId);

    logger.info('Session summarized', { sessionId, messageCount: messages.length });

    res.json({ success: true, summary });
  } catch (err) {
    logger.error('Session summarize failed', { error: err.message, sessionId });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

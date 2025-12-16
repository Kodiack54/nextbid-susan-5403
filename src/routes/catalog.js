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
 * Resolve targetProject name to project_path
 * Tries to match project names from dev_projects table
 */
async function resolveProjectPath(targetProject, defaultPath) {
  if (!targetProject) return defaultPath;

  try {
    // Try to find matching project by name (case-insensitive partial match)
    const { data: projects } = await from('dev_projects')
      .select('server_path, name, slug')
      .or(`name.ilike.%${targetProject}%,slug.ilike.%${targetProject}%`)
      .limit(1);

    if (projects && projects.length > 0) {
      logger.info('Resolved targetProject', {
        targetProject,
        resolvedPath: projects[0].server_path
      });
      return projects[0].server_path;
    }
  } catch (err) {
    logger.warn('Failed to resolve targetProject', { error: err.message, targetProject });
  }

  // If can't resolve, use the target project as-is (might be a path already)
  return targetProject.includes('/') ? targetProject : defaultPath;
}

/**
 * POST /api/catalog - Receive and process extracted knowledge from Chad
 * COMPREHENSIVE CATALOGING - Handles all extraction categories
 *
 * Body: {
 *   sessionId: string,
 *   projectPath: string,
 *   extraction: {
 *     todos: [{ title, description, priority, status, assignedTo, targetProject }],
 *     completedTodos: [{ title, completedBy, targetProject }],
 *     commits: [{ hash, message, author, filesChanged, buildNumber }],
 *     codeChanges: [{ file, action, summary, linesAdded, linesRemoved }],
 *     structureChanges: [{ path, name, type, action, purpose, notes }],
 *     schemaChanges: [{ table, action, columns, description }],
 *     bugs: [{ title, severity, file, stepsToReproduce, status, fixedBy }],
 *     decisions: [{ title, rationale, alternatives, impact, targetProject }],
 *     knowledge: [{ category, title, summary, importance, relatedFiles, targetProject }],
 *     apis: [{ endpoint, method, description, parameters, response }],
 *     ports: [{ port, service, description }],
 *     dependencies: [{ package, action, version, reason }],
 *     configChanges: [{ file, setting, oldValue, newValue, reason }],
 *     documentation: [{ type, file, title, summary }],
 *     errors: [{ error, cause, solution, file }],
 *     buildInfo: { buildNumber, version, deployedTo, status },
 *     projectMentions: [{ project, context, action }]
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
    commits: extraction.commits?.length || 0,
    bugs: extraction.bugs?.length || 0,
    knowledge: extraction.knowledge?.length || 0
  });

  const results = {
    todosAdded: 0,
    todosCompleted: 0,
    commitsLogged: 0,
    codeChangesLogged: 0,
    structureChangesLogged: 0,
    schemaChangesLogged: 0,
    bugsLogged: 0,
    decisionsAdded: 0,
    knowledgeAdded: 0,
    apisLogged: 0,
    portsLogged: 0,
    dependenciesLogged: 0,
    configChangesLogged: 0,
    documentationLogged: 0,
    errorsLogged: 0,
    buildInfoUpdated: false,
    errors: []
  };

  try {
    // 1. Process new todos (with cross-project routing)
    if (extraction.todos?.length > 0) {
      for (const todo of extraction.todos) {
        try {
          // Resolve target project if user mentioned a different one
          const targetPath = await resolveProjectPath(todo.targetProject, projectPath);

          // Check if similar todo already exists
          const { data: existing } = await from('dev_ai_todos')
            .select('id')
            .eq('project_path', targetPath)
            .ilike('title', `%${todo.title.slice(0, 50)}%`)
            .limit(1);

          if (!existing || existing.length === 0) {
            await from('dev_ai_todos').insert({
              project_path: targetPath,
              title: todo.title,
              description: todo.description || null,
              priority: todo.priority || 'medium',
              status: 'pending',
              source_session_id: sessionId,
              category: todo.targetProject ? 'cross-project' : 'extracted'
            });
            results.todosAdded++;
            if (todo.targetProject) {
              logger.info('Cross-project todo', { from: projectPath, to: targetPath, title: todo.title });
            }
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
            lines_added: change.linesAdded || 0,
            lines_removed: change.linesRemoved || 0,
            session_id: sessionId
          });
          results.codeChangesLogged++;
        } catch (err) {
          // Table might not exist yet - that's ok
          logger.warn('Code change log failed', { error: err.message });
        }
      }
    }

    // 6. Log commits
    if (extraction.commits?.length > 0) {
      for (const commit of extraction.commits) {
        try {
          await from('dev_ai_commits').insert({
            project_path: projectPath,
            commit_hash: commit.hash || null,
            message: commit.message,
            author: commit.author || 'unknown',
            files_changed: commit.filesChanged || [],
            build_number: commit.buildNumber || null,
            session_id: sessionId
          });
          results.commitsLogged++;
        } catch (err) {
          // Store as knowledge if commits table doesn't exist
          try {
            await from('dev_ai_knowledge').insert({
              project_path: projectPath,
              category: 'commit',
              title: `Commit: ${commit.message?.slice(0, 50) || 'Unknown'}`,
              summary: JSON.stringify(commit),
              importance: 6,
              session_id: sessionId
            });
            results.commitsLogged++;
          } catch (innerErr) {
            results.errors.push(`Commit log failed: ${err.message}`);
          }
        }
      }
    }

    // 7. Log structure changes (files/folders created, deleted, etc.)
    if (extraction.structureChanges?.length > 0) {
      for (const change of extraction.structureChanges) {
        try {
          // Upsert into structure_items table
          const { data: existing } = await from('dev_ai_structure_items')
            .select('id')
            .eq('project_path', projectPath)
            .eq('path', change.path)
            .limit(1);

          if (existing && existing.length > 0) {
            // Update existing
            await from('dev_ai_structure_items')
              .update({
                name: change.name,
                type: change.type || 'file',
                status: change.action === 'deleted' ? 'abandoned' :
                        change.action === 'deprecated' ? 'deprecated' : 'active',
                purpose: change.purpose,
                notes: change.notes,
                updated_at: new Date().toISOString()
              })
              .eq('id', existing[0].id);
          } else if (change.action !== 'deleted') {
            // Insert new (unless it was deleted)
            await from('dev_ai_structure_items').insert({
              project_path: projectPath,
              path: change.path,
              name: change.name,
              type: change.type || 'file',
              status: 'active',
              purpose: change.purpose,
              notes: change.notes
            });
          }
          results.structureChangesLogged++;
        } catch (err) {
          results.errors.push(`Structure change failed: ${err.message}`);
        }
      }
    }

    // 8. Log schema changes
    if (extraction.schemaChanges?.length > 0) {
      for (const schema of extraction.schemaChanges) {
        try {
          await from('dev_ai_schema_changes').insert({
            project_path: projectPath,
            table_name: schema.table,
            action: schema.action,
            columns: schema.columns || [],
            description: schema.description,
            session_id: sessionId
          });
          results.schemaChangesLogged++;
        } catch (err) {
          // Store as knowledge if table doesn't exist
          try {
            await from('dev_ai_knowledge').insert({
              project_path: projectPath,
              category: 'database',
              title: `Schema: ${schema.action} ${schema.table}`,
              summary: schema.description || JSON.stringify(schema),
              importance: 8,
              session_id: sessionId
            });
            results.schemaChangesLogged++;
          } catch (innerErr) {
            results.errors.push(`Schema change log failed: ${err.message}`);
          }
        }
      }
    }

    // 9. Log bugs
    if (extraction.bugs?.length > 0) {
      for (const bug of extraction.bugs) {
        try {
          // Check for existing similar bug
          const { data: existing } = await from('dev_ai_bugs')
            .select('id')
            .eq('project_path', projectPath)
            .ilike('title', `%${bug.title.slice(0, 30)}%`)
            .limit(1);

          if (!existing || existing.length === 0) {
            await from('dev_ai_bugs').insert({
              project_path: projectPath,
              title: bug.title,
              severity: bug.severity || 'medium',
              status: bug.status || 'open',
              related_file: bug.file,
              steps_to_reproduce: bug.stepsToReproduce,
              reported_by: 'chad',
              fix_session_id: bug.status === 'fixed' ? sessionId : null
            });
            results.bugsLogged++;
          } else if (bug.status === 'fixed') {
            // Update existing bug as fixed
            await from('dev_ai_bugs')
              .update({
                status: 'fixed',
                resolved_at: new Date().toISOString(),
                fix_session_id: sessionId
              })
              .eq('id', existing[0].id);
            results.bugsLogged++;
          }
        } catch (err) {
          results.errors.push(`Bug log failed: ${err.message}`);
        }
      }
    }

    // 10. Log APIs
    if (extraction.apis?.length > 0) {
      for (const api of extraction.apis) {
        try {
          await from('dev_ai_knowledge').insert({
            project_path: projectPath,
            category: 'api',
            title: `${api.method} ${api.endpoint}`,
            summary: JSON.stringify({
              description: api.description,
              parameters: api.parameters,
              response: api.response
            }),
            importance: 7,
            session_id: sessionId
          });
          results.apisLogged++;
        } catch (err) {
          results.errors.push(`API log failed: ${err.message}`);
        }
      }
    }

    // 11. Log ports
    if (extraction.ports?.length > 0) {
      for (const portInfo of extraction.ports) {
        try {
          await from('dev_ai_knowledge').insert({
            project_path: projectPath,
            category: 'port',
            title: `Port ${portInfo.port}: ${portInfo.service}`,
            summary: portInfo.description || `${portInfo.service} runs on port ${portInfo.port}`,
            importance: 6,
            session_id: sessionId
          });
          results.portsLogged++;
        } catch (err) {
          results.errors.push(`Port log failed: ${err.message}`);
        }
      }
    }

    // 12. Log dependencies
    if (extraction.dependencies?.length > 0) {
      for (const dep of extraction.dependencies) {
        try {
          await from('dev_ai_knowledge').insert({
            project_path: projectPath,
            category: 'dependency',
            title: `${dep.action} ${dep.package}${dep.version ? '@' + dep.version : ''}`,
            summary: dep.reason || `Package ${dep.package} was ${dep.action}`,
            importance: 5,
            session_id: sessionId
          });
          results.dependenciesLogged++;
        } catch (err) {
          results.errors.push(`Dependency log failed: ${err.message}`);
        }
      }
    }

    // 13. Log config changes
    if (extraction.configChanges?.length > 0) {
      for (const config of extraction.configChanges) {
        try {
          await from('dev_ai_knowledge').insert({
            project_path: projectPath,
            category: 'config',
            title: `Config: ${config.setting} in ${config.file}`,
            summary: JSON.stringify({
              file: config.file,
              setting: config.setting,
              oldValue: config.oldValue,
              newValue: config.newValue,
              reason: config.reason
            }),
            importance: 6,
            session_id: sessionId
          });
          results.configChangesLogged++;
        } catch (err) {
          results.errors.push(`Config change log failed: ${err.message}`);
        }
      }
    }

    // 14. Log documentation
    if (extraction.documentation?.length > 0) {
      for (const doc of extraction.documentation) {
        try {
          // Check for existing doc
          const { data: existing } = await from('dev_ai_docs')
            .select('id')
            .eq('project_path', projectPath)
            .ilike('title', `%${doc.title.slice(0, 30)}%`)
            .limit(1);

          if (!existing || existing.length === 0) {
            await from('dev_ai_docs').insert({
              project_path: projectPath,
              title: doc.title,
              content: doc.summary,
              doc_type: doc.type || 'general',
              file_path: doc.file,
              session_id: sessionId
            });
            results.documentationLogged++;
          }
        } catch (err) {
          results.errors.push(`Documentation log failed: ${err.message}`);
        }
      }
    }

    // 15. Log errors (solutions for future reference)
    if (extraction.errors?.length > 0) {
      for (const error of extraction.errors) {
        try {
          await from('dev_ai_knowledge').insert({
            project_path: projectPath,
            category: 'error',
            title: `Error: ${error.error.slice(0, 100)}`,
            summary: JSON.stringify({
              error: error.error,
              cause: error.cause,
              solution: error.solution,
              file: error.file
            }),
            importance: 8,
            session_id: sessionId
          });
          results.errorsLogged++;
        } catch (err) {
          results.errors.push(`Error log failed: ${err.message}`);
        }
      }
    }

    // 16. Update build info on project
    if (extraction.buildInfo && (extraction.buildInfo.buildNumber || extraction.buildInfo.version)) {
      try {
        const updates = {};
        if (extraction.buildInfo.buildNumber) updates.build_number = extraction.buildInfo.buildNumber;
        if (extraction.buildInfo.version) updates.version = extraction.buildInfo.version;

        await from('dev_projects')
          .update(updates)
          .eq('server_path', projectPath);

        // Also log as knowledge
        await from('dev_ai_knowledge').insert({
          project_path: projectPath,
          category: 'build',
          title: `Build ${extraction.buildInfo.buildNumber || extraction.buildInfo.version}`,
          summary: JSON.stringify(extraction.buildInfo),
          importance: 5,
          session_id: sessionId
        });

        results.buildInfoUpdated = true;
      } catch (err) {
        results.errors.push(`Build info update failed: ${err.message}`);
      }
    }

    // 17. Log project mentions (for cross-project awareness)
    if (extraction.projectMentions?.length > 0) {
      for (const mention of extraction.projectMentions) {
        try {
          await from('dev_ai_knowledge').insert({
            project_path: projectPath,
            category: 'project-mention',
            title: `Mentioned: ${mention.project}`,
            summary: JSON.stringify({
              project: mention.project,
              context: mention.context,
              action: mention.action
            }),
            importance: 4,
            session_id: sessionId
          });
        } catch (err) {
          // Non-critical, don't add to errors
          logger.warn('Project mention log failed', { error: err.message });
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

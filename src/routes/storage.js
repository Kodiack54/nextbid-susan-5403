/**
 * Susan Storage Routes
 * Monitor storage usage and flag stale data for dev approval
 *
 * IMPORTANT: Susan can ADD and EDIT but NEVER DELETES without explicit dev approval
 */

const express = require('express');
const router = express.Router();
const { from, storage } = require('../lib/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:Storage');

// Default retention periods (in days)
const RETENTION = {
  sessions: 30,      // Keep sessions for 30 days
  messages: 30,      // Keep messages for 30 days
  knowledge: 90,     // Keep knowledge for 90 days
  decisions: 180,    // Keep decisions for 180 days
  docs: 365,         // Keep docs for 1 year
  todos: 90,         // Keep completed todos for 90 days
  structures: 365    // Keep structures for 1 year
};

/**
 * GET /api/storage/stats - Get storage statistics
 */
router.get('/storage/stats', async (req, res) => {
  try {
    const stats = {
      tables: {},
      totals: { rows: 0, stale: 0, flagged: 0 },
      recommendations: [],
      pendingApprovals: []
    };

    // Get counts for each table
    const tables = [
      { name: 'dev_ai_sessions', retention: RETENTION.sessions },
      { name: 'dev_ai_messages', retention: RETENTION.messages },
      { name: 'dev_ai_knowledge', retention: RETENTION.knowledge },
      { name: 'dev_ai_decisions', retention: RETENTION.decisions },
      { name: 'dev_ai_schemas', retention: null }, // Don't auto-purge schemas
      { name: 'dev_ai_docs', retention: RETENTION.docs },
      { name: 'dev_ai_todos', retention: RETENTION.todos },
      { name: 'dev_ai_structures', retention: RETENTION.structures }
    ];

    for (const table of tables) {
      try {
        // Total count
        const { count: totalCount } = await from(table.name)
          .select('*', { count: 'exact', head: true });

        // Stale count (older than retention period)
        let staleCount = 0;
        if (table.retention) {
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - table.retention);

          const { count } = await from(table.name)
            .select('*', { count: 'exact', head: true })
            .lt('created_at', cutoffDate.toISOString());

          staleCount = count || 0;
        }

        stats.tables[table.name] = {
          total: totalCount || 0,
          stale: staleCount,
          retentionDays: table.retention
        };

        stats.totals.rows += totalCount || 0;
        stats.totals.stale += staleCount;

        // Add recommendation if stale data exists
        if (staleCount > 0) {
          stats.recommendations.push({
            table: table.name,
            action: 'flag_for_purge',
            count: staleCount,
            reason: `${staleCount} records older than ${table.retention} days`,
            requiresApproval: true
          });
        }
      } catch (err) {
        // Table might not exist yet
        stats.tables[table.name] = { total: 0, stale: 0, error: err.message };
      }
    }

    // Get pending purge requests
    try {
      const { data: pendingRequests } = await from('dev_ai_purge_requests')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

      if (pendingRequests && pendingRequests.length > 0) {
        stats.pendingApprovals = pendingRequests;
        stats.totals.flagged = pendingRequests.length;
      }
    } catch (err) {
      // Table might not exist yet - that's ok
    }

    logger.info('Storage stats calculated', {
      totalRows: stats.totals.rows,
      staleRows: stats.totals.stale,
      flaggedForPurge: stats.totals.flagged,
      recommendations: stats.recommendations.length
    });

    res.json(stats);
  } catch (err) {
    logger.error('Storage stats failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/storage/flag-for-purge - Flag stale data for dev approval (does NOT delete)
 * Susan uses this to recommend cleanup - dev must approve
 */
router.post('/storage/flag-for-purge', async (req, res) => {
  const { tables, project_id, reason } = req.body;

  try {
    const flaggedItems = [];
    const tablesToFlag = tables || ['dev_ai_sessions', 'dev_ai_messages', 'dev_ai_knowledge'];

    for (const tableName of tablesToFlag) {
      const retention = RETENTION[tableName.replace('dev_ai_', '')] || 30;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retention);

      // Get stale records (but don't delete!)
      const { data: staleRecords, count } = await from(tableName)
        .select('id, created_at', { count: 'exact' })
        .lt('created_at', cutoffDate.toISOString())
        .limit(1000);

      if (staleRecords && staleRecords.length > 0) {
        // Create a purge request for dev approval
        const { data: request, error } = await from('dev_ai_purge_requests')
          .insert({
            table_name: tableName,
            record_count: count || staleRecords.length,
            record_ids: staleRecords.map(r => r.id),
            cutoff_date: cutoffDate.toISOString(),
            reason: reason || `Records older than ${retention} days`,
            project_id: project_id || null,
            status: 'pending',
            flagged_by: 'susan',
            created_at: new Date().toISOString()
          })
          .select()
          .single();

        if (error) throw error;

        flaggedItems.push({
          table: tableName,
          count: count || staleRecords.length,
          requestId: request.id,
          status: 'pending_approval'
        });

        logger.info('Flagged stale data for approval', {
          table: tableName,
          count: count || staleRecords.length,
          requestId: request.id
        });
      }
    }

    res.json({
      message: 'Items flagged for purge - awaiting dev approval',
      flagged: flaggedItems,
      totalFlagged: flaggedItems.reduce((sum, item) => sum + item.count, 0),
      nextStep: 'Dev must call POST /api/storage/approve-purge with request IDs'
    });
  } catch (err) {
    logger.error('Flag for purge failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/storage/pending-purges - Get all pending purge requests
 */
router.get('/storage/pending-purges', async (req, res) => {
  const { project_id } = req.query;

  try {
    let query = from('dev_ai_purge_requests')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (project_id) {
      query = query.eq('project_id', project_id);
    }

    const { data: requests, error } = await query;
    if (error) throw error;

    res.json({
      pending: requests || [],
      count: requests?.length || 0,
      message: requests?.length > 0
        ? 'Review and approve these purge requests'
        : 'No pending purge requests'
    });
  } catch (err) {
    logger.error('Get pending purges failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/storage/approve-purge - Dev approves purge request (ONLY endpoint that can delete)
 * Requires explicit dev_id to track who approved
 */
router.post('/storage/approve-purge', async (req, res) => {
  const { request_id, dev_id, approve = true } = req.body;

  if (!request_id) {
    return res.status(400).json({ error: 'request_id is required' });
  }

  if (!dev_id) {
    return res.status(400).json({ error: 'dev_id is required - must know who is approving' });
  }

  try {
    // Get the purge request
    const { data: request, error: fetchError } = await from('dev_ai_purge_requests')
      .select('*')
      .eq('id', request_id)
      .single();

    if (fetchError || !request) {
      return res.status(404).json({ error: 'Purge request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: `Request already ${request.status}` });
    }

    if (!approve) {
      // Dev rejected the purge
      await from('dev_ai_purge_requests')
        .update({
          status: 'rejected',
          reviewed_by: dev_id,
          reviewed_at: new Date().toISOString()
        })
        .eq('id', request_id);

      logger.info('Purge request rejected', { requestId: request_id, dev_id });
      return res.json({ message: 'Purge request rejected', requestId: request_id });
    }

    // Dev approved - NOW we can delete
    const { error: deleteError } = await from(request.table_name)
      .delete()
      .in('id', request.record_ids);

    if (deleteError) throw deleteError;

    // Update request status
    await from('dev_ai_purge_requests')
      .update({
        status: 'approved',
        reviewed_by: dev_id,
        reviewed_at: new Date().toISOString(),
        executed_at: new Date().toISOString()
      })
      .eq('id', request_id);

    logger.info('Purge approved and executed', {
      requestId: request_id,
      table: request.table_name,
      deleted: request.record_count,
      approvedBy: dev_id
    });

    res.json({
      message: 'Purge approved and executed',
      requestId: request_id,
      table: request.table_name,
      deleted: request.record_count,
      approvedBy: dev_id
    });
  } catch (err) {
    logger.error('Approve purge failed', { error: err.message, request_id });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/storage/bulk-approve - Approve multiple purge requests at once
 */
router.post('/storage/bulk-approve', async (req, res) => {
  const { request_ids, dev_id, approve = true } = req.body;

  if (!request_ids || !Array.isArray(request_ids) || request_ids.length === 0) {
    return res.status(400).json({ error: 'request_ids array is required' });
  }

  if (!dev_id) {
    return res.status(400).json({ error: 'dev_id is required - must know who is approving' });
  }

  const results = [];
  for (const request_id of request_ids) {
    try {
      const { data: request } = await from('dev_ai_purge_requests')
        .select('*')
        .eq('id', request_id)
        .single();

      if (!request || request.status !== 'pending') {
        results.push({ request_id, status: 'skipped', reason: 'Not found or not pending' });
        continue;
      }

      if (approve) {
        await from(request.table_name)
          .delete()
          .in('id', request.record_ids);

        await from('dev_ai_purge_requests')
          .update({
            status: 'approved',
            reviewed_by: dev_id,
            reviewed_at: new Date().toISOString(),
            executed_at: new Date().toISOString()
          })
          .eq('id', request_id);

        results.push({ request_id, status: 'approved', deleted: request.record_count });
      } else {
        await from('dev_ai_purge_requests')
          .update({
            status: 'rejected',
            reviewed_by: dev_id,
            reviewed_at: new Date().toISOString()
          })
          .eq('id', request_id);

        results.push({ request_id, status: 'rejected' });
      }
    } catch (err) {
      results.push({ request_id, status: 'error', error: err.message });
    }
  }

  logger.info('Bulk purge processed', { dev_id, results });
  res.json({ results, processedBy: dev_id });
});

/**
 * GET /api/storage/old - Get oldest records by table (for review)
 */
router.get('/storage/old', async (req, res) => {
  const { table, limit = 10 } = req.query;

  if (!table) {
    return res.status(400).json({ error: 'Table parameter required' });
  }

  try {
    const { data, error } = await from(table)
      .select('id, created_at')
      .order('created_at', { ascending: true })
      .limit(parseInt(limit));

    if (error) throw error;

    res.json({
      table,
      oldestRecords: data || [],
      count: data?.length || 0
    });
  } catch (err) {
    logger.error('Get old records failed', { error: err.message, table });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/storage/retention - Get retention settings
 */
router.get('/storage/retention', (req, res) => {
  res.json(RETENTION);
});

/**
 * GET /api/storage/purge-history - Get history of approved/rejected purges
 */
router.get('/storage/purge-history', async (req, res) => {
  const { limit = 50 } = req.query;

  try {
    const { data: history, error } = await from('dev_ai_purge_requests')
      .select('*')
      .neq('status', 'pending')
      .order('reviewed_at', { ascending: false })
      .limit(parseInt(limit));

    if (error) throw error;

    res.json({
      history: history || [],
      count: history?.length || 0
    });
  } catch (err) {
    logger.error('Get purge history failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

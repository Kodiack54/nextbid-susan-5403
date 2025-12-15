/**
 * Susan Tables Routes
 * Database table listing and column info
 */

const express = require('express');
const router = express.Router();
const { from, getClient } = require('../lib/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:Tables');

/**
 * GET /api/tables - Get list of database tables
 */
router.get('/tables', async (req, res) => {
  const { prefix } = req.query;

  try {
    // Query information_schema for tables
    const client = getClient();
    let query = client.rpc('get_table_info');

    const { data, error } = await query;

    if (error) {
      // Fallback to simple query if RPC doesn't exist
      const { data: fallbackData, error: fallbackError } = await client
        .from('dev_ai_schemas')
        .select('table_name')
        .order('table_name');

      if (fallbackError) throw fallbackError;

      // Get unique table names
      const tables = [...new Set(fallbackData?.map(s => s.table_name) || [])];
      const result = tables
        .filter(t => !prefix || t.startsWith(prefix))
        .map(t => ({ table_name: t }));

      return res.json({ success: true, tables: result });
    }

    // Filter by prefix if provided
    let tables = data || [];
    if (prefix) {
      tables = tables.filter(t => t.table_name.startsWith(prefix));
    }

    res.json({ success: true, tables });
  } catch (err) {
    logger.error('Tables fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/table/:name/columns - Get columns for a specific table
 */
router.get('/table/:name/columns', async (req, res) => {
  const tableName = req.params.name;

  try {
    // Try to get from our cataloged schemas first
    const { data, error } = await from('dev_ai_schemas')
      .select('column_name, data_type, is_nullable, column_default')
      .eq('table_name', tableName)
      .order('ordinal_position', { ascending: true });

    if (error) throw error;

    if (data && data.length > 0) {
      return res.json({ success: true, columns: data });
    }

    // If not in our catalog, return empty
    res.json({ success: true, columns: [], note: 'Table not cataloged yet' });
  } catch (err) {
    logger.error('Columns fetch failed', { error: err.message, table: tableName });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

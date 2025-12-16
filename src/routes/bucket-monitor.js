/**
 * Bucket Monitoring Routes for Susan
 * Monitor Supabase storage buckets for large files and capacity
 */

const express = require('express');
const router = express.Router();
const { from, storage } = require('../lib/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:Bucket');

// Bucket thresholds (4GB per tradeline bucket)
const BUCKET_THRESHOLDS = {
  warningBytes: 3 * 1024 * 1024 * 1024,    // 3GB - 75% warning
  criticalBytes: 3.5 * 1024 * 1024 * 1024, // 3.5GB - 87.5% critical
  maxBytes: 4 * 1024 * 1024 * 1024,        // 4GB max
  largeFileBytes: 100 * 1024 * 1024,       // 100MB - flag large files
  hugeFileBytes: 500 * 1024 * 1024         // 500MB - alert immediately
};

/**
 * GET /api/bucket/stats - Get bucket usage statistics
 */
router.get('/stats', async (req, res) => {
  const { bucket = 'dev-ai-files' } = req.query;

  try {
    const bucketClient = storage(bucket);

    // List all files in bucket
    const { data: files, error } = await bucketClient.list('', {
      limit: 10000,
      sortBy: { column: 'created_at', order: 'desc' }
    });

    if (error) throw error;

    let totalBytes = 0;
    let fileCount = 0;
    let largeFiles = [];
    let hugeFiles = [];

    for (const file of files || []) {
      if (file.metadata && file.metadata.size) {
        const size = file.metadata.size;
        totalBytes += size;
        fileCount++;

        if (size >= BUCKET_THRESHOLDS.hugeFileBytes) {
          hugeFiles.push({ name: file.name, size, created: file.created_at });
        } else if (size >= BUCKET_THRESHOLDS.largeFileBytes) {
          largeFiles.push({ name: file.name, size, created: file.created_at });
        }
      }
    }

    // Determine status
    let status = 'ok';
    let alert = null;

    if (totalBytes >= BUCKET_THRESHOLDS.criticalBytes) {
      status = 'critical';
      alert = 'Bucket at ' + ((totalBytes / BUCKET_THRESHOLDS.maxBytes) * 100).toFixed(1) + '% capacity!';
    } else if (totalBytes >= BUCKET_THRESHOLDS.warningBytes) {
      status = 'warning';
      alert = 'Bucket at ' + ((totalBytes / BUCKET_THRESHOLDS.maxBytes) * 100).toFixed(1) + '% capacity';
    }

    if (hugeFiles.length > 0) {
      status = 'critical';
      alert = hugeFiles.length + ' HUGE files detected (>500MB)!';
    }

    const stats = {
      bucket,
      status,
      alert,
      usage: {
        totalBytes,
        totalMB: (totalBytes / (1024 * 1024)).toFixed(2),
        totalGB: (totalBytes / (1024 * 1024 * 1024)).toFixed(3),
        percentUsed: ((totalBytes / BUCKET_THRESHOLDS.maxBytes) * 100).toFixed(1),
        maxGB: (BUCKET_THRESHOLDS.maxBytes / (1024 * 1024 * 1024)).toFixed(0)
      },
      files: {
        total: fileCount,
        large: largeFiles.length,
        huge: hugeFiles.length
      },
      largeFiles: largeFiles.slice(0, 10),
      hugeFiles,
      thresholds: {
        warningGB: (BUCKET_THRESHOLDS.warningBytes / (1024 * 1024 * 1024)).toFixed(1),
        criticalGB: (BUCKET_THRESHOLDS.criticalBytes / (1024 * 1024 * 1024)).toFixed(1),
        largeFileMB: (BUCKET_THRESHOLDS.largeFileBytes / (1024 * 1024)).toFixed(0),
        hugeFileMB: (BUCKET_THRESHOLDS.hugeFileBytes / (1024 * 1024)).toFixed(0)
      }
    };

    if (status !== 'ok') {
      logger.warn('Bucket storage alert', { bucket, status, alert, usage: stats.usage });
    }

    res.json(stats);
  } catch (err) {
    logger.error('Bucket stats failed', { error: err.message, bucket });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/bucket/large-files - List all large files (>100MB)
 */
router.get('/large-files', async (req, res) => {
  const { bucket = 'dev-ai-files' } = req.query;

  try {
    const bucketClient = storage(bucket);

    const { data: files, error } = await bucketClient.list('', { limit: 10000 });
    if (error) throw error;

    const largeFiles = (files || [])
      .filter(f => f.metadata && f.metadata.size >= BUCKET_THRESHOLDS.largeFileBytes)
      .map(f => ({
        name: f.name,
        sizeMB: (f.metadata.size / (1024 * 1024)).toFixed(2),
        sizeBytes: f.metadata.size,
        created: f.created_at,
        isHuge: f.metadata.size >= BUCKET_THRESHOLDS.hugeFileBytes
      }))
      .sort((a, b) => b.sizeBytes - a.sizeBytes);

    res.json({
      bucket,
      count: largeFiles.length,
      totalMB: largeFiles.reduce((sum, f) => sum + parseFloat(f.sizeMB), 0).toFixed(2),
      files: largeFiles,
      hugeCount: largeFiles.filter(f => f.isHuge).length
    });
  } catch (err) {
    logger.error('Large files scan failed', { error: err.message, bucket });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/bucket/flag-large - Flag large files for review
 */
router.post('/flag-large', async (req, res) => {
  const { bucket = 'dev-ai-files', minSizeMB = 100 } = req.body;

  try {
    const bucketClient = storage(bucket);
    const minBytes = minSizeMB * 1024 * 1024;

    const { data: files, error } = await bucketClient.list('', { limit: 10000 });
    if (error) throw error;

    const largeFiles = (files || [])
      .filter(f => f.metadata && f.metadata.size >= minBytes)
      .map(f => f.name);

    if (largeFiles.length === 0) {
      return res.json({ message: 'No large files found', flagged: 0 });
    }

    // Create purge request for review
    const { data: request, error: insertError } = await from('dev_ai_purge_requests')
      .insert({
        table_name: 'bucket:' + bucket,
        record_count: largeFiles.length,
        record_ids: largeFiles,
        reason: largeFiles.length + ' files over ' + minSizeMB + 'MB in bucket ' + bucket,
        status: 'pending',
        flagged_by: 'susan',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (insertError) throw insertError;

    logger.info('Large files flagged for review', { bucket, count: largeFiles.length, requestId: request.id });

    res.json({
      message: 'Large files flagged for review',
      flagged: largeFiles.length,
      requestId: request.id,
      files: largeFiles.slice(0, 20)
    });
  } catch (err) {
    logger.error('Flag large files failed', { error: err.message, bucket });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

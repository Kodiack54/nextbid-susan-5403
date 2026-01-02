/**
 * Susan Health Routes
 */

const express = require('express');
const router = express.Router();
const config = require('../lib/config');

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'susan-librarian',
    port: config.PORT
  });
});

module.exports = router;

// Manual trigger for Filing Clerk cycle
const processor = require('../services/processor-v2');

router.post('/trigger-cycle', async (req, res) => {
  try {
    console.log('[Susan] Manual cycle triggered');
    const stats = await processor.runCycle();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

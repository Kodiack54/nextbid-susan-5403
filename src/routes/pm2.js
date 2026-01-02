/**
 * PM2 Control Routes - Start/Stop/Restart AI Team services
 * Called by dashboard at 5500
 */

const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

// Map worker names to PM2 process names
const WORKER_MAP = {
  'chad': 'chad-5401',
  'jen': 'ai-jen-5402',
  'susan': 'susan-5403',
  'clair': 'clair-5404',
  'mike': 'mike-5405',
  'tiffany': 'tiffany-5406',
  'ryan': 'ryan-5407',
  'terminal': 'terminal-server-5400',
  'transcripts': 'transcripts-9500'
};

/**
 * POST /api/pm2/start - Start a service
 */
router.post('/start', async (req, res) => {
  const { name } = req.body;
  const pm2Name = WORKER_MAP[name] || name;
  
  try {
    const { stdout } = await execAsync(`pm2 start ${pm2Name}`);
    console.log(`[PM2] Started ${pm2Name}`);
    res.json({ success: true, action: 'start', name: pm2Name, output: stdout });
  } catch (err) {
    console.error(`[PM2] Start failed for ${pm2Name}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/pm2/stop - Stop a service
 */
router.post('/stop', async (req, res) => {
  const { name } = req.body;
  const pm2Name = WORKER_MAP[name] || name;
  
  try {
    const { stdout } = await execAsync(`pm2 stop ${pm2Name}`);
    console.log(`[PM2] Stopped ${pm2Name}`);
    res.json({ success: true, action: 'stop', name: pm2Name, output: stdout });
  } catch (err) {
    console.error(`[PM2] Stop failed for ${pm2Name}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/pm2/restart - Restart a service
 */
router.post('/restart', async (req, res) => {
  const { name } = req.body;
  const pm2Name = WORKER_MAP[name] || name;
  
  try {
    const { stdout } = await execAsync(`pm2 restart ${pm2Name}`);
    console.log(`[PM2] Restarted ${pm2Name}`);
    res.json({ success: true, action: 'restart', name: pm2Name, output: stdout });
  } catch (err) {
    console.error(`[PM2] Restart failed for ${pm2Name}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/pm2/status - Get status of all AI team services
 */
router.get('/status', async (req, res) => {
  try {
    const { stdout } = await execAsync('pm2 jlist');
    const processes = JSON.parse(stdout);
    
    const aiTeam = processes
      .filter(p => Object.values(WORKER_MAP).includes(p.name))
      .map(p => ({
        name: p.name,
        status: p.pm2_env.status,
        cpu: p.monit?.cpu || 0,
        memory: p.monit?.memory || 0,
        uptime: p.pm2_env.pm_uptime,
        restarts: p.pm2_env.restart_time
      }));
    
    res.json({ success: true, processes: aiTeam });
  } catch (err) {
    console.error('[PM2] Status failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/pm2/list - Get all PM2 processes
 */
router.get('/list', async (req, res) => {
  try {
    const { stdout } = await execAsync('pm2 jlist');
    const processes = JSON.parse(stdout);
    res.json({ success: true, processes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

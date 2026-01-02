/**
 * Susan Session Detector
 * DISABLED - Terminal 5400 is not running
 * 
 * Previously monitored for new Claude sessions and auto-triggered /start
 * Now using PC transcript uploader -> transcripts-9500 -> Chad pipeline instead
 */

const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:SessionDetector');

/**
 * Start monitoring for new sessions - DISABLED
 */
function start() {
  logger.info('Session detector DISABLED (terminal 5400 off, using transcript pipeline instead)');
  // Don't connect to terminal server - it's disabled
}

/**
 * Manually trigger /start (can be called from API)
 */
async function triggerStart() {
  logger.info('Manual /start trigger requested - terminal not available');
}

module.exports = {
  start,
  triggerStart
};

/**
 * Susan - AI Librarian
 * Port 5403
 *
 * Catalogs knowledge, organizes conversations, provides Claude with
 * persistent memory across sessions. Tracks documentation, todos, and
 * project structures.
 *
 * Librarian duties:
 * - Catalogs and organizes knowledge
 * - Consolidates duplicates
 * - Archives old sessions to summaries
 * - Maintains project memory
 */

require('dotenv').config({ path: __dirname + '/.env' });
const { Logger } = require('./src/lib/logger');

const logger = new Logger('Susan');

async function start() {
  logger.info('Starting Susan Librarian...');

  const config = require('./src/lib/config');
  logger.info('Config loaded', { port: config.PORT, chadUrl: config.CHAD_URL });

  const knowledgeService = require('./src/services/knowledgeService');
  await knowledgeService.initialize();
  logger.info('Knowledge service initialized');

  const cleanerService = require('./src/services/cleanerService');
  cleanerService.start();

  const cleanTranscriptService = require('./src/services/cleanTranscriptService');
  cleanTranscriptService.start();
  logger.info('Clean transcript service started (5 min cycle)');
  logger.info('Cleaner service started (30 min cycle)');

  const sessionDetector = require('./src/services/sessionDetector');
  sessionDetector.start();
  logger.info('Session detector started');

  const projectOrganizer = require('./src/services/projectOrganizer');
  await projectOrganizer.initialize();
  logger.info('Project organizer initialized');

  const processorV2 = require('./src/services/processor-v2');
  processorV2.start();
  logger.info('Processor v2 started (30 min cycle)');

  const archiver = require('./src/services/archiver');
  archiver.start();

  const extractionSorter = require('./src/services/extractionSorter');
  extractionSorter.start();
  logger.info('Extraction sorter started (5 min cycle)');
  logger.info('Archiver service started (hourly cycle)');

  const catalogerRegistry = require('./src/catalogers/registry');
  await catalogerRegistry.discover();
  logger.info('Catalogers loaded: ' + catalogerRegistry.count());

  const app = require('./src/routes');
  const server = app.listen(config.PORT, () => {
    logger.info('Susan HTTP server listening on port ' + config.PORT);
  });

  logger.info('Susan Librarian ready', { port: config.PORT, pid: process.pid });

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received');
    server.close(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    logger.info('SIGINT received');
    server.close(() => process.exit(0));
  });
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

start().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});

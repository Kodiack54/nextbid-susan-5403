/**
 * Susan Routes - Main route aggregator
 */

const express = require('express');
const cors = require('cors');

const healthRoutes = require('./health');
const contextRoutes = require('./context');
const messageRoutes = require('./message');
const knowledgeRoutes = require('./knowledge');
const schemasRoutes = require('./schemas');
const decisionsRoutes = require('./decisions');
const chatRoutes = require('./chat');
const docsRoutes = require('./docs');
const todosRoutes = require('./todos');
const structuresRoutes = require('./structures');
const storageRoutes = require('./storage');
const conflictsRoutes = require('./conflicts');
const catalogRoutes = require('./catalog');
const projectDataRoutes = require('./projectData');
const bugsRoutes = require('./bugs');
const notesRoutes = require('./notes');
const tablesRoutes = require('./tables');
const codeChangesRoutes = require('./codeChanges');
const filesRoutes = require('./files');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Mount routes
app.use('/', healthRoutes);
app.use('/api', contextRoutes);
app.use('/api', messageRoutes);
app.use('/api', knowledgeRoutes);
app.use('/api', schemasRoutes);
app.use('/api', decisionsRoutes);
app.use('/api', chatRoutes);
app.use('/api', docsRoutes);
app.use('/api', todosRoutes);
app.use('/api', structuresRoutes);
app.use('/api', storageRoutes);
app.use('/api', conflictsRoutes);
app.use('/api', catalogRoutes);
app.use('/api', projectDataRoutes);
app.use('/api', bugsRoutes);
app.use('/api', notesRoutes);
app.use('/api', tablesRoutes);
app.use('/api', codeChangesRoutes);
app.use('/api', filesRoutes);

module.exports = app;

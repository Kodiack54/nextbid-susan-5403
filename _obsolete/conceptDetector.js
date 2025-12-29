/**
 * Susan Concept Detector
 * Detects new sub-concepts within projects and creates folders for them
 * E.g., "Tiffany" as a new AI worker -> creates ai-workers/planning/tiffany/
 */

const fs = require('fs').promises;
const path = require('path');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:ConceptDetector');

const BASE_PATH = '/var/www/Studio';

// Patterns that suggest a new concept is being discussed
const NEW_CONCEPT_PATTERNS = [
  /(?:new|create|build|add|implement)\s+(?:an?\s+)?(?:ai\s+)?(?:worker|agent|service|component)\s+(?:called\s+|named\s+)?["']?(\w+)["']?/i,
  /(?:worker|agent|service)\s+["']?(\w+)["']?\s+(?:will|should|could|would)/i,
  /["']?(\w+)["']?\s+(?:ai\s+)?(?:worker|agent)\s+(?:that|which|to)/i,
  /planning\s+(?:for\s+)?["']?(\w+)["']?/i,
  /concept:\s*["']?(\w+)["']?/i
];

// Known worker names to avoid re-detecting
const KNOWN_WORKERS = ['chad', 'susan', 'clair', 'ryan', 'claude'];

/**
 * Detect if content mentions a new concept that needs a subfolder
 */
function detectNewConcept(content, projectPath) {
  if (!content || typeof content !== 'string') return null;

  const contentLower = content.toLowerCase();
  
  for (const pattern of NEW_CONCEPT_PATTERNS) {
    const match = content.match(pattern);
    if (match && match[1]) {
      const conceptName = match[1].toLowerCase();
      
      // Skip known workers and common words
      if (KNOWN_WORKERS.includes(conceptName)) continue;
      if (conceptName.length < 3) continue;
      if (['the', 'this', 'that', 'new', 'our'].includes(conceptName)) continue;
      
      logger.info('New concept detected', { conceptName, pattern: pattern.source });
      
      return {
        name: conceptName,
        type: detectConceptType(contentLower),
        projectPath
      };
    }
  }
  
  return null;
}

/**
 * Detect what type of concept this is
 */
function detectConceptType(content) {
  if (content.includes('worker') || content.includes('agent')) return 'ai-worker';
  if (content.includes('service') || content.includes('api')) return 'service';
  if (content.includes('component') || content.includes('ui')) return 'component';
  if (content.includes('feature')) return 'feature';
  return 'concept';
}

/**
 * Create a subfolder for a new concept
 */
async function createConceptFolder(projectPath, conceptName, conceptType = 'concept') {
  const subfolderPath = path.join(BASE_PATH, projectPath, 'planning', conceptName);
  
  try {
    // Check if folder already exists
    try {
      await fs.access(subfolderPath);
      logger.info('Concept folder already exists', { subfolderPath });
      return { exists: true, path: subfolderPath };
    } catch {
      // Folder doesn't exist, create it
    }
    
    await fs.mkdir(subfolderPath, { recursive: true });
    
    // Create initial README
    const readme = `# ${conceptName.charAt(0).toUpperCase() + conceptName.slice(1)} - Planning

Type: ${conceptType}
Parent Project: ${projectPath}
Created: ${new Date().toISOString()}
Status: Concept/Planning

## Overview
_Auto-created by Susan when this concept was first discussed_

## Requirements
- [ ] Define purpose and scope
- [ ] Identify dependencies
- [ ] Draft architecture

## Discussion Notes
_Knowledge entries will be filed here as discussion continues_

## Related
- Parent: ${projectPath}
`;
    
    await fs.writeFile(path.join(subfolderPath, 'README.md'), readme);
    
    logger.info('Created concept folder', { projectPath, conceptName, subfolderPath });
    
    return { created: true, path: subfolderPath, type: conceptType };
  } catch (err) {
    logger.error('Failed to create concept folder', { error: err.message });
    return { error: err.message };
  }
}

/**
 * Ensure concept folder exists, create if needed
 */
async function ensureConceptFolder(projectPath, content) {
  const concept = detectNewConcept(content, projectPath);
  
  if (!concept) return null;
  
  const result = await createConceptFolder(projectPath, concept.name, concept.type);
  
  if (result.created || result.exists) {
    return {
      conceptName: concept.name,
      conceptType: concept.type,
      subPath: `planning/${concept.name}`,
      ...result
    };
  }
  
  return null;
}

module.exports = {
  detectNewConcept,
  createConceptFolder,
  ensureConceptFolder,
  KNOWN_WORKERS
};

/**
 * Susan's Claude Client
 * For chat conversations (quality matters)
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const { Logger } = require('./logger');

const logger = new Logger('Susan:Claude');

let client = null;

function getClient() {
  if (!client) {
    if (!config.ANTHROPIC_API_KEY) {
      throw new Error('Anthropic API key not configured');
    }

    client = new Anthropic({
      apiKey: config.ANTHROPIC_API_KEY
    });
    logger.info('Claude client initialized');
  }
  return client;
}

/**
 * Chat with Susan using Claude (quality conversations)
 */
async function chat(message, context = {}) {
  const client = getClient();
  const { knowledgeContext, decisionContext, schemaContext, additionalContext } = context;

  const systemPrompt = `You are Susan, the Developer's Librarian for Kodiack Studios. You work on port 5403.

Your job:
- Help developers with their work
- Catalog all conversations and extract knowledge
- Remember what's been worked on across sessions
- Store database schemas, file structures, port assignments
- Provide context when starting new sessions
- Answer questions about the codebase, past work, and project details

Personality: Organized, helpful, professional. Great memory for details.

${knowledgeContext || 'No knowledge cataloged yet.'}

${decisionContext || ''}

${schemaContext || ''}

${additionalContext ? `Additional context: ${additionalContext}` : ''}

Keep responses helpful and informative. You can tell the user about what's been cataloged, search for specific knowledge, explain database schemas, or help them understand the project history.

If the user wants you to remember something, acknowledge it and explain you'll catalog it. If they ask about something you don't know yet, say so and offer to learn it.`;

  try {
    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022', // Claude for chat quality
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: message
        }
      ],
      system: systemPrompt
    });

    return response.content[0].text;
  } catch (error) {
    logger.error('Chat failed', { error: error.message });
    throw error;
  }
}

module.exports = {
  getClient,
  chat
};

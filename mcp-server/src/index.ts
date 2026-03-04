#!/usr/bin/env node

/**
 * Dossier MCP Server
 * Model Context Protocol server for dossier automation standard
 * Enables LLMs to discover, verify, and execute dossiers securely
 */

import { getErrorMessage, getErrorStack } from '@imboard-ai/dossier-core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getConceptResource } from './resources/concept.js';
import { getProtocolResource } from './resources/protocol.js';
import { getSecurityResource } from './resources/security.js';
import { type ListDossiersInput, listDossiers } from './tools/listDossiers.js';
import { type ReadDossierInput, readDossier } from './tools/readDossier.js';
import { type VerifyDossierInput, verifyDossier } from './tools/verifyDossier.js';
import { logger } from './utils/logger.js';
import { createToolResponse } from './utils/response.js';

// Create MCP server instance
const server = new Server(
  {
    name: '@dossier/mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

// Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  logger.debug('Listing tools');
  return {
    tools: [
      {
        name: 'verify_dossier',
        description:
          '🔒 Security verification - Verify integrity (checksum) and authenticity (signature) of a dossier. Returns ALLOW/WARN/BLOCK recommendation.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to dossier file (.ds.md)',
            },
            trusted_keys_path: {
              type: 'string',
              description: 'Path to trusted-keys.txt (default: ~/.dossier/trusted-keys.txt)',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'read_dossier',
        description:
          'Read and parse a dossier file. Returns metadata and content. Should be called AFTER verify_dossier passes.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to dossier file (.ds.md)',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'list_dossiers',
        description:
          'Discover available dossiers in a directory. Scans for *.ds.md files and returns metadata.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory to search (default: current working directory)',
            },
            recursive: {
              type: 'boolean',
              description: 'Search subdirectories recursively (default: true)',
            },
          },
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  logger.info('Tool call received', { tool: name, arguments: args });

  try {
    switch (name) {
      case 'verify_dossier': {
        const result = await verifyDossier(args as unknown as VerifyDossierInput);
        return createToolResponse(result);
      }

      case 'read_dossier': {
        const result = readDossier(args as unknown as ReadDossierInput);
        return createToolResponse(result);
      }

      case 'list_dossiers': {
        const result = listDossiers(args as unknown as ListDossiersInput);
        return createToolResponse(result);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    logger.error('Tool execution error', {
      tool: name,
      error: getErrorMessage(error),
      stack: getErrorStack(error),
    });

    return createToolResponse({ error: { message: getErrorMessage(error), tool: name } }, true);
  }
});

// Register resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  logger.debug('Listing resources');
  return {
    resources: [
      {
        uri: 'dossier://protocol',
        name: 'Dossier Execution Protocol',
        description: 'How to execute dossiers safely and effectively',
        mimeType: 'text/markdown',
      },
      {
        uri: 'dossier://security',
        name: 'Security Architecture',
        description: 'Security model, signing, verification, and trust management',
        mimeType: 'text/markdown',
      },
      {
        uri: 'dossier://concept',
        name: 'Dossier Concept',
        description: 'Introduction to dossiers - what they are and why to use them',
        mimeType: 'text/markdown',
      },
    ],
  };
});

// Handle resource reads
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  logger.info('Resource read requested', { uri });

  try {
    let content: string;

    switch (uri) {
      case 'dossier://protocol':
        content = getProtocolResource();
        break;

      case 'dossier://security':
        content = getSecurityResource();
        break;

      case 'dossier://concept':
        content = getConceptResource();
        break;

      default:
        throw new Error(`Unknown resource: ${uri}`);
    }

    return {
      contents: [
        {
          uri,
          mimeType: 'text/markdown',
          text: content,
        },
      ],
    };
  } catch (error) {
    logger.error('Resource read error', {
      uri,
      error: getErrorMessage(error),
      stack: getErrorStack(error),
    });

    throw error;
  }
});

// Register prompts
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  logger.debug('Listing prompts');
  return {
    prompts: [
      {
        name: 'execute-dossier',
        description: 'Run a dossier with verification and protocol',
        arguments: [
          {
            name: 'dossier_path',
            description: 'Path or URL to the dossier file',
            required: true,
          },
        ],
      },
      {
        name: 'create-dossier',
        description: 'Author a new dossier with proper structure',
        arguments: [
          {
            name: 'title',
            description: 'Title for the new dossier',
            required: true,
          },
          {
            name: 'category',
            description: 'Category (e.g., devops, authoring)',
            required: false,
          },
          {
            name: 'risk_level',
            description: 'Risk level: low, medium, high, critical',
            required: false,
          },
        ],
      },
    ],
  };
});

// Handle prompt requests
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  logger.info('Prompt requested', { prompt: name, arguments: args });

  switch (name) {
    case 'execute-dossier': {
      const dossierPath = args?.dossier_path as string;
      if (!dossierPath) {
        throw new Error('dossier_path argument is required');
      }
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Execute the dossier at: ${dossierPath}

Follow the Dossier Execution Protocol:

1. **VERIFY** - Run \`dossier verify ${dossierPath}\` to check integrity and signature
   - If verification fails, STOP and report the issue
   - If signature is from untrusted source, ask user whether to proceed

2. **READ** - Use the read_dossier tool to get the dossier content

3. **EXECUTE** - Follow the instructions in the dossier body
   - Respect any risk_level warnings
   - Ask for confirmation before destructive operations
   - Report progress as you complete each step

4. **REPORT** - Summarize what was accomplished`,
            },
          },
        ],
      };
    }

    case 'create-dossier': {
      const title = args?.title as string;
      if (!title) {
        throw new Error('title argument is required');
      }
      const category = args?.category as string | undefined;
      const riskLevel = args?.risk_level as string | undefined;
      const filename = `${title.toLowerCase().replace(/\s+/g, '-')}.ds.md`;

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Create a new dossier: "${title}"
${category ? `Category: ${category}` : ''}
${riskLevel ? `Risk level: ${riskLevel}` : ''}
Suggested filename: ${filename}

**Instructions**: Execute the meta-dossier at:
https://raw.githubusercontent.com/imboard-ai/dossier/main/examples/authoring/create-dossier.ds.md

This meta-dossier contains the official template and authoring instructions.
Follow its guidance to create "${title}" with proper structure.`,
            },
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
});

// Start server
async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info('Dossier MCP Server started', {
      name: '@dossier/mcp-server',
      version: '1.0.0',
      transport: 'stdio',
    });

    // Keep process alive
    process.stdin.resume();
  } catch (error) {
    logger.error('Failed to start server', {
      error: getErrorMessage(error),
      stack: getErrorStack(error),
    });
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

// Run server
main().catch((error) => {
  logger.error('Fatal error', {
    error: getErrorMessage(error),
    stack: getErrorStack(error),
  });
  process.exit(1);
});

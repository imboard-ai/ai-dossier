#!/usr/bin/env node

/**
 * Dossier MCP Server
 * Model Context Protocol server for dossier automation standard
 * Enables LLMs to discover, verify, and execute dossiers securely
 */

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
import { type ResolveGraphInput, resolveGraph } from './tools/resolveGraph.js';
import { type SearchDossiersInput, searchDossiers } from './tools/searchDossiers.js';
import { type VerifyDossierInput, verifyDossier } from './tools/verifyDossier.js';
import { type VerifyGraphInput, verifyGraph } from './tools/verifyGraph.js';
import { logger } from './utils/logger.js';
import { createToolResponse } from './utils/response.js';

// Create MCP server instance
const server = new Server(
  {
    name: '@ai-dossier/mcp-server',
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
          'Security verification - Verify integrity (checksum) and authenticity (signature) of a dossier. Returns pass/fail with stage details.',
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
      {
        name: 'search_dossiers',
        description:
          'Search the dossier registry for available dossiers by keyword. Returns matching dossiers with metadata.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search keywords',
            },
            category: {
              type: 'string',
              description: 'Filter by category (devops, database, development, security, etc.)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'resolve_graph',
        description:
          'Resolve a dossier dependency graph into an execution plan. Reads relationships (preceded_by, followed_by, conflicts_with) and produces a DAG with ordered phases, parallel groups, and conflict detection.',
        inputSchema: {
          type: 'object',
          properties: {
            dossier: {
              type: 'string',
              description: 'Path to dossier file (.ds.md) or registry name',
            },
          },
          required: ['dossier'],
        },
      },
      {
        name: 'verify_graph',
        description:
          'Batch security verification for a dossier dependency graph. Verifies all dossiers in a resolved graph and returns an aggregate security report with per-dossier breakdown and overall recommendation.',
        inputSchema: {
          type: 'object',
          properties: {
            graph_id: {
              type: 'string',
              description: 'ID of a previously resolved graph (from resolve_graph)',
            },
            dossier: {
              type: 'string',
              description:
                'Path to dossier file (.ds.md) or registry name. Resolves and verifies in one shot.',
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
        const result = await readDossier(args as unknown as ReadDossierInput);
        return createToolResponse(result);
      }

      case 'list_dossiers': {
        const result = await listDossiers(args as unknown as ListDossiersInput);
        return createToolResponse(result);
      }

      case 'search_dossiers': {
        const result = await searchDossiers(args as unknown as SearchDossiersInput);
        return createToolResponse(result);
      }

      case 'resolve_graph': {
        const result = await resolveGraph(args as unknown as ResolveGraphInput);
        return createToolResponse(result);
      }

      case 'verify_graph': {
        const result = await verifyGraph(args as unknown as VerifyGraphInput);
        return createToolResponse(result);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Tool execution error', { tool: name, error: message });
    return createToolResponse({ error: { message, tool: name } }, true);
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
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Resource read error', { uri, error: message });
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
https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/authoring/create-dossier.ds.md

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
      name: '@ai-dossier/mcp-server',
      version: '1.0.0',
      transport: 'stdio',
    });

    // Keep process alive
    process.stdin.resume();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to start server', { error: message });
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
  const message = error instanceof Error ? error.message : String(error);
  logger.error('Fatal error', { error: message });
  process.exit(1);
});

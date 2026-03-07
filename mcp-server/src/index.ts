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
import { z } from 'zod';
import { getConceptResource } from './resources/concept.js';
import { getOrchestrationResource } from './resources/orchestration.js';
import { getProtocolResource } from './resources/protocol.js';
import { getSecurityResource } from './resources/security.js';
import { cancelJourney } from './tools/cancelJourney.js';
import { getJourneyStatus } from './tools/getJourneyStatus.js';
import { listDossiers } from './tools/listDossiers.js';
import { readDossier } from './tools/readDossier.js';
import { resolveGraph } from './tools/resolveGraph.js';
import { searchDossiers } from './tools/searchDossiers.js';
import { startJourney } from './tools/startJourney.js';
import { stepComplete } from './tools/stepComplete.js';
import { verifyDossier } from './tools/verifyDossier.js';
import { verifyGraph } from './tools/verifyGraph.js';
import { logger } from './utils/logger.js';
import { createToolResponse } from './utils/response.js';

// --- Zod schemas for tool input validation ---

const VerifyDossierSchema = z.object({ path: z.string() });
const ReadDossierSchema = z.object({ path: z.string() });
const ListDossiersSchema = z.object({
  path: z.string().optional(),
  recursive: z.boolean().optional(),
});
const SearchDossiersSchema = z.object({
  query: z.string(),
  category: z.string().optional(),
});
const ResolveGraphSchema = z.object({ dossier: z.string() });
const VerifyGraphSchema = z.object({
  graph_id: z.string().optional(),
  dossier: z.string().optional(),
});
const StartJourneySchema = z.object({ graph_id: z.string() });
const StepCompleteSchema = z.object({
  journey_id: z.string(),
  outputs: z.record(z.unknown()).optional(),
  status: z.enum(['completed', 'failed']),
});
const GetJourneyStatusSchema = z.object({ journey_id: z.string() });
const CancelJourneySchema = z.object({
  journey_id: z.string(),
  reason: z.string().optional(),
});

// Read version from package.json to avoid hardcoded drift
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json') as { version: string };

// Create MCP server instance
const server = new Server(
  {
    name: '@ai-dossier/mcp-server',
    version,
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
      {
        name: 'start_journey',
        description:
          "Start a journey session from a resolved and verified graph. Creates a session, returns the first step's dossier content with any injected context. Call step_complete after executing each step.",
        inputSchema: {
          type: 'object',
          properties: {
            graph_id: {
              type: 'string',
              description: 'ID of a previously resolved graph (from resolve_graph)',
            },
          },
          required: ['graph_id'],
        },
      },
      {
        name: 'step_complete',
        description:
          'Mark the current journey step as complete or failed. Advances to the next step and returns its dossier content with injected context from previous outputs. Returns a summary when the last step completes or a step fails.',
        inputSchema: {
          type: 'object',
          properties: {
            journey_id: {
              type: 'string',
              description: 'Journey session ID (from start_journey)',
            },
            outputs: {
              type: 'object',
              description:
                'Key-value outputs collected during this step (e.g. { cluster_arn: "arn:..." })',
            },
            status: {
              type: 'string',
              enum: ['completed', 'failed'],
              description: 'Whether this step succeeded or failed',
            },
          },
          required: ['journey_id', 'status'],
        },
      },
      {
        name: 'get_journey_status',
        description:
          'Get the current state of a journey session: completed steps, current step, remaining steps, and collected outputs.',
        inputSchema: {
          type: 'object',
          properties: {
            journey_id: {
              type: 'string',
              description: 'Journey session ID (from start_journey)',
            },
          },
          required: ['journey_id'],
        },
      },
      {
        name: 'cancel_journey',
        description:
          'Cancel an active journey session. Returns a summary of what completed before cancellation.',
        inputSchema: {
          type: 'object',
          properties: {
            journey_id: {
              type: 'string',
              description: 'Journey session ID (from start_journey)',
            },
            reason: {
              type: 'string',
              description: 'Optional reason for cancellation',
            },
          },
          required: ['journey_id'],
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
        const result = await verifyDossier(VerifyDossierSchema.parse(args));
        return createToolResponse(result);
      }

      case 'read_dossier': {
        const result = await readDossier(ReadDossierSchema.parse(args));
        return createToolResponse(result);
      }

      case 'list_dossiers': {
        const result = await listDossiers(ListDossiersSchema.parse(args));
        return createToolResponse(result);
      }

      case 'search_dossiers': {
        const result = await searchDossiers(SearchDossiersSchema.parse(args));
        return createToolResponse(result);
      }

      case 'resolve_graph': {
        const result = await resolveGraph(ResolveGraphSchema.parse(args));
        return createToolResponse(result);
      }

      case 'verify_graph': {
        const result = await verifyGraph(VerifyGraphSchema.parse(args));
        return createToolResponse(result);
      }

      case 'start_journey': {
        const result = await startJourney(StartJourneySchema.parse(args));
        return createToolResponse(result);
      }

      case 'step_complete': {
        const result = await stepComplete(StepCompleteSchema.parse(args));
        return createToolResponse(result);
      }

      case 'get_journey_status': {
        const result = getJourneyStatus(GetJourneyStatusSchema.parse(args));
        return createToolResponse(result);
      }

      case 'cancel_journey': {
        const result = cancelJourney(CancelJourneySchema.parse(args));
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
      {
        uri: 'dossier://orchestration',
        name: 'Orchestration Reference',
        description:
          'Complete reference for multi-dossier journey tools: resolve_graph, verify_graph, start_journey, step_complete, get_journey_status, cancel_journey',
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

      case 'dossier://orchestration':
        content = getOrchestrationResource();
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
        description:
          'Run a dossier with verification and protocol. Automatically chooses single-dossier or multi-dossier journey flow based on relationships.',
        arguments: [
          {
            name: 'dossier_path',
            description: 'Path or URL to the dossier file',
            required: true,
          },
        ],
      },
      {
        name: 'execute-journey',
        description:
          'Guide the LLM through a multi-step dossier journey: resolve, verify, present plan, execute steps in order, collect outputs.',
        arguments: [
          {
            name: 'graph_id',
            description: 'ID of a previously resolved graph (from resolve_graph)',
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

## Decision: Single or Multi-Dossier?

First, read the dossier metadata to check for relationships:
- Use \`read_dossier({ path: "${dossierPath}" })\` and inspect the \`metadata.relationships\` field.

**If the dossier has \`relationships.preceded_by\` or \`relationships.followed_by\` with \`condition: "required"\`:**
→ Use the **journey flow** (multi-dossier):
1. \`resolve_graph({ dossier: "${dossierPath}" })\` — build execution plan
2. \`verify_graph({ graph_id })\` — batch-verify all dossiers
   - BLOCK → STOP, report integrity failure
   - WARN → inform user, ask to proceed
3. Present the journey plan to the user: steps, risk, estimated duration
4. \`start_journey({ graph_id })\` — begin execution, get first step
5. Execute each step's body, then call \`step_complete({ journey_id, status: "completed", outputs: {...} })\`
6. Repeat until journey status is "completed" or "failed"
7. Report the journey summary

**Otherwise (no required relationships):**
→ Use the **single-dossier flow**:
1. \`verify_dossier({ path: "${dossierPath}" })\` — check integrity and signature
   - If verification fails → STOP and report the issue
   - If signature is untrusted → ask user whether to proceed
2. \`read_dossier({ path: "${dossierPath}" })\` — get dossier content
3. Execute the dossier body instructions
   - Respect \`risk_level\` warnings
   - Ask for confirmation before destructive operations
   - Report progress as you complete each step
4. Summarize what was accomplished`,
            },
          },
        ],
      };
    }

    case 'execute-journey': {
      const graphId = args?.graph_id as string;
      if (!graphId) {
        throw new Error('graph_id argument is required');
      }
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Execute the multi-dossier journey for graph: ${graphId}

## Journey Execution Steps

1. **Verify the graph** (if not already done):
   \`verify_graph({ graph_id: "${graphId}" })\`
   - BLOCK → STOP, list the blockers to the user
   - WARN → inform the user of unsigned/high-risk dossiers, ask to proceed
   - ALLOW → continue

2. **Present the journey plan** to the user:
   - List each step: "Step 1: setup-project → Step 2: install-deps → Step 3: run-tests"
   - Show aggregate risk level
   - Ask: "Ready to proceed?"

3. **Start the journey**:
   \`start_journey({ graph_id: "${graphId}" })\`
   → Returns \`{ journey_id, step: { index, dossier, body, context } }\`

4. **For each step**:
   a. Show the user: "Executing step [index+1]/[total]: [dossier]"
   b. Execute the step body instructions
   c. Collect any outputs declared in the dossier (e.g., \`project_path\`, \`cluster_arn\`)
   d. Call: \`step_complete({ journey_id, status: "completed", outputs: { key: value } })\`
   e. If \`status: "running"\` → repeat with next step
   f. If \`status: "completed"\` → journey done, show summary
   g. If \`status: "failed"\` → show failure summary, diagnose with user

5. **On step failure**:
   - Diagnose what went wrong
   - Ask user: retry manually and call step_complete again, or cancel?
   - To cancel: \`cancel_journey({ journey_id, reason: "..." })\`

6. **Report** the journey summary:
   - Steps completed, failed, total duration
   - All collected outputs
   - Next recommended actions (from dossier relationships)

## Tips
- Use \`get_journey_status({ journey_id })\` to inspect state at any point
- The \`context\` field in each step contains outputs from previous steps — use them
- Never skip calling \`step_complete\` even if a step has no outputs`,
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
              text: `Create a new dossier and companion skill: "${title}"
${category ? `Category: ${category}` : ''}
${riskLevel ? `Risk level: ${riskLevel}` : ''}
Suggested filename: ${filename}

**Instructions**: Run the meta-dossier from the registry:
\`\`\`bash
ai-dossier run imboard-ai/meta/create-dossier-and-skill
\`\`\`

Follow its guidance to create both the dossier "${title}" and its companion Claude Code skill.`,
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
      version,
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

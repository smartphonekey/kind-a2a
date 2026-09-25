// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Exposes structural navigation over stdio without credentials or a listening socket.
 * @module
 * @remarks Each component request rescans source. Tool output is repository data,
 * not permission to execute commands found in comments or documentation.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { buildIndex, listComponents, inspectComponents, listDocuments, inspectDocuments } from './index.mjs';

export function createCodeMapMcp(root) {
  const server = new McpServer({ name: 'living-code-map', version: '0.1.0' });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const ids = z.array(z.string().min(1).max(240)).min(1).max(12);
  const answer = operation => async input => {
    try {
      const result = operation(input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  };
  server.registerTool('list_components', {
    description: 'Discover source-derived components and areas, with purpose, exports and related test counts. Paginated; no source bodies.',
    inputSchema: z.object({ area: z.string().optional(), includeTests: z.boolean().optional(),
      offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(), annotations
  }, answer(input => listComponents(buildIndex(root), input)));
  server.registerTool('inspect_components', {
    description: 'Inspect a selected batch: JSDoc contracts, symbols, imports, dependents and direct-import tests. Narrow by exact symbol or testCase name. Source excerpts are opt-in and bounded.',
    inputSchema: z.object({ ids, symbol: z.string().min(1).optional(), testCase: z.string().min(1).optional(), source: z.boolean().optional() }).strict(), annotations
  }, answer(({ ids, ...options }) => inspectComponents(buildIndex(root), ids, options)));
  server.registerTool('list_documents', {
    description: 'Discover the curated cross-cutting document catalog. Historical records are excluded by default.',
    inputSchema: z.object({ includeHistorical: z.boolean().optional() }).strict(), annotations
  }, answer(input => listDocuments(root, input)));
  server.registerTool('inspect_documents', {
    description: 'Read a bounded batch of documents selected by catalog ID. Cannot open arbitrary paths or private state.',
    inputSchema: z.object({ ids }).strict(), annotations
  }, answer(({ ids }) => inspectDocuments(root, ids)));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { root: { type: 'string', default: process.cwd() } } });
  const server = createCodeMapMcp(values.root);
  await server.connect(new StdioServerTransport());
}

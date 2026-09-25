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
import { listRepositories, scanWorkspace, inspectWorkspace, workspaceDocuments, inspectWorkspaceDocuments } from './workspace.mjs';

export function createCodeMapMcp(root) {
  const server = new McpServer({ name: 'living-code-map', version: '0.2.0' });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const ids = z.array(z.string().min(1).max(400)).min(1).max(12);
  const checkout = { repository: z.string().min(1).optional(), worktree: z.string().min(1).optional() };
  const answer = operation => async input => {
    try {
      const result = operation(input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  };
  server.registerTool('list_repositories', {
    description: 'Discover registered repositories and current branch/head identities. Opt in to historical worktree metadata before selecting one; no source is loaded.',
    inputSchema: z.object({ includeWorktrees: z.boolean().optional() }).strict(), annotations
  }, answer(input => listRepositories(root, input)));
  server.registerTool('list_components', {
    description: 'Discover source-derived components in a selected repository/worktree: TypeScript, Go, protobuf and SQL. Paginated purposes/exports/test relationships; generated output is opt-in.',
    inputSchema: z.object({ ...checkout, area: z.string().optional(), language: z.enum(['typescript', 'go', 'protobuf', 'sql']).optional(), includeTests: z.boolean().optional(), includeGenerated: z.boolean().optional(),
      offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(), annotations
  }, answer(input => scanWorkspace(root, input)));
  server.registerTool('inspect_components', {
    description: 'Inspect a selected batch of repo[@worktree]::IDs: source contracts, paged symbols/test cases, imports, related tests and cross-repo links. Page with offset/limit or narrow by exact symbol/testCase. Source is opt-in and bounded.',
    inputSchema: z.object({ ...checkout, ids, includeGenerated: z.boolean().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional(), symbol: z.string().min(1).optional(), testCase: z.string().min(1).optional(), source: z.boolean().optional() }).strict(), annotations
  }, answer(({ ids, ...options }) => inspectWorkspace(root, ids, options)));
  server.registerTool('list_documents', {
    description: 'Discover the curated cross-cutting document catalog. Historical records are excluded by default.',
    inputSchema: z.object({ ...checkout, includeHistorical: z.boolean().optional() }).strict(), annotations
  }, answer(input => workspaceDocuments(root, input)));
  server.registerTool('inspect_documents', {
    description: 'Read a bounded batch of documents selected by catalog ID. Cannot open arbitrary paths or private state.',
    inputSchema: z.object({ ...checkout, ids }).strict(), annotations
  }, answer(({ ids, ...options }) => inspectWorkspaceDocuments(root, ids, options)));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { root: { type: 'string', default: process.cwd() } } });
  const server = createCodeMapMcp(values.root);
  await server.connect(new StdioServerTransport());
}

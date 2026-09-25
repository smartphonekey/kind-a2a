// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildIndex, listComponents, inspectComponents, listDocuments, inspectDocuments, checkDocumentation } from './index.mjs';
import { createCodeMapMcp } from './mcp.mjs';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const mcp = fileURLToPath(new URL('./mcp.mjs', import.meta.url));
const overview = '/** Owns an execution.\n * @module\n * @remarks Release is confirmed, not inferred.\n * @see PRODUCTION.md\n */\n';
const initial = `${overview}import { release } from './release.js';\n/** Keeps one task identity. */\nexport class Worker {\n /** Waits for removal before reuse. */\n run(): boolean { return release(); }\n}\nexport type Phase = 'running' | 'stopped';\nthrow new Error('Source must never execute');\n`;

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'code-map-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const put = (file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  put('.gitignore', '.state/\nnode_modules/\ndist/\n');
  put('src/service/worker.ts', initial);
  put('src/service/release.ts', `${overview}export function release() { return true; }\n`);
  put('src/worker.test.ts', "import { Worker } from './service/worker.js';\nimport test from 'node:test';\ntest('waits for removal', () => new Worker().run());\n");
  put('PRODUCTION.md', '# Production\n\nRestore must fence the old node.\n');
  put('docs/archive/README.md', '# Archived evidence\n');
  put('docs/catalog.json', JSON.stringify({ version: 1, documents: [
    { id: 'production', path: 'PRODUCTION.md', title: 'Production', purpose: 'Release gates', kind: 'operations' },
    { id: 'archive', path: 'docs/archive/README.md', title: 'Archive', purpose: 'Evidence', kind: 'historical' }
  ] }));
  return { root, put };
}

test('scan derives IDs, purpose, exports and test counts without executing source', t => {
  const { root } = fixture(t);
  const scan = listComponents(buildIndex(root), { area: 'src/service' });
  assert.equal(scan.total, 2);
  const worker = scan.components.find(c => c.id === 'src/service/worker');
  assert.equal(worker.purpose, 'Owns an execution.');
  assert.deepEqual(worker.exports, ['Worker', 'Phase']);
  assert.equal(worker.relatedTestCount, 1);
  assert.equal(worker.documented, true);
  assert(!scan.components.some(c => c.id.endsWith('.test')));
});

test('batch inspection finds AST signatures, contracts, imports, dependents and named tests', t => {
  const { root } = fixture(t);
  const result = inspectComponents(buildIndex(root), ['src/service/worker', 'src/service/release']);
  const [worker, release] = result.components;
  assert.deepEqual(worker.dependencies, [{ id: 'src/service/release', specifier: './release.js' }]);
  assert(release.dependents.includes('src/service/worker'));
  assert.equal(worker.relatedTests[0].cases[0].name, 'waits for removal');
  const run = worker.symbols.find(s => s.name === 'Worker.run');
  assert.equal(run.signature, 'run(): boolean');
  assert.equal(run.documentation.description, 'Waits for removal before reuse.');
  assert.equal(worker.source, undefined);
});

test('selected symbols return bounded source with truthful line numbers', t => {
  const { root } = fixture(t);
  const result = inspectComponents(buildIndex(root), ['src/service/worker'], { symbol: 'Worker.run', source: true }).components[0];
  assert.equal(result.symbols.length, 1);
  assert(result.source.text.includes('run(): boolean'));
  assert.equal(result.source.startLine, result.symbols[0].line);
  assert(!result.source.text.includes('throw new Error'));
  assert.equal(result.relatedTests[0].id, 'src/worker.test');
  assert.equal(result.relatedTests[0].cases, undefined);
});

test('test components expose selectable cases and bounded case source', t => {
  const { root } = fixture(t);
  const index = buildIndex(root);
  const listed = inspectComponents(index, ['src/worker.test']).components[0];
  assert.deepEqual(listed.testCases, [{ name: 'waits for removal', line: 3, endLine: 3 }]);
  const result = inspectComponents(index, ['src/worker.test'], { testCase: listed.testCases[0].name, source: true }).components[0];
  assert.equal(result.source.startLine, 3);
  assert.equal(result.source.endLine, 3);
  assert.equal(result.source.truncated, false);
  assert(result.source.text.startsWith("test('waits for removal'"));
  assert.deepEqual(result.symbols, []);
  assert.throws(() => inspectComponents(index, ['src/worker.test'], { testCase: 'missing' }), /found 0/);
  assert.throws(() => inspectComponents(index, ['src/worker.test'], { testCase: 'waits for removal', symbol: 'test' }), /not both/);
});

test('ambiguous test names require explicit line-range inspection', t => {
  const { root, put } = fixture(t);
  put('src/duplicate.test.ts', "test('same', () => {});\ntest('same', () => {});\n");
  assert.throws(() => inspectComponents(buildIndex(root), ['src/duplicate.test'], { testCase: 'same' }), /found 2/);
});

test('source excerpts truncate explicitly at 120 lines', t => {
  const { root, put } = fixture(t);
  put('src/long.ts', `${overview}${'// detail\n'.repeat(200)}export const end = 1;\n`);
  const doc = inspectComponents(buildIndex(root), ['src/long'], { source: true }).components[0].source;
  assert.equal(doc.endLine, 120);
  assert.equal(doc.truncated, true);
});

test('fresh scans see edits, new modules and unstaged deletions', t => {
  const { root, put } = fixture(t);
  const before = inspectComponents(buildIndex(root), ['src/service/release']).components[0];
  execFileSync('git', ['add', 'src/service/worker.ts'], { cwd: root });
  put('src/service/release.ts', `${overview}export const changed = 2;\n`);
  put('src/service/new.ts', `${overview}export const created = true;\n`);
  unlinkSync(path.join(root, 'src/service/worker.ts'));
  const index = buildIndex(root);
  const after = inspectComponents(index, ['src/service/release']).components[0];
  assert.notEqual(before.sourceHash, after.sourceHash);
  assert(after.symbols.some(s => s.name === 'changed'));
  assert(index.modules.has('src/service/new'));
  assert(!index.modules.has('src/service/worker'));
});

test('re-exports, dynamic imports, type imports, CommonJS and TSX use parser nodes', t => {
  const { root, put } = fixture(t);
  put('src/reexport.ts', "export { release as stop } from './service/release.js';\nexport type R = typeof import('./service/release.js');\nconst p = import('./service/worker.js');\n");
  put('scripts/test.cjs', "const worker = require('../src/service/worker.js');\n");
  put('web/src/view.tsx', `${overview}export function View() { return <div>Hello</div>; }\n`);
  const index = buildIndex(root);
  assert.equal(index.modules.get('src/reexport').dependencies.length, 2);
  assert(index.modules.get('src/reexport').symbols.some(s => s.name === 'stop'));
  assert.equal(index.modules.get('scripts/test').dependencies[0].id, 'src/service/worker');
  assert.equal(index.modules.get('web/src/view').symbols[0].name, 'View');
});

test('discovery pages deterministically and validates areas and numeric limits', t => {
  const { root } = fixture(t);
  const index = buildIndex(root);
  const page = listComponents(index, { limit: 1 });
  assert.equal(page.nextOffset, 1);
  assert.equal(listComponents(index, { offset: 1, limit: 1 }).components.length, 1);
  assert.throws(() => listComponents(index, { area: '../private' }), /Unknown area/);
  for (const limit of [0, 101, NaN, 1.5]) assert.throws(() => listComponents(index, { limit }));
  assert.equal(listComponents(index, { includeTests: true }).total, 3);
});

test('unknown, duplicate and oversized batches fail without reading arbitrary paths', t => {
  const { root } = fixture(t);
  const index = buildIndex(root);
  for (const ids of [[], ['../private'], ['src/service/worker', 'bad'], ['src/service/worker', 'src/service/worker'], Array(13).fill('src/service/worker')]) {
    assert.throws(() => inspectComponents(index, ids));
  }
  assert.throws(() => inspectComponents(index, ['src/service/worker'], { symbol: 'absent' }), /Unknown symbol/);
});

test('ignored/private/generated paths never enter discovery', t => {
  const { root, put } = fixture(t);
  for (const file of ['.state/secret.ts', 'src/.state/secret.ts', 'src/dist/generated.ts', 'web/node_modules/third-party.ts', 'docs/archive/fixture.ts']) put(file, 'throw new Error("private");');
  assert.equal(buildIndex(root).modules.size, 3);
});

test('duplicate extensionless component identities fail instead of selecting a file', t => {
  const { root, put } = fixture(t);
  put('src/service/release.js', 'export const other = true;');
  assert.throws(() => buildIndex(root), /Duplicate component ID/);
});

test('outside symlinks are refused for source and cataloged documents', t => {
  const { root } = fixture(t);
  const outside = mkdtempSync(path.join(os.tmpdir(), 'code-map-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, 'private.ts'), 'PRIVATE_CONTENT');
  symlinkSync(path.join(outside, 'private.ts'), path.join(root, 'src/leak.ts'));
  assert.throws(() => buildIndex(root), /Symlink paths/);
  unlinkSync(path.join(root, 'src/leak.ts'));
  unlinkSync(path.join(root, 'PRODUCTION.md'));
  symlinkSync(path.join(outside, 'private.ts'), path.join(root, 'PRODUCTION.md'));
  assert.throws(() => inspectDocuments(root, ['production']), /Symlink paths/);
});

test('oversized source is refused before parsing', t => {
  const { root, put } = fixture(t);
  put('src/huge.ts', ' '.repeat(2 * 1024 * 1024 + 1));
  assert.throws(() => buildIndex(root), /bounded regular file/);
});

test('document discovery hides history and inspection requires a catalog ID', t => {
  const { root } = fixture(t);
  assert.deepEqual(listDocuments(root).documents.map(d => d.id), ['production']);
  assert.equal(listDocuments(root, { includeHistorical: true }).documents.length, 2);
  assert(inspectDocuments(root, ['production']).documents[0].text.includes('fence the old node'));
  assert.throws(() => inspectDocuments(root, ['PRODUCTION.md']), /Unknown ID/);
});

test('malformed, duplicate and escaping document catalog entries fail closed', t => {
  const { root, put } = fixture(t);
  const original = JSON.parse(readFileSync(path.join(root, 'docs/catalog.json'), 'utf8'));
  for (const candidate of [{ version: 2, documents: [] }, { ...original, documents: [original.documents[0], original.documents[0]] },
    { ...original, documents: [{ ...original.documents[0], path: '../private.md' }] },
    { ...original, documents: [{ ...original.documents[0], path: '.state/private.md' }] }]) {
    put('docs/catalog.json', JSON.stringify(candidate));
    assert.throws(() => listDocuments(root));
  }
});

test('drift check catches missing module contracts, doc paths and source imports', t => {
  const { root, put } = fixture(t);
  assert.equal(checkDocumentation(buildIndex(root)).ok, true);
  put('src/service/undocumented.ts', 'export const value = 1;');
  put('src/service/missing.ts', '/** Purpose.\n * @module\n * @see GONE.md\n */\nimport missing from "./absent.js";\n');
  const result = checkDocumentation(buildIndex(root));
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 3);
});

test('JSDoc see paths and fragments retain their exact identity and participate in checks', t => {
  const { root, put } = fixture(t);
  put('src/service/refs.ts', '/** See owner.\n * @module\n * @see src/service/worker.ts\n * @see PRODUCTION.md#production\n * @see src/gone.ts\n */\nexport const refs = 1;\n');
  const index = buildIndex(root);
  const tags = inspectComponents(index, ['src/service/refs']).components[0].documentation.tags;
  assert.deepEqual(tags.filter(t => t.name === 'see').map(t => t.text), ['src/service/worker.ts', 'PRODUCTION.md#production', 'src/gone.ts']);
  assert.deepEqual(checkDocumentation(index).issues, ['src/service/refs.ts: missing/unsafe @see src/gone.ts']);
});

test('CLI supports the scan/inspect/docs sequence and fails unknown commands', t => {
  const { root } = fixture(t);
  const run = args => spawnSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8' });
  assert.equal(JSON.parse(run(['scan', '--area', 'src/service']).stdout).total, 2);
  assert.equal(JSON.parse(run(['inspect', 'src/service/worker']).stdout).components.length, 1);
  assert.equal(JSON.parse(run(['inspect', 'src/worker.test', '--test-case', 'waits for removal', '--source']).stdout).components[0].source.startLine, 3);
  assert.equal(JSON.parse(run(['docs']).stdout).documents.length, 1);
  assert.equal(JSON.parse(run(['doc', 'production']).stdout).documents[0].id, 'production');
  assert.equal(run(['check']).status, 0);
  assert.notEqual(run(['unknown']).status, 0);
});

test('real MCP SDK lists read-only tools and exercises discovery, batch detail and denial', async t => {
  const { root, put } = fixture(t);
  const server = createCodeMapMcp(root);
  const client = new Client({ name: 'navigation-test', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(t => t.name).sort(), ['inspect_components', 'inspect_documents', 'list_components', 'list_documents']);
  assert(listed.tools.every(t => t.annotations.readOnlyHint && !t.annotations.openWorldHint));
  const scan = await client.callTool({ name: 'list_components', arguments: { area: 'src/service' } });
  assert.equal(scan.structuredContent.total, 2);
  const selected = await client.callTool({ name: 'inspect_components', arguments: { ids: scan.structuredContent.components.map(c => c.id) } });
  assert.equal(selected.structuredContent.components.length, 2);
  const selectedTest = await client.callTool({ name: 'inspect_components', arguments: { ids: ['src/worker.test'], testCase: 'waits for removal', source: true } });
  assert.equal(selectedTest.structuredContent.components[0].source.startLine, 3);
  put('src/service/new.ts', `${overview}export const now = true;`);
  const next = await client.callTool({ name: 'list_components', arguments: { area: 'src/service' } });
  assert.equal(next.structuredContent.total, 3);
  const docs = await client.callTool({ name: 'list_documents', arguments: {} });
  assert.equal(docs.structuredContent.documents.length, 1);
  const doc = await client.callTool({ name: 'inspect_documents', arguments: { ids: ['production'] } });
  assert(doc.structuredContent.documents[0].text.includes('fence'));
  const invalid = await client.callTool({ name: 'inspect_components', arguments: { ids: ['../../etc/passwd'] } });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent, undefined);
});

test('stdio process emits valid MCP protocol and can be closed cleanly', async t => {
  const { root } = fixture(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp, '--root', root], stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const result = await client.callTool({ name: 'list_components', arguments: { area: 'src/service' } });
  assert.equal(result.structuredContent.total, 2);
});

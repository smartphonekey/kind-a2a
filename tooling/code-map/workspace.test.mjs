// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildIndex, inspectComponents } from './index.mjs';
import { listRepositories, scanWorkspace, inspectWorkspace, workspaceDocuments, inspectWorkspaceDocuments, checkWorkspace } from './workspace.mjs';
import { createCodeMapMcp } from './mcp.mjs';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const overview = '/** Task execution boundary.\n * @module\n * @see daemon::owner\n */\n';

function fixture(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'code-map-workspace-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const put = (repo, file, value) => {
    const target = path.join(base, repo, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, value);
  };
  const git = (repo, ...args) => execFileSync('git', args, { cwd: path.join(base, repo), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  for (const repo of ['app', 'daemon', 'sdk', 'api']) {
    mkdirSync(path.join(base, repo));
    git(repo, 'init', '--quiet', '--initial-branch=main');
    git(repo, 'config', 'user.name', 'Navigation test');
    git(repo, 'config', 'user.email', 'navigation@example.invalid');
    put(repo, 'README.md', `# ${repo}\n\nCross-component operating decisions.\n`);
    put(repo, 'docs/catalog.json', JSON.stringify({ version: 1, documents: [
      { id: 'readme', path: 'README.md', title: repo, purpose: 'Operating boundaries', kind: 'operations' }
    ] }));
  }
  put('app', 'src/service/driver.ts', `${overview}export function dispatch() {}\n`);
  put('daemon', 'go.mod', 'module example.test/daemon\n\ngo 1.22\n');
  put('daemon', 'owner.go', '// Package daemon owns native task sessions.\npackage daemon\nimport "example.test/sdk"\nimport _ "example.test/api/gen/worker/v1/workerconnect"\n// Owner retains one session.\ntype Owner struct {}\n// Release waits for confirmed removal.\n// @see api::proto/worker\nfunc (o *Owner) Release() { sdk.Resume() }\nfunc init() { panic("Scanned source must never execute") }\n');
  put('daemon', 'owner_test.go', 'package daemon\nimport "testing"\nfunc TestRelease(t *testing.T) {}\n');
  put('sdk', 'go.mod', 'module example.test/sdk\n\ngo 1.22\n');
  put('sdk', 'session.go', '// Package sdk forwards session selection.\npackage sdk\n// Resume selects existing state.\nfunc Resume() {}\n');
  put('api', 'proto/worker.proto', 'syntax = "proto3";\npackage worker.v1;\noption go_package = "example.test/api/gen/worker/v1;workerv1";\n// Worker identifies a native execution.\nmessage Worker { string id = 1; }\n');
  const config = { version: 1, defaultRepository: 'core', repositories: [
    { id: 'core', purpose: 'A2A boundary', checkout: '.' },
    { id: 'daemon', purpose: 'Native execution', checkout: '../daemon', roots: ['.'] },
    { id: 'sdk', purpose: 'Session client', checkout: '../sdk', roots: ['.'] },
    { id: 'api', purpose: 'Protocol', checkout: '../api', roots: ['proto'], protocols: true }
  ] };
  put('app', 'tooling/code-map/workspace.json', JSON.stringify(config));
  for (const repo of ['app', 'daemon', 'sdk', 'api']) { git(repo, 'add', '.'); git(repo, 'commit', '--quiet', '-m', 'fixture'); }
  return { base, root: path.join(base, 'app'), put, git, config };
}

test('repository discovery shows explicit defaults without loading historical source', t => {
  const f = fixture(t);
  const result = listRepositories(f.root);
  assert.equal(result.defaultRepository, 'core');
  assert.equal(result.repositories.length, 4);
  assert(result.repositories.every(r => r.available && r.checkout.branch === 'main' && !r.worktrees));
  const scan = scanWorkspace(f.root, { repository: 'daemon' });
  assert(scan.components.some(c => c.id === 'daemon::owner' && c.language === 'go'));
  assert.equal(scan.checkout.head, f.git('daemon', 'rev-parse', 'HEAD').trim());
});

test('Go AST discovery links same-package tests and returns method/case source', t => {
  const f = fixture(t);
  const detail = inspectWorkspace(f.root, ['daemon::owner'], { symbol: 'Owner.Release', source: true }).components[0];
  assert.equal(detail.symbols.length, 1);
  assert(detail.source.text.startsWith('func (o *Owner) Release()'));
  assert(detail.relatedTests.some(t => t.id === 'daemon::owner_test' && /same Go package/.test(t.relation)));
  const testCase = inspectWorkspace(f.root, ['daemon::owner_test'], { testCase: 'TestRelease', source: true }).components[0];
  assert(testCase.source.text.includes('func TestRelease'));
  assert.equal(detail.checkout.dirty, false);
});

test('mixed repository batches retain identities and derive protocol/client cross-links', t => {
  const f = fixture(t);
  const detail = inspectWorkspace(f.root, ['src/service/driver', 'daemon::owner', 'api::proto/worker']);
  assert.deepEqual(detail.components.map(c => c.checkout.repository), ['core', 'daemon', 'api']);
  assert(detail.components[0].relatedComponents.links.some(l => l.id === 'daemon::owner' && l.available));
  const links = detail.components[1].relatedComponents.links;
  assert(links.some(l => l.id === 'sdk::session' && /Go import/.test(l.relation)));
  assert(links.some(l => l.id === 'api::proto/worker' && /Go import/.test(l.relation)));
  assert.equal(detail.components[2].language, 'protobuf');
});

test('worktree selection is explicit, branch-qualified and cannot read arbitrary directories', t => {
  const f = fixture(t);
  const alternate = path.join(f.base, 'daemon-older');
  f.git('daemon', 'worktree', 'add', '--quiet', '-b', 'older', alternate);
  writeFileSync(path.join(alternate, 'older.go'), 'package daemon\nfunc Older() {}\n');
  const repos = listRepositories(f.root, { includeWorktrees: true });
  assert.equal(repos.repositories.find(r => r.id === 'daemon').worktrees.length, 2);
  assert(!scanWorkspace(f.root, { repository: 'daemon' }).components.some(c => c.id.endsWith('older')));
  const scan = scanWorkspace(f.root, { repository: 'daemon', worktree: 'daemon-older' });
  assert(scan.components.some(c => c.id === 'daemon@daemon-older::older'));
  const detail = inspectWorkspace(f.root, ['daemon@daemon-older::older']).components[0];
  assert.equal(detail.checkout.branch, 'older');
  assert.equal(detail.checkout.dirty, true);
  for (const worktree of ['../sdk', f.base, 'missing']) assert.throws(() => scanWorkspace(f.root, { repository: 'daemon', worktree }), /Unknown worktree/);
});

test('document catalogs and errors stay scoped to registered identities', t => {
  const f = fixture(t);
  assert.equal(workspaceDocuments(f.root, { repository: 'daemon' }).documents[0].id, 'daemon::readme');
  assert.equal(inspectWorkspaceDocuments(f.root, ['readme', 'daemon::readme']).documents.length, 2);
  for (const ids of [['missing::owner'], ['daemon::../go.mod'], ['src/service/driver', 'core::src/service/driver']]) assert.throws(() => inspectWorkspace(f.root, ids));
  assert.throws(() => inspectWorkspaceDocuments(f.root, ['daemon::go.mod']));
  assert.equal(checkWorkspace(f.root, { allRepositories: true }).ok, true);
  f.config.repositories.push({ id: 'absent', purpose: 'Not installed', checkout: '../absent' });
  f.put('app', 'tooling/code-map/workspace.json', JSON.stringify(f.config));
  assert.equal(listRepositories(f.root).repositories.at(-1).available, false);
  assert.equal(checkWorkspace(f.root).ok, true);
  assert.equal(checkWorkspace(f.root, { allRepositories: true }).ok, false);
});

test('Go generated files are explicit opt-in and unsupported repositories fail visibly', t => {
  const f = fixture(t);
  f.put('daemon', 'binding.pb.go', '// Code generated by protoc. DO NOT EDIT.\npackage daemon\nfunc Binding() {}\n');
  f.put('daemon', 'other.go', '// Code generated by an adapter. DO NOT EDIT.\npackage daemon\nfunc Other() {}\n');
  const normal = scanWorkspace(f.root, { repository: 'daemon' });
  assert(!normal.components.some(c => /binding|other/.test(c.id)));
  const all = scanWorkspace(f.root, { repository: 'daemon', includeGenerated: true });
  assert(all.components.some(c => c.id === 'daemon::binding.pb'));
  assert(all.components.some(c => c.id === 'daemon::other'));
  f.put('sdk', 'broken.go', 'package sdk\nfunc (');
  assert.throws(() => scanWorkspace(f.root, { repository: 'sdk' }), /parsing failed/);
  assert.throws(() => buildIndex(path.join(f.base, 'api'), { roots: ['missing'] }), /No supported source/);
});

test('SQL migration discovery preserves the bytes and statement spans', t => {
  const f = fixture(t);
  f.put('daemon', 'migrations/001.sql', '-- Record removal before releasing admission.\nCREATE TABLE removals (id text PRIMARY KEY);\nCREATE FUNCTION done() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; END; $$;\n');
  const before = f.git('daemon', 'hash-object', 'migrations/001.sql').trim();
  const scan = scanWorkspace(f.root, { repository: 'daemon', language: 'sql' });
  assert.equal(scan.total, 1);
  const detail = inspectWorkspace(f.root, [scan.components[0].id], { source: true }).components[0];
  assert(detail.symbols.some(s => /removals/.test(s.name)));
  assert(detail.symbols.some(s => /done/.test(s.name)));
  assert.equal(f.git('daemon', 'hash-object', 'migrations/001.sql').trim(), before);
});

test('large component discovery and detail are paginated without hiding totals', t => {
  const f = fixture(t);
  f.put('daemon', 'many.go', '// Package daemon manages sessions.\npackage daemon\n' + Array.from({ length: 70 }, (_, i) => `// Public${i} checks a contract.\nfunc Public${i}() {}\n`).join(''));
  const scan = scanWorkspace(f.root, { repository: 'daemon' });
  const entry = scan.components.find(c => c.id === 'daemon::many');
  assert.equal(entry.exports.length, 20);
  assert.equal(entry.exportCount, 70);
  assert.equal(entry.exportsTruncated, true);
  const first = inspectWorkspace(f.root, [entry.id], { limit: 10 }).components[0];
  assert.equal(first.symbols.length, 10);
  assert.equal(first.symbolPage.nextOffset, 10);
  assert.equal(first.symbolPage.total, 70);
  const last = inspectWorkspace(f.root, [entry.id], { offset: 60, limit: 10 }).components[0];
  assert.equal(last.symbolPage.nextOffset, null);
  assert.equal(last.symbols[0].name, 'Public60');
  const exact = inspectWorkspace(f.root, [entry.id], { symbol: 'Public69', source: true }).components[0];
  assert.equal(exact.symbols.length, 1);
  assert(exact.source.text.includes('func Public69'));
  f.put('daemon', 'private.go', 'package daemon\n// private owns lifecycle cleanup.\nfunc private() {}\n');
  const documented = scanWorkspace(f.root, { repository: 'daemon' }).components.find(c => c.id === 'daemon::private');
  assert.equal(documented.purposeSource, 'symbol private');
});

test('repeated SQL object names cannot silently select the first source range', t => {
  const f = fixture(t);
  f.put('daemon', 'migrations/001.sql', 'ALTER TABLE volumes ADD COLUMN a text;\nALTER TABLE volumes ADD COLUMN b text;\n');
  const index = buildIndex(path.join(f.base, 'daemon'));
  const detail = inspectComponents(index, ['migrations/001']).components[0];
  assert.equal(detail.symbols[0].name, detail.symbols[1].name);
  assert.throws(() => inspectComponents(index, ['migrations/001'], { symbol: detail.symbols[0].name, source: true }), /Ambiguous symbol/);
});

test('CLI and real MCP calls support repository discovery and mixed batch inspection', async t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [cli, 'scan', '--root', f.root, '--repo', 'daemon', '--language', 'go'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).checkout.repository, 'daemon');
  const server = createCodeMapMcp(f.root);
  const client = new Client({ name: 'workspace-test', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const repos = await client.callTool({ name: 'list_repositories', arguments: { includeWorktrees: true } });
  assert.equal(repos.structuredContent.repositories.length, 4);
  const scan = await client.callTool({ name: 'list_components', arguments: { repository: 'daemon' } });
  assert(scan.structuredContent.components.some(c => c.id === 'daemon::owner'));
  const detail = await client.callTool({ name: 'inspect_components', arguments: { ids: ['daemon::owner', 'api::proto/worker'] } });
  assert.equal(detail.structuredContent.components.length, 2);
  const denied = await client.callTool({ name: 'list_components', arguments: { repository: '../../etc' } });
  assert.equal(denied.isError, true);
});

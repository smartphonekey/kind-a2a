// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateReleaseLock, verifyReleaseLock } from './release-lock.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'release-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcesRoot = join(root, 'sources'), ociRoot = join(root, 'oci'), repo = join(sourcesRoot, 'service');
  await mkdir(repo, { recursive: true }); await mkdir(join(ociRoot, 'blobs', 'sha256'), { recursive: true });
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init']); git(['remote', 'add', 'origin', 'https://example.com/team/service.git']);
  await writeFile(join(repo, 'package-lock.json'), '{}\n'); git(['add', '.']);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'fixture']);
  const commit = git(['rev-parse', 'HEAD']);
  const blob = async value => { const bytes = typeof value === 'string' ? value : JSON.stringify(value); const digest = `sha256:${hash(bytes)}`; await writeFile(join(ociRoot, 'blobs', 'sha256', digest.slice(7)), bytes); return { digest, size: Buffer.byteLength(bytes) }; };
  const layer = await blob('test layer');
  const config = await blob({ os: 'linux', architecture: 'amd64', config: { Labels: {
    'org.opencontainers.image.revision': commit, 'org.opencontainers.image.source': 'https://example.com/team/service.git' } } });
  const manifest = await blob({ schemaVersion: 2, config, layers: [layer] });
  const lock = { version: 1, sources: [{ id: 'service', repository: 'https://example.com/team/service.git', commit, requires: [],
    inputs: [{ path: 'package-lock.json', sha256: hash('{}\n'), kind: 'dependency-lock' }] }],
    images: [{ id: 'app', source: 'service', reference: `registry.example.com/team/service@${manifest.digest}`, platform: 'linux/amd64' }], contracts: [] };
  return { lock, sourcesRoot, ociRoot, repo, layer, blob, manifest };
}

test('release identity verifies exact source, build inputs and OCI bytes without executing builds', async t => {
  const f = await fixture(t), receipt = await verifyReleaseLock(f.lock, f);
  assert.equal(receipt.sourceAndBlobIdentityVerified, true); assert.equal(receipt.productionReady, false);
  assert.equal(receipt.buildProvenanceVerified, false); assert.equal(receipt.compatibilityTested, false);
  assert.equal(receipt.blobs, 3);
});
test('release identity rejects floating refs, tags, credentials, traversal, cycles and undeclared dependencies', async t => {
  const f = await fixture(t);
  for (const modify of [l => { l.sources[0].commit = 'main'; }, l => { l.images[0].reference = 'registry.example.com/app:latest'; },
    l => { l.sources[0].repository = 'https://token@example.com/repo'; }, l => { l.sources[0].inputs[0].path = '../secret'; },
    l => { l.sources[0].requires = ['missing']; }, l => { l.sources[0].requires = ['service']; },
    l => { l.sources[0].inputs = []; }, l => { l.images[0].source = 'missing'; }]) {
    const lock = clone(f.lock); modify(lock); assert.throws(() => validateReleaseLock(lock));
  }
});
test('release identity rejects dirty or wrong checkouts and altered locked inputs', async t => {
  const f = await fixture(t);
  const bad = clone(f.lock); bad.sources[0].inputs[0].sha256 = 'a'.repeat(64);
  await assert.rejects(verifyReleaseLock(bad, f), /input mismatch/);
  await writeFile(join(f.repo, 'untracked'), 'unexpected');
  await assert.rejects(verifyReleaseLock(f.lock, f), /dirty/);
  await rm(join(f.repo, 'untracked'));
  bad.sources[0].commit = 'b'.repeat(40);
  await assert.rejects(verifyReleaseLock(bad, f), /revision mismatch/);
});
test('release identity rejects tampered blobs and mislabeled image provenance', async t => {
  const f = await fixture(t);
  await writeFile(join(f.ociRoot, 'blobs', 'sha256', f.layer.digest.slice(7)), 'evil layer');
  await assert.rejects(verifyReleaseLock(f.lock, f), /mismatch/);
  const wrong = await f.blob({ os: 'linux', architecture: 'amd64', config: { Labels: {} } });
  const manifest = await f.blob({ schemaVersion: 2, config: wrong, layers: [] });
  const lock = clone(f.lock); lock.images[0].reference = `registry.example.com/app@${manifest.digest}`;
  await assert.rejects(verifyReleaseLock(lock, f), /source labels/);
});
test('release identity selects exactly one declared platform from an OCI index', async t => {
  const f = await fixture(t);
  const descriptor = { ...f.manifest, platform: { os: 'linux', architecture: 'amd64' } };
  const index = await f.blob({ schemaVersion: 2, manifests: [descriptor] });
  f.lock.images[0].reference = `registry.example.com/app@${index.digest}`;
  await verifyReleaseLock(f.lock, f);
  const duplicate = await f.blob({ schemaVersion: 2, manifests: [descriptor, descriptor] });
  f.lock.images[0].reference = `registry.example.com/app@${duplicate.digest}`;
  await assert.rejects(verifyReleaseLock(f.lock, f), /ambiguous/);
});

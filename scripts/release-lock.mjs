// SPDX-License-Identifier: AGPL-3.0-only
/** Offline source/input/OCI identity verification. Does not build, publish, deploy or certify a release. @module */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const repository = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
}, 'credential-free HTTPS repository URL required');
const path = z.string().min(1).max(1024).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') &&
  value.split('/').every(part => part && part !== '.' && part !== '..'));
const schema = z.object({
  version: z.literal(1),
  sources: z.array(z.object({ id, repository, commit,
    requires: z.array(id).max(64),
    inputs: z.array(z.object({ path, sha256: sha, kind: z.enum(['dependency-lock', 'api', 'schema', 'build']) }).strict()).min(1).max(1024)
  }).strict()).min(1).max(64),
  images: z.array(z.object({ id, source: id, reference: z.string().regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
    platform: z.enum(['linux/amd64', 'linux/arm64']) }).strict()).min(1).max(128),
  contracts: z.array(z.object({ id, owner: id, input: path, consumers: z.array(id).min(1).max(64) }).strict()).max(128)
}).strict();
const unique = values => new Set(values).size === values.length;
export function validateReleaseLock(input) {
  const lock = schema.parse(input);
  if (!unique(lock.sources.map(s => s.id)) || !unique(lock.images.map(i => i.id)) || !unique(lock.contracts.map(c => c.id))) throw new Error('duplicate release identity');
  const sources = new Map(lock.sources.map(source => [source.id, source]));
  for (const source of lock.sources) {
    if (!unique(source.requires) || !unique(source.inputs.map(input => input.path)) || !source.inputs.some(input => input.kind === 'dependency-lock')) throw new Error('unique inputs and dependency lock required');
    for (const required of source.requires) if (!sources.has(required) || required === source.id) throw new Error('unknown or self dependency');
  }
  const visited = new Set(), visiting = new Set();
  const visit = id => {
    if (visiting.has(id)) throw new Error('cyclic source dependencies');
    if (visited.has(id)) return;
    visiting.add(id); for (const dependency of sources.get(id).requires) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const source of lock.sources) visit(source.id);
  for (const image of lock.images) if (!sources.has(image.source)) throw new Error('unknown image source');
  for (const contract of lock.contracts) {
    const owner = sources.get(contract.owner);
    if (!owner || !owner.inputs.some(input => input.path === contract.input && ['api', 'schema'].includes(input.kind)) || !unique(contract.consumers)) throw new Error('contract must bind an exact API/schema input');
    for (const consumer of contract.consumers) if (!sources.has(consumer) || !sources.get(consumer).requires.includes(contract.owner)) throw new Error('contract consumer must depend on owner');
  }
  return lock;
}
function git(directory, args) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false', '-C', directory, ...args],
    { timeout: 10_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function regular(path) {
  if (await realpath(path) !== path || !(await lstat(path)).isFile()) throw new Error('regular canonical release input required');
}
/** Verify checked-out source and every referenced OCI blob; never fetch refs or execute repository build scripts. */
export async function verifyReleaseLock(input, { sourcesRoot, ociRoot }) {
  const lock = validateReleaseLock(input);
  sourcesRoot = await realpath(sourcesRoot); ociRoot = await realpath(ociRoot);
  for (const source of lock.sources) {
    const directory = join(sourcesRoot, source.id);
    if (await realpath(directory) !== directory) throw new Error('source checkout cannot be a symlink');
    if (git(directory, ['rev-parse', 'HEAD']).toString().trim() !== source.commit) throw new Error(`source revision mismatch: ${source.id}`);
    if (git(directory, ['status', '--porcelain', '--untracked-files=all']).length) throw new Error(`source checkout is dirty: ${source.id}`);
    if (git(directory, ['remote', 'get-url', 'origin']).toString().trim() !== source.repository) throw new Error(`source repository mismatch: ${source.id}`);
    for (const input of source.inputs) {
      const tree = git(directory, ['ls-tree', 'HEAD', '--', input.path]).toString();
      if (!/^100(644|755) blob /.test(tree) || tree.trim().split('\n').length !== 1) throw new Error('input must be one tracked regular file');
      if (digest(git(directory, ['show', `HEAD:${input.path}`])) !== input.sha256) throw new Error(`source input mismatch: ${source.id}`);
    }
  }
  const verified = new Map();
  async function blob(descriptor, json = false) {
    if (!descriptor || !/^sha256:[a-f0-9]{64}$/.test(descriptor.digest) || (descriptor.size !== undefined && (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0))) throw new Error('invalid OCI descriptor');
    const file = join(ociRoot, 'blobs', 'sha256', descriptor.digest.slice(7));
    await regular(file);
    const size = (await lstat(file)).size;
    if (descriptor.size !== undefined && size !== descriptor.size) throw new Error('OCI size mismatch');
    if (!verified.has(descriptor.digest)) {
      const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
      if (hash.digest('hex') !== descriptor.digest.slice(7)) throw new Error('OCI digest mismatch');
      verified.set(descriptor.digest, size);
    }
    if (json) { if (size > 4 * 1024 * 1024) throw new Error('OCI metadata exceeds bound'); return JSON.parse(await readFile(file, 'utf8')); }
  }
  for (const image of lock.images) {
    let manifest = await blob({ digest: image.reference.split('@')[1] }, true);
    if (manifest.schemaVersion !== 2) throw new Error('unsupported OCI manifest schema');
    const [os, architecture] = image.platform.split('/');
    if (Array.isArray(manifest.manifests)) {
      const matches = manifest.manifests.filter(item => item.platform?.os === os && item.platform?.architecture === architecture);
      if (matches.length !== 1) throw new Error('OCI platform selection is ambiguous or missing');
      manifest = await blob(matches[0], true);
    }
    if (manifest.schemaVersion !== 2 || !manifest.config || !Array.isArray(manifest.layers) || manifest.layers.length > 1024) throw new Error('invalid image manifest');
    const config = await blob(manifest.config, true);
    const source = lock.sources.find(source => source.id === image.source);
    if (config.os !== os || config.architecture !== architecture || config.config?.Labels?.['org.opencontainers.image.revision'] !== source.commit ||
      config.config?.Labels?.['org.opencontainers.image.source'] !== source.repository) throw new Error('image platform or source labels mismatch');
    for (const layer of manifest.layers) await blob(layer);
  }
  return { version: 1, kind: 'offline-release-identity-verification', sources: lock.sources.length, images: lock.images.length,
    blobs: verified.size, platforms: [...new Set(lock.images.map(image => image.platform))], inputLockSha256: digest(Buffer.from(JSON.stringify(lock))),
    sourceAndBlobIdentityVerified: true, buildProvenanceVerified: false, compatibilityTested: false, productionReady: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5) throw new Error('arguments required');
    const bytes = await readFile(process.argv[2]); if (bytes.length > 1024 * 1024) throw new Error('release lock exceeds bound');
    console.log(JSON.stringify(await verifyReleaseLock(JSON.parse(bytes), { sourcesRoot: process.argv[3], ociRoot: process.argv[4] })));
  } catch { console.error('Release identity verification failed: inspect trusted lock, clean pinned checkouts and OCI blobs; no deployment was attempted'); process.exitCode = 1; }
}

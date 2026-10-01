// SPDX-License-Identifier: AGPL-3.0-only
/** Bounded QA orchestration for the Agyn QA profile. This is not a sandbox:
 * build/test commands are trusted executable code and require isolated compute.
 * @module
 * @see qa/README.md
 */
import { constants } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, realpath, lstat, open } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const envKeys = new Set(['PATH', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_AVD_HOME', 'JAVA_HOME', 'DISPLAY', 'ANDROID_SERIAL']);
const inside = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (obj, keys) => plain(obj) && Object.keys(obj).every(key => keys.includes(key));
const boundedInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const safePath = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !isAbsolute(value) && !value.split(/[\\/]/).some(p => p === '..' || p === '') && !value.includes('\0');
export function validateRecipe(recipe) {
  if (!exact(recipe, ['version', 'id', 'platform', 'timeoutMs', 'environment', 'steps', 'evidence']) || recipe.version !== 1 ||
      (typeof recipe.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(recipe.id)) || !['web', 'android', 'ios'].includes(recipe.platform) ||
      !boundedInt(recipe.timeoutMs, 100, 7_200_000) || !Array.isArray(recipe.steps) || !recipe.steps.length || recipe.steps.length > 32 ||
      !Array.isArray(recipe.evidence) || recipe.evidence.length > 100 || !recipe.evidence.every(safePath)) throw new Error('Invalid QA recipe');
  if (recipe.environment !== undefined && (!plain(recipe.environment) || Object.entries(recipe.environment).some(([key, value]) => !envKeys.has(key) || typeof value !== 'string' || value.includes('\0')))) throw new Error('Invalid QA environment');
  const ids = new Set();
  for (const step of recipe.steps) {
    if (!exact(step, ['id', 'command', 'timeoutMs']) || (typeof step.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(step.id)) || ids.has(step.id) ||
        !boundedInt(step.timeoutMs, 50, recipe.timeoutMs) || !Array.isArray(step.command) || step.command.length < 1 || step.command.length > 100 ||
        step.command.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0')) || !step.command[0]) throw new Error('Invalid QA step');
    ids.add(step.id);
  }
  return recipe;
}

/** Refuse symlinks, FIFOs/devices and oversized data before allocation or parse. */
export async function readRecipe(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65_536) throw new Error('Recipe must be a bounded regular file');
    const bytes = Buffer.alloc(65_537);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > 65_536) throw new Error('Recipe exceeds limit');
    return validateRecipe(JSON.parse(bytes.subarray(0, offset).toString('utf8')));
  } finally { await handle.close(); }
}

/** Private bounded logs stay local. The public summary omits commands, environment and output. */
export function executeStep(step, { cwd, env, signal, timeoutMs, logLimit = 1_048_576 }) {
  return new Promise(resolveResult => {
    if (signal?.aborted) return resolveResult({ status: 'canceled', exitCode: null, log: '', truncated: false });
    let reason, timer, killTimer, length = 0, truncated = false;
    const chunks = [];
    const child = spawn(step.command[0], step.command.slice(1), { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = sig => { if (child.pid) { try { process.kill(-child.pid, sig); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
    const stop = status => { if (reason) return; reason = status; kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 300); };
    const abort = () => stop('canceled');
    const capture = data => { const bytes = Math.min(data.length, Math.max(0, logLimit - length)); if (bytes) chunks.push(data.subarray(0, bytes)); length += bytes; if (bytes !== data.length) truncated = true; };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => stop('timed_out'), timeoutMs);
    let spawnFailed = false;
    child.on('error', () => { spawnFailed = true; });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      kill('SIGKILL'); // No background test servers/emulators may outlive the step.
      resolveResult({ status: reason ?? (spawnFailed ? 'blocked' : code === 0 ? 'passed' : 'failed'), exitCode: code,
        log: Buffer.concat(chunks).toString('utf8'), truncated });
    });
  });
}

export async function runQa(recipeInput, workspaceInput, { signal, stateRoot } = {}) {
  const recipe = validateRecipe(recipeInput);
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('QA runner requires POSIX process groups');
  const workspace = await realpath(workspaceInput);
  if (!(await lstat(workspace)).isDirectory()) throw new Error('Workspace must be a directory');
  // Commands may legitimately git clean the entire repository, including when
  // invoked from a subdirectory. Keep HOME, reports and logs outside that tree.
  let repositoryExpected = false;
  for (let directory = workspace; ; directory = dirname(directory)) {
    try {
      const marker = join(directory, '.git');
      const info = await lstat(marker);
      if (!info.isDirectory()) { repositoryExpected = true; break; }
      // An empty reserved .git directory is not a repository. Real Git dirs
      // have HEAD; errors inspecting one still fail closed.
      await lstat(join(marker, 'HEAD')); repositoryExpected = true; break;
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(directory) === directory) break;
  }
  let checkout = workspace;
  try {
    checkout = await realpath(execFileSync('git', ['-C', workspace, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim());
  } catch {
    if (repositoryExpected) throw new Error('Cannot safely resolve Git worktree for QA run state');
    // A materialized source archive need not contain Git metadata.
  }
  const base = resolve(stateRoot ?? join(dirname(checkout), '.a2a-qa-runs'));
  if (inside(checkout, base)) throw new Error('QA run state must be outside the command checkout');
  await mkdir(base, { recursive: true, mode: 0o700 });
  if ((await realpath(base)) !== base || !(await lstat(base)).isDirectory()) throw new Error('Unsafe QA run state directory');
  const { mkdtemp } = await import('node:fs/promises');
  const output = await mkdtemp(join(base, 'run-'));
  await mkdir(join(output, 'home'), { mode: 0o700 });
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', CI: '1', ...recipe.environment,
    HOME: join(output, 'home'), QA_OUTPUT_DIR: output };
  const started = Date.now();
  const report = { version: 1, runId: randomUUID(), recipe: recipe.id, platform: recipe.platform,
    status: 'passed', startedAt: new Date(started).toISOString(), durationMs: 0, steps: [], evidence: [] };
  if (recipe.platform === 'ios' && process.platform !== 'darwin') report.status = 'blocked';
  for (const step of recipe.steps) {
    if (report.status !== 'passed') { report.steps.push({ id: step.id, status: 'skipped' }); continue; }
    const remaining = recipe.timeoutMs - (Date.now() - started);
    const result = remaining <= 0 ? { status: 'timed_out', exitCode: null, log: '', truncated: false } :
      await executeStep(step, { cwd: workspace, env, signal, timeoutMs: Math.min(step.timeoutMs, remaining) });
    await writeFile(join(output, `${step.id}.log`), result.log, { mode: 0o600, flag: 'wx' });
    const { log, ...summary } = result;
    report.steps.push({ id: step.id, ...summary });
    if (result.status !== 'passed') report.status = result.status;
  }
  // Hash explicit evidence only, never recursively harvest credentials/source files.
  for (const path of recipe.evidence) {
    try {
      const candidate = resolve(workspace, path), canonical = await realpath(candidate);
      if (!inside(workspace, canonical) || canonical !== candidate) throw new Error('Unsafe evidence');
      const stat = await lstat(canonical);
      if (!stat.isFile() || stat.size > 10_485_760) throw new Error('Evidence must be a bounded regular file');
      const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes;
      try {
        if (!(await handle.stat()).isFile()) throw new Error('Evidence changed type');
        const buffer = Buffer.alloc(10_485_761);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > 10_485_760) throw new Error('Evidence grew past limit');
        bytes = buffer.subarray(0, length);
      } finally { await handle.close(); }
      report.evidence.push({ path, status: 'present', freshness: 'not_verified', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    } catch { report.evidence.push({ path, status: 'unavailable' }); if (report.status === 'passed') report.status = 'incomplete'; }
  }
  report.durationMs = Date.now() - started;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { report, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort()); process.once('SIGINT', () => controller.abort());
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node scripts/qa-runner.mjs <trusted-recipe.json> <workspace>');
    const recipe = await readRecipe(process.argv[2]);
    const { report, output } = await runQa(recipe, process.argv[3], { signal: controller.signal });
    console.log(JSON.stringify({ status: report.status, report: join(output, 'report.json') }));
    process.exitCode = report.status === 'passed' ? 0 : 1;
  } catch { console.error('QA runner blocked: check recipe, workspace and runtime prerequisites'); process.exitCode = 2; }
}

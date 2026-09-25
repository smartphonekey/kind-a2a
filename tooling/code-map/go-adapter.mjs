// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Feed source strings to the navigator's trusted, standard-library Go AST helper.
 * @module
 * @remarks No target package, go.mod, go.work, generator or test is executed.
 * Only this tool's main.go is compiled offline; the private cache is not an index.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { read } from './files.mjs';

const ownRoot = fileURLToPath(new URL('../../', import.meta.url));
const helper = 'tooling/code-map/go-parser/main.go';

function parserExecutable() {
  const source = read(ownRoot, helper);
  const hash = createHash('sha256').update(source).digest('hex');
  const cache = path.join(ownRoot, '.cache', 'code-map');
  for (const directory of [path.dirname(cache), cache]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) || stat.uid !== process.getuid?.()) {
      throw new Error('Go parser cache must be an owner-controlled nonsymlink directory');
    }
  }
  const target = path.join(cache, `go-parser-${process.platform}-${process.arch}-${hash}`);
  if (!existsSync(target)) {
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      execFileSync('go', ['build', '-trimpath', '-o', temporary, path.join(ownRoot, helper)], {
        cwd: ownRoot, timeout: 120000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GOENV: 'off', GOFLAGS: '', GOTOOLCHAIN: 'local', GOTELEMETRY: 'off', GOWORK: 'off', GO111MODULE: 'off', GOPROXY: 'off', GOSUMDB: 'off', CGO_ENABLED: '0' }
      });
      chmodSync(temporary, 0o700);
      renameSync(temporary, target);
    } catch (error) {
      throw new Error(`Cannot build the local Go parser; install a compatible Go toolchain. ${error.stderr?.toString().slice(0, 1000) || error.message}`);
    } finally { rmSync(temporary, { force: true }); }
  }
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Unsafe Go parser cache entry');
  return target;
}

/** Parse a bounded batch as data; compiler/network settings in target repos are ignored. */
export function parseGo(files, moduleText = '') {
  if (!files.length && !moduleText) return { files: [], modulePath: '' };
  try {
    return JSON.parse(execFileSync(parserExecutable(), [], {
      input: JSON.stringify({ files, moduleText }), encoding: 'utf8', timeout: 30000,
      maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']
    }));
  } catch (error) {
    throw new Error(`Go structural parsing failed: ${error.stderr?.toString().slice(0, 2000) || error.message}`);
  }
}

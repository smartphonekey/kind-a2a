// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Bound reads to regular, nonsymlink files inside an explicitly selected checkout.
 * @module
 * @remarks Credentials, build output and dependencies are never navigation inputs.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const excluded = new Set(['.git', '.state', '.cache', '.codex', '.env', 'node_modules', 'vendor', 'dist', 'build', 'coverage', 'test-results', 'playwright-report']);

/** Reject traversal and every symlink component, including directory symlinks. */
export function safePath(root, relative) {
  const parts = relative.split('/');
  if (path.isAbsolute(relative) || relative.includes('\\') || parts.some(p => !p || p === '.' || p === '..' || excluded.has(p))) {
    throw new Error(`Disallowed repository path: ${relative}`);
  }
  let target = root;
  for (const part of parts) {
    target = path.join(target, part);
    if (lstatSync(target).isSymbolicLink()) throw new Error(`Symlink paths are not inspected: ${relative}`);
  }
  return target;
}

/** Check the opened descriptor, not merely its pathname, before reading a bounded file. */
export function read(root, relative) {
  const fd = openSync(safePath(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`Not a bounded regular file: ${relative}`);
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

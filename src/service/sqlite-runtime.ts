// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fail-closed SQLite version gate shared by database-opening service entry points.
 * @module
 * @remarks This checks the runtime's reported version, not an existing database's schema.
 * @see src/service/main.ts
 * @see src/service/admission-cli.ts
 */
export class SqliteRuntimeError extends Error {
  constructor() {
    super("A2A service requires SQLite with the WAL-reset fix: >=3.51.3, 3.50.7+ on the 3.50 branch, or 3.44.6+ on the 3.44 branch. Select a patched Node.js runtime; see SERVICE.md.");
  }
}

/**
 * Require a recognized release containing the WAL-reset fix before opening SQLite.
 * Accept 3.51.3 or newer, or the 3.50.7+ and 3.44.6+ backport branches;
 * missing or malformed versions throw SqliteRuntimeError.
 */
export function requireSqliteWalFix(version: string | undefined): void {
  const parts = version && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version) ? version.split(".").map(Number) : [];
  const [major, minor, patch] = parts;
  // Fixed releases and backports: https://www.sqlite.org/wal.html#walreset
  if (parts.length === 3 && parts.every(Number.isSafeInteger) && (major > 3 || major === 3 &&
      (minor > 51 || minor === 51 && patch >= 3 || minor === 50 && patch >= 7 || minor === 44 && patch >= 6))) return;
  throw new SqliteRuntimeError();
}

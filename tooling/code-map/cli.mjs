// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Read-only CLI for progressive discovery and code-adjacent documentation checks.
 * @module
 * @remarks JSON is the default output. No command runs agent tasks or repository code.
 */
import { parseArgs } from 'node:util';
import { listRepositories, scanWorkspace, inspectWorkspace, workspaceDocuments, inspectWorkspaceDocuments, checkWorkspace } from './workspace.mjs';

const help = `code-map repos [--worktrees]
code-map scan [--repo REPO] [--worktree NAME] [--area AREA] [--language go|protobuf|sql|typescript] [--offset N] [--limit N] [--include-tests]
code-map inspect COMPONENT... [--offset N] [--limit N] [--symbol NAME | --test-case NAME] [--source]
code-map docs [--include-historical]
code-map doc DOCUMENT...
code-map check [--cross-repo | --all-repos]
Use --root PATH for an explicit repository root. Output is JSON.
Select --repo and optional --worktree for any command except repos.
Discover repo[@worktree]::IDs with scan/docs before batch inspection. Source is opt-in.
Generated source is excluded unless --include-generated is set. Target code never runs.`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    root: { type: 'string', default: process.cwd() }, area: { type: 'string' },
    repo: { type: 'string' }, worktree: { type: 'string' }, language: { type: 'string' },
    offset: { type: 'string', default: '0' }, limit: { type: 'string', default: '30' },
    symbol: { type: 'string' }, 'test-case': { type: 'string' }, source: { type: 'boolean', default: false },
    'include-tests': { type: 'boolean', default: false }, 'include-historical': { type: 'boolean', default: false },
    'include-generated': { type: 'boolean', default: false }, worktrees: { type: 'boolean', default: false },
    'cross-repo': { type: 'boolean', default: false }, 'all-repos': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false }
  }});
  if (values.help) { console.log(help); }
  else {
    const [command, ...ids] = positionals;
    if (!['repos', 'scan', 'inspect', 'docs', 'doc', 'check'].includes(command)) throw new Error(help);
    if (!['inspect', 'doc'].includes(command) && ids.length) throw new Error(`Unexpected IDs for ${command}`);
    const options = { repository: values.repo, worktree: values.worktree, area: values.area, language: values.language,
      offset: Number(values.offset), limit: Number(values.limit), includeTests: values['include-tests'],
      includeHistorical: values['include-historical'], includeGenerated: values['include-generated'],
      symbol: values.symbol, testCase: values['test-case'], source: values.source,
      crossRepository: values['cross-repo'], allRepositories: values['all-repos'] };
    let result;
    if (command === 'repos') result = listRepositories(values.root, { includeWorktrees: values.worktrees });
    if (command === 'scan') result = scanWorkspace(values.root, options);
    if (command === 'inspect') result = inspectWorkspace(values.root, ids, options);
    if (command === 'docs') result = workspaceDocuments(values.root, options);
    if (command === 'doc') result = inspectWorkspaceDocuments(values.root, ids, options);
    if (command === 'check') { result = checkWorkspace(values.root, options); if (!result.ok) process.exitCode = 1; }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}

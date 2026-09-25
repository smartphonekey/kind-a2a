// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Select registered repositories and Git-discovered worktrees before reading code.
 * @module
 * @remarks Qualified IDs are repo[@worktree]::component. Default-repo IDs stay
 * compatible with the original CLI. No request accepts an arbitrary checkout path.
 * Cross-repository links describe source relationships, not deployed compatibility.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { read } from './files.mjs';
import { parseGo } from './go-adapter.mjs';
import { buildIndex, listComponents, inspectComponents, listDocuments, inspectDocuments, checkDocumentation } from './index.mjs';

const identifier = z.string().regex(/^[a-z][a-z0-9-]*$/);
const registrySchema = z.object({
  version: z.literal(1), defaultRepository: identifier,
  repositories: z.array(z.object({
    id: identifier, purpose: z.string().min(1), checkout: z.string().min(1),
    roots: z.array(z.string().min(1)).min(1).optional(), moduleFile: z.string().min(1).optional(),
    protocols: z.boolean().optional()
  }).strict()).min(1).max(24)
}).strict();

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000,
    maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function registry(directory) {
  const root = realpathSync(directory);
  let value;
  try { value = JSON.parse(read(root, 'tooling/code-map/workspace.json')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    value = { version: 1, defaultRepository: 'local', repositories: [{ id: 'local', purpose: 'Selected repository', checkout: '.' }] };
  }
  const config = registrySchema.parse(value);
  const repositories = new Map();
  for (const entry of config.repositories) {
    if (repositories.has(entry.id)) throw new Error(`Duplicate repository ID: ${entry.id}`);
    if (path.isAbsolute(entry.checkout) || entry.checkout.includes('\\')) throw new Error('Registry checkout locations must be relative to the workspace root');
    repositories.set(entry.id, { ...entry, root: path.resolve(root, entry.checkout) });
  }
  if (!repositories.has(config.defaultRepository)) throw new Error('Unknown default repository');
  return { root, defaultRepository: config.defaultRepository, repositories };
}

function worktrees(entry) {
  const configured = realpathSync(entry.root);
  const common = realpathSync(path.resolve(configured, git(configured, ['rev-parse', '--git-common-dir']).trim()));
  const records = git(configured, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').filter(Boolean);
  const result = [];
  for (const record of records) {
    const fields = Object.fromEntries(record.split('\0').filter(Boolean).map(line => {
      const space = line.indexOf(' ');
      return space < 0 ? [line, true] : [line.slice(0, space), line.slice(space + 1)];
    }));
    if (!fields.worktree || fields.bare || fields.prunable) continue;
    try {
      const root = realpathSync(fields.worktree);
      const actualCommon = realpathSync(path.resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim()));
      if (actualCommon !== common) continue;
      const id = path.basename(root);
      if (!/^[A-Za-z0-9_.-]+$/.test(id)) continue;
      if (result.some(w => w.id === id)) throw new Error(`Ambiguous worktree basename ${id}; choose unique checkout names`);
      result.push({ id, root, branch: fields.branch?.replace(/^refs\/heads\//, '') ?? null,
        head: fields.HEAD, default: root === configured });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!result.some(w => w.default)) throw new Error(`Configured checkout is not a live worktree: ${entry.id}`);
  return result;
}

/** List checkout identities without loading historical source or evaluating builds. */
export function listRepositories(root, { includeWorktrees = false } = {}) {
  const config = registry(root);
  return { version: 1, defaultRepository: config.defaultRepository,
    repositories: [...config.repositories.values()].map(entry => {
      try {
        const choices = worktrees(entry);
        const selected = choices.find(w => w.default);
        return { id: entry.id, purpose: entry.purpose, available: true,
          checkout: { worktree: selected.id, branch: selected.branch, head: selected.head },
          ...(includeWorktrees ? { worktrees: choices.map(({ root, ...w }) => w) } : {}) };
      } catch (error) { return { id: entry.id, purpose: entry.purpose, available: false, error: error.message }; }
    }) };
}

function session(root, options = {}) {
  const config = registry(root);
  const contexts = new Map();
  const select = (repository, worktree) => {
    if (repository === undefined) { repository = options.repository ?? config.defaultRepository; worktree ??= options.worktree; }
    const entry = config.repositories.get(repository);
    if (!entry) throw new Error(`Unknown repository: ${repository}. List repositories first.`);
    const key = `${repository}@${worktree ?? ''}`;
    if (contexts.has(key)) return contexts.get(key);
    const choices = worktrees(entry);
    const selected = worktree ? choices.find(w => w.id === worktree) : choices.find(w => w.default);
    if (!selected) throw new Error(`Unknown worktree ${worktree} for ${repository}. List repositories with worktrees first.`);
    const selector = `${repository}${selected.default ? '' : `@${selected.id}`}`;
    const qualify = id => selector === config.defaultRepository ? id : `${selector}::${id}`;
    const context = { entry, selected, selector, qualify, metadata: { repository, worktree: selected.id,
      branch: selected.branch, head: selected.head, dirty: Boolean(git(selected.root, ['status', '--porcelain']).trim()) } };
    contexts.set(key, context);
    return context;
  };
  const index = context => context.index ??= buildIndex(context.selected.root, { roots: context.entry.roots, includeGenerated: options.includeGenerated });
  const identity = id => {
    if (typeof id !== 'string') throw new Error('Expected a component/document ID');
    const parts = id.split('::');
    if (parts.length === 1) return { context: select(), id };
    if (parts.length !== 2 || !parts[1]) throw new Error(`Invalid qualified ID: ${id}`);
    const selector = parts[0].split('@');
    if (selector.length > 2 || selector.some(p => !p)) throw new Error(`Invalid repository selector: ${parts[0]}`);
    return { context: select(selector[0], selector[1] ?? undefined), id: parts[1] };
  };
  return { config, select, index, identity };
}

function selections(state, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 12) throw new Error('Select 1-12 distinct IDs');
  const result = ids.map(state.identity);
  const keys = result.map(({ context, id }) => `${context.selector}::${id}`);
  if (new Set(keys).size !== keys.length) throw new Error('Select distinct IDs, including aliases of the default repository');
  return result;
}

/** Discover one explicitly selected checkout, returning IDs usable in a mixed batch. */
export function scanWorkspace(root, options = {}) {
  const state = session(root, options);
  const context = state.select();
  const result = listComponents(state.index(context), options);
  return { ...result, checkout: context.metadata,
    components: result.components.map(c => ({ ...c, id: context.qualify(c.id) })) };
}

// Literal module/go_package paths are evidence; generator-specific import rewrites
// are not evaluated. Explicit @see links bridge those contracts without guessing.
function linksFor(state, context, item) {
  const links = [];
  const add = link => { if (!links.some(l => l.id === link.id && l.relation === link.relation)) links.push(link); };
  const tags = [item.documentation, ...item.symbols.map(s => s.documentation)].flatMap(d => d.tags);
  for (const tag of tags.filter(t => t.name === 'see')) {
    if (!tag.text.includes('::') && !/^[\w./-]+\.(?:go|proto|sql|[cm]?[jt]sx?)(?:#[\w.-]+)?$/.test(tag.text)) continue;
    try {
      const target = tag.text.includes('::') ? state.identity(tag.text) : { context, id: tag.text };
      const [name, symbol] = target.id.split('#');
      const id = name.replace(/\.(?:go|proto|sql|[cm]?[jt]sx?)$/, '');
      const module = state.index(target.context).modules.get(id);
      const valid = module && (!symbol || module.symbols.some(s => s.name === symbol));
      add({ id: target.context.qualify(id), relation: 'documented @see', available: Boolean(valid), ...(symbol ? { symbol } : {}) });
    } catch (error) { add({ id: tag.text, relation: 'documented @see', available: false, error: error.message }); }
  }
  if (item.language === 'go') for (const entry of state.config.repositories.values()) {
    if (entry.id === context.entry.id) continue;
    let target, modulePath;
    try {
      target = state.select(entry.id, undefined);
      if (target.modulePath === undefined) {
        try { target.modulePath = parseGo([], read(target.selected.root, entry.moduleFile ?? 'go.mod')).modulePath; }
        catch (error) { if (error.code !== 'ENOENT') throw error; target.modulePath = ''; }
      }
      modulePath = target.modulePath;
    } catch { continue; }
    if (!modulePath && !entry.protocols) continue;
    for (const dependency of item.externalImports) {
      const specifier = dependency.specifier;
      if (modulePath && specifier !== modulePath && !specifier.startsWith(`${modulePath}/`)) continue;
      const directory = modulePath ? specifier.slice(modulePath.length + 1) || '.' : undefined;
      for (const candidate of state.index(target).modules.values()) {
        const goPackage = candidate.goPackage?.split(';')[0];
        if (!candidate.test && (candidate.language === 'go' && candidate.area === directory || goPackage && (goPackage === specifier || specifier.startsWith(`${goPackage}/`)))) {
          add({ id: target.qualify(candidate.id), relation: 'Go import across configured checkouts (version not verified)', specifier, available: true });
        }
      }
    }
  }
  return { links: links.slice(0, 100), total: links.length, truncated: links.length > 100 };
}

/** Batch component details across repositories/worktrees with explicit provenance. */
export function inspectWorkspace(root, ids, options = {}) {
  const state = session(root, options);
  const selected = selections(state, ids);
  const components = selected.map(({ context, id }) => {
    const index = state.index(context);
    const item = inspectComponents(index, [id], options).components[0];
    return { ...item, id: context.qualify(item.id), checkout: context.metadata,
      dependencies: item.dependencies.map(d => ({ ...d, id: context.qualify(d.id) })),
      dependents: item.dependents.map(context.qualify), relatedTests: item.relatedTests.map(t => ({ ...t, id: context.qualify(t.id) })),
      relatedComponents: linksFor(state, context, index.modules.get(id)) };
  });
  return { version: 1, components, testNote: 'Import/same-package links are navigation, not coverage. No build-tag evaluation or cross-repository version compatibility is asserted.' };
}

/** Document catalogs are owned by the selected checkout, never a merged archive dump. */
export function workspaceDocuments(root, options = {}) {
  const state = session(root, options);
  const context = state.select();
  const result = listDocuments(context.selected.root, options);
  return { ...result, checkout: context.metadata, documents: result.documents.map(d => ({ ...d, id: context.qualify(d.id) })) };
}

/** Read only selected catalog IDs, with the same repository/worktree identity rules. */
export function inspectWorkspaceDocuments(root, ids, options = {}) {
  const state = session(root, options);
  return { version: 1, documents: selections(state, ids).map(({ context, id }) => {
    const doc = inspectDocuments(context.selected.root, [id]).documents[0];
    return { ...doc, id: context.qualify(doc.id), checkout: context.metadata };
  }) };
}

/** Check the selected checkout and source-adjacent navigation targets, without mutating forks. */
export function checkWorkspace(root, options = {}) {
  if (options.allRepositories) {
    if (options.repository || options.worktree) throw new Error('Select all repositories or one checkout, not both');
    const results = [...registry(root).repositories.keys()].map(repository => {
      try { return { repository, ...checkWorkspace(root, { ...options, allRepositories: false, repository, crossRepository: true }) }; }
      catch (error) { return { repository, ok: false, issues: [error.message] }; }
    });
    return { ok: results.every(r => r.ok), repositories: results };
  }
  const state = session(root, options);
  const context = state.select();
  const index = state.index(context);
  const result = checkDocumentation(index);
  for (const item of options.crossRepository ? index.modules.values() : []) {
    const references = [item.documentation, ...item.symbols.map(s => s.documentation)].flatMap(d => d.tags).filter(t => t.name === 'see' && t.text.includes('::'));
    if (!references.length) continue;
    for (const link of linksFor(state, context, item).links) if (!link.available) result.issues.push(`${item.path}: unresolved ${link.id}`);
  }
  return { ...result, ok: !result.issues.length, checkout: context.metadata };
}

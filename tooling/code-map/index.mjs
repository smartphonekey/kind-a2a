// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Builds a fresh structural map without importing or executing repository modules.
 * @module
 * @remarks Source comments own explanations; language ASTs own declarations and imports.
 * Related tests are static relationships, not coverage or evidence of a passing run.
 */
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { read, safePath, excluded } from './files.mjs';
import { parseGo } from './go-adapter.mjs';
import { parseProto, parseSql } from './schema-parser.mjs';

const MAX_BATCH = 12;
const sourceRoots = new Set(['src', 'web', 'scripts', 'tooling', 'ops']);
const extension = /\.(?:[cm]?[jt]sx?|go|proto|sql)$/;
const scriptExtension = /\.[cm]?[jt]sx?$/;
const testFile = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|_test\.go)$/;
const documentSchema = z.object({
  version: z.literal(1),
  documents: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/), path: z.string().min(1),
    title: z.string().min(1), purpose: z.string().min(1),
    kind: z.enum(['operations', 'architecture', 'contribution', 'verification', 'navigation', 'historical', 'legal'])
  }).strict())
}).strict();

function walk(node, callback) {
  callback(node);
  ts.forEachChild(node, child => walk(child, callback));
}

function commentText(comment) {
  return (ts.getTextOfJSDocComment(comment) ?? '').trim();
}

function documentation(node, omitModule = false) {
  const blocks = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc)
    .filter(block => !omitModule || !block.tags?.some(tag => tag.tagName.text === 'module'));
  return {
    description: blocks.map(block => commentText(block.comment)).filter(Boolean).join('\n\n'),
    tags: blocks.flatMap(block => [...(block.tags ?? [])].map(tag => ({
      name: tag.tagName.text,
      // TypeScript can split a slash/hash in @see between name and comment.
      // Its source range preserves the actual path without inventing whitespace.
      text: tag.tagName.text === 'see'
        ? tag.getSourceFile().text.slice(tag.tagName.end, tag.end).split(/\r?\n/).map(line => line.replace(/^\s*\* ?/, '')).join('\n').trim()
        : [tag.name?.getText(), commentText(tag.comment)].filter(Boolean).join(' ')
    })))
  };
}

function moduleDocumentation(source) {
  for (const range of ts.getLeadingCommentRanges(source.text, 0) ?? []) {
    const text = source.text.slice(range.pos, range.end);
    if (!text.startsWith('/**')) continue;
    const parsed = ts.createSourceFile('overview.ts', `${text}\nexport const overview = 0;`, ts.ScriptTarget.Latest, true);
    const doc = documentation(parsed.statements[0]);
    if (doc.tags.some(tag => tag.name === 'module')) return doc;
  }
  return { description: '', tags: [] };
}

function signature(node, source) {
  const body = node.body ?? node.initializer?.body;
  const end = body?.getStart(source) ?? node.members?.pos ?? node.end;
  return source.text.slice(node.getStart(source), end).replace(/\{\s*$/, '').trim().slice(0, 800);
}

function symbols(source) {
  const result = [];
  const add = (node, name, exported, parent) => {
    const start = node.getStart(source);
    result.push({ name: parent ? `${parent}.${name}` : name, kind: ts.SyntaxKind[node.kind], exported,
      line: source.getLineAndCharacterOfPosition(start).line + 1,
      endLine: source.getLineAndCharacterOfPosition(node.end).line + 1,
      signature: signature(node, source), documentation: documentation(node, true),
      start, end: node.end });
  };
  for (const statement of source.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
    const exported = modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        add(declaration, declaration.name.getText(source), exported);
        const item = result.at(-1);
        item.documentation = documentation(statement, true);
      }
    } else if (statement.name && (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement))) {
      const name = statement.name.getText(source);
      add(statement, name, exported);
      for (const member of statement.members ?? []) {
        if (member.name || ts.isConstructorDeclaration(member)) add(member, member.name?.getText(source) ?? 'constructor', false, name);
      }
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) add(element, element.name.text, true);
      } else add(statement, statement.exportClause?.getText(source) ?? '*', true);
    } else if (ts.isExportAssignment(statement) || (exported && ts.isFunctionDeclaration(statement))) {
      add(statement, 'default', true);
    }
  }
  return result;
}

/**
 * Parse a fresh checkout snapshot without running its packages, generators or SQL.
 * Generated/vendor output is hidden by default; Go imports link packages, not calls.
 * Build tags are not evaluated, so coexisting platform variants are navigation
 * candidates, not a claim that those files compile together.
 */
export function buildIndex(directory, { includeGenerated = false, roots } = {}) {
  const root = realpathSync(directory);
  const gitRoot = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  if (gitRoot !== root) throw new Error('Use the repository root, not a subdirectory');
  if (roots && (!Array.isArray(roots) || !roots.length || roots.some(r => r !== '.' && !/^[\w-]+(?:\/[\w-]+)*$/.test(r)))) throw new Error('Invalid source roots');
  const paths = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\0').filter(Boolean))]
    .filter(file => extension.test(file) && !file.endsWith('.d.ts') && !file.startsWith('docs/archive/') &&
      !file.split('/').some(part => excluded.has(part)) &&
      (roots ? roots.some(r => r === '.' || file.startsWith(`${r}/`)) : !scriptExtension.test(file) || sourceRoots.has(file.split('/')[0])) &&
      (includeGenerated || !file.split('/').some(part => ['gen', 'generated'].includes(part)) && !/\.(?:pb|gen|connect)\.go$/.test(file))).sort();
  if (paths.length > 2500) throw new Error('Source map exceeds the 2500-file bound');
  const modules = new Map();
  const absolute = new Map();
  const files = [];
  let totalBytes = 0;
  for (const file of paths) {
    let text;
    try { text = read(root, file); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    totalBytes += Buffer.byteLength(text);
    if (totalBytes > 32 * 1024 * 1024) throw new Error('Source map exceeds the 32 MiB bound');
    files.push({ path: file, text });
  }
  let moduleText = '';
  try { moduleText = read(root, 'go.mod'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const go = parseGo(files.filter(f => f.path.endsWith('.go')), moduleText);
  const native = new Map(go.files.map(f => [f.path, f]));
  for (const { path: file, text } of files) {
    const language = file.endsWith('.go') ? 'go' : file.endsWith('.proto') ? 'protobuf' : file.endsWith('.sql') ? 'sql' : 'typescript';
    const source = language === 'typescript' ? ts.createSourceFile(path.join(root, file), text, ts.ScriptTarget.Latest, true) : undefined;
    const parsed = language === 'go' ? native.get(file) : language === 'protobuf' ? parseProto(file, text) : language === 'sql' ? parseSql(file, text) : undefined;
    if (!includeGenerated && parsed?.generated) continue;
    const id = file.replace(extension, '');
    if (modules.has(id)) throw new Error(`Duplicate component ID: ${id}`);
    const doc = parsed?.documentation ?? moduleDocumentation(source);
    const declarations = parsed?.symbols ?? symbols(source);
    const documentedDeclaration = declarations.find(s => s.exported && s.documentation.description) ?? declarations.find(s => s.documentation.description);
    const purpose = doc.description || documentedDeclaration?.documentation.description;
    const item = { id, path: file, language, area: path.posix.dirname(file), test: testFile.test(file),
      purpose: purpose?.split(/\n\s*\n/)[0] || (parsed?.packageName ? `Package ${parsed.packageName}; inspect its declarations and dependencies.` : 'No module overview; inspect its symbols and dependencies.'),
      purposeSource: doc.description ? 'module comment' : documentedDeclaration ? `symbol ${documentedDeclaration.name}` : 'undocumented',
      documentation: doc, symbols: declarations, dependencies: [], externalImports: [], declaredTests: parsed?.testCases ?? [],
      packageName: parsed?.packageName, goPackage: parsed?.goPackage, references: parsed?.references ?? [],
      generated: parsed?.generated ?? false, imports: parsed?.imports ?? [],
      sourceHash: createHash('sha256').update(text).digest('hex'), text, source };
    modules.set(id, item);
    absolute.set(path.join(root, file), item);
  }
  if (!modules.size) throw new Error('No supported source components found; check the selected checkout and source roots');
  const host = { fileExists: file => absolute.has(file), readFile: file => absolute.get(file)?.text };
  const values = [...modules.values()];
  for (const item of modules.values()) {
    const imports = new Set(item.imports);
    if (item.source) walk(item.source, node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) imports.add(node.argument.literal.text);
      if (ts.isCallExpression(node)) {
        const first = node.arguments[0];
        if (first && ts.isStringLiteralLike(first)) {
          if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) imports.add(first.text);
          const callee = ts.isIdentifier(node.expression) ? node.expression.text :
            ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) ? node.expression.expression.text : '';
          if (item.test && ['test', 'it', 'describe', 'suite'].includes(callee)) item.declaredTests.push({ name: first.text,
            line: item.source.getLineAndCharacterOfPosition(node.getStart(item.source)).line + 1,
            endLine: item.source.getLineAndCharacterOfPosition(node.end).line + 1 });
        }
      }
    });
    for (const specifier of [...imports].sort()) {
      if (item.language === 'go') {
        const local = go.modulePath && (specifier === go.modulePath || specifier.startsWith(`${go.modulePath}/`));
        const directory = local ? specifier.slice(go.modulePath.length + 1) || '.' : undefined;
        const targets = local ? values.filter(m => m.language === 'go' && !m.test && m.area === directory) : [];
        if (targets.length) for (const target of targets) item.dependencies.push({ id: target.id, specifier, relation: 'Go package import' });
        else item.externalImports.push({ specifier, unresolvedLocal: Boolean(local) });
        continue;
      }
      if (item.language === 'protobuf') {
        const targets = values.filter(m => m.language === 'protobuf' && (m.path === specifier || m.path.endsWith(`/${specifier}`)));
        if (targets.length === 1) item.dependencies.push({ id: targets[0].id, specifier, relation: 'protobuf import' });
        else item.externalImports.push({ specifier, unresolvedLocal: false });
        continue;
      }
      const resolved = ts.resolveModuleName(specifier, item.source.fileName,
        { moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext, allowJs: true }, host).resolvedModule;
      const target = resolved && absolute.get(resolved.resolvedFileName);
      if (target) item.dependencies.push({ id: target.id, specifier });
      else item.externalImports.push({ specifier, unresolvedLocal: specifier.startsWith('.') });
    }
  }
  return { root, modules, modulePath: go.modulePath, includeGenerated };
}

function relatedTests(index, item) {
  return [...index.modules.values()].filter(m => m.test).flatMap(test => {
    if (item.language === 'go' && test.language === 'go' && test.area === item.area && test.packageName === item.packageName) {
      return [{ item: test, relation: 'same Go package (not coverage)' }];
    }
    const edge = test.dependencies.find(d => d.id === item.id);
    return edge ? [{ item: test, relation: edge.relation ?? 'direct import' }] : [];
  });
}

/** Compact discovery; offsets page the current scan, not a persistent cache. */
export function listComponents(index, { area, language, includeTests = false, offset = 0, limit = 30 } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Use offset >= 0 and limit between 1 and 100');
  const all = [...index.modules.values()].filter(m => includeTests || !m.test);
  const areas = [...new Set(all.map(m => m.area))].sort().map(id => ({ id, components: all.filter(m => m.area === id).length }));
  if (area && !areas.some(a => a.id === area || a.id.startsWith(`${area}/`))) throw new Error(`Unknown area: ${area}`);
  if (language && !['typescript', 'go', 'protobuf', 'sql'].includes(language)) throw new Error(`Unknown language: ${language}`);
  const selected = all.filter(m => (!area || m.area === area || m.area.startsWith(`${area}/`)) && (!language || m.language === language));
  return { version: 1, areas, languages: [...new Set(all.map(m => m.language))].sort(), total: selected.length, offset,
    nextOffset: offset + limit < selected.length ? offset + limit : null,
    components: selected.slice(offset, offset + limit).map(m => ({ id: m.id, path: m.path, area: m.area, language: m.language,
      purpose: m.purpose.slice(0, 240), purposeSource: m.purposeSource, documented: m.purposeSource !== 'undocumented',
      exports: m.symbols.filter(s => s.exported).slice(0, 20).map(s => s.name),
      exportCount: m.symbols.filter(s => s.exported).length, exportsTruncated: m.symbols.filter(s => s.exported).length > 20,
      relatedTestCount: relatedTests(index, m).length })) };
}

function batch(ids, collection) {
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_BATCH || new Set(ids).size !== ids.length) throw new Error(`Select 1-${MAX_BATCH} distinct IDs`);
  for (const id of ids) if (!collection.has(id)) throw new Error(`Unknown ID: ${id}. Discover available IDs first.`);
  return ids.map(id => collection.get(id));
}

/**
 * Batch details stay source-derived. Select an exact symbol or unique literal test
 * name, never both; focused reads retain test links without repeating every case.
 * Source is opt-in and bounded to 120 lines, with explicit truncation metadata.
 */
export function inspectComponents(index, ids, { symbol, testCase, source = false, offset = 0, limit = 30 } = {}) {
  if (symbol !== undefined && testCase !== undefined) throw new Error('Select a symbol or a test case, not both');
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Use offset >= 0 and limit between 1 and 100');
  const selected = batch(ids, index.modules);
  const components = selected.map(item => {
    const focused = symbol !== undefined || testCase !== undefined;
    const chosen = testCase !== undefined ? [] : symbol !== undefined ? item.symbols.filter(s => s.name === symbol) : item.symbols;
    if (symbol !== undefined && !chosen.length) throw new Error(`Unknown symbol ${symbol} in ${item.id}`);
    if (symbol !== undefined && source && chosen.length > 1) throw new Error(`Ambiguous symbol ${symbol} in ${item.id}; inspect its listed line ranges before reading source`);
    const cases = testCase !== undefined ? item.declaredTests.filter(t => t.name === testCase) : item.declaredTests;
    if (testCase !== undefined && cases.length !== 1) throw new Error(`Expected one test case named ${testCase} in ${item.id}; found ${cases.length}. Use the listed line ranges for ambiguous names.`);
    const result = { id: item.id, path: item.path, language: item.language, sourceHash: item.sourceHash,
      documentation: item.documentation, dependencies: item.dependencies, externalImports: item.externalImports,
      ...(item.packageName ? { packageName: item.packageName } : {}),
      ...(item.goPackage ? { goPackage: item.goPackage } : {}),
      ...(item.references.length ? { references: item.references } : {}),
      dependents: [...index.modules.values()].filter(m => !m.test && m.dependencies.some(d => d.id === item.id)).map(m => m.id),
      relatedTests: relatedTests(index, item).map(({ item: m, relation }) => ({ id: m.id, path: m.path, relation, caseCount: m.declaredTests.length,
        ...(focused ? {} : { cases: m.declaredTests.slice(0, 5), casesTruncated: m.declaredTests.length > 5 }) })),
      symbols: (focused ? chosen : chosen.slice(offset, offset + limit)).map(({ start, end, ...s }) => ({ ...s,
        signature: s.signature.slice(0, 800), ...(s.signature.length > 800 ? { signatureTruncated: true } : {}) })),
      symbolPage: { total: chosen.length, offset: focused ? 0 : offset, nextOffset: !focused && offset + limit < chosen.length ? offset + limit : null } };
    if (item.test && symbol === undefined) {
      result.testCases = focused ? cases : cases.slice(offset, offset + limit);
      result.testCasePage = { total: cases.length, offset: focused ? 0 : offset, nextOffset: !focused && offset + limit < cases.length ? offset + limit : null };
    }
    if (source) {
      const selection = testCase !== undefined ? cases[0] : symbol !== undefined ? chosen[0] : undefined;
      if (selection && !Number.isInteger(selection.line)) throw new Error('This parser does not provide an exact source range for the selected declaration');
      const start = selection?.line ?? 1;
      const lines = item.text.split('\n');
      const end = Math.min(selection?.endLine ?? lines.length, start + 119);
      result.source = { startLine: start, endLine: end, totalLines: lines.length,
        truncated: end < (selection?.endLine ?? lines.length), text: lines.slice(start - 1, end).join('\n') };
    }
    return result;
  });
  return { version: 1, components, testNote: 'Related tests are static import or same-Go-package relationships, not passing results or coverage. No target build or build-tag evaluation is performed.' };
}

function documents(root) {
  const parsed = documentSchema.parse(JSON.parse(read(root, 'docs/catalog.json')));
  const result = new Map();
  const paths = new Set();
  for (const doc of parsed.documents) {
    if (result.has(doc.id) || paths.has(doc.path)) throw new Error(`Duplicate document identity: ${doc.id}`);
    if (!doc.path.endsWith('.md')) throw new Error(`Document must be Markdown: ${doc.path}`);
    safePath(root, doc.path);
    result.set(doc.id, doc); paths.add(doc.path);
  }
  return result;
}

/** Discover cross-cutting purposes without bodies; history requires explicit opt-in. */
export function listDocuments(root, { includeHistorical = false } = {}) {
  return { version: 1, documents: [...documents(realpathSync(root)).values()].filter(d => includeHistorical || d.kind !== 'historical') };
}

/** Read only cataloged Markdown IDs, bounded to 24,000 characters per document. */
export function inspectDocuments(root, ids) {
  root = realpathSync(root);
  return { version: 1, documents: batch(ids, documents(root)).map(doc => {
    const text = read(root, doc.path);
    return { ...doc, text: text.slice(0, 24000), truncated: text.length > 24000 };
  }) };
}

/**
 * Check maintained module overviews and file-level documentation targets.
 * Markdown heading fragments are deliberately outside this check's scope;
 * callers must validate them separately before claiming complete link integrity.
 */
export function checkDocumentation(index) {
  const issues = [];
  const catalog = documents(index.root);
  const maintained = [...index.modules.values()].filter(m => !m.test && m.language === 'typescript' &&
    ['src/service/', 'src/reporting/', 'web/src/', 'tooling/code-map/'].some(prefix => m.path.startsWith(prefix)));
  for (const item of index.modules.values()) {
    if (maintained.includes(item) && (!item.documentation.description || !item.documentation.tags.some(t => t.name === 'module'))) issues.push(`${item.path}: missing leading @module overview`);
    for (const tag of [item.documentation, ...item.symbols.map(s => s.documentation)].flatMap(d => d.tags)) {
      if (tag.name === 'see' && /^[\w./-]+\.(?:md|[cm]?[jt]sx?|go|proto|sql)(?:#[\w.-]+)?$/.test(tag.text)) {
        try { safePath(index.root, tag.text.split('#')[0]); } catch { issues.push(`${item.path}: missing/unsafe @see ${tag.text}`); }
      }
    }
    if (maintained.includes(item)) for (const dependency of item.externalImports) if (dependency.unresolvedLocal && scriptExtension.test(dependency.specifier)) issues.push(`${item.path}: unresolved local import ${dependency.specifier}`);
  }
  return { ok: issues.length === 0, maintainedComponents: maintained.length, sourceComponents: index.modules.size,
    documentedComponents: [...index.modules.values()].filter(m => m.documentation.description).length, documents: catalog.size, issues };
}

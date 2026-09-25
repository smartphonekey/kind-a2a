// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Source-only navigation for Protocol Buffers and PostgreSQL migrations.
 * @module
 * @remarks
 * Uses protobufjs reflection/tokenization and the real PostgreSQL WASM parser.
 * Only the installed WASM is loaded; source paths are diagnostic labels, never
 * opened. No imports are fetched, codecs generated, SQL executed or DB contacted.
 * Top-level WASM initialization makes both exported adapters synchronous.
 */
import protobuf from 'protobufjs';
import { loadModule, parseSync, scanSync } from 'libpg-query';

await loadModule();

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TOKENS = 200_000;
const MAX_DEPTH = 256;
const MAX_SIGNATURE = 800;

/**
 * @typedef {object} SchemaSymbol
 * @property {string} name Qualified source name, not a resolved database identity.
 * @property {string} kind Lowercase declaration kind; SQL mutations use `alter`.
 * @property {boolean} exported Addressable declaration, false for SQL mutations/local proto types.
 * @property {number} line One-based first declaration line, excluding leading comments.
 * @property {number} endLine One-based inclusive last declaration line.
 * @property {string} signature Bounded source excerpt (SQL) or AST summary (proto).
 * @property {{description: string, tags: Array<{name: string, text: string}>}} documentation Source comments and tags only.
 */
/**
 * @typedef {object} SchemaNavigation
 * @property {{description: string, tags: Array}} documentation Leading source comments.
 * @property {SchemaSymbol[]} symbols Source-ordered declarations, with repeated ALTER targets retained.
 * @property {string[]} imports Literal proto import specifiers; empty for SQL.
 * @property {string} [packageName] Literal proto package.
 * @property {string} [goPackage] Literal go_package option, including any semicolon alias.
 * @property {{kind: string, name: string}[]} references Deduplicated syntactic references, not resolved dependencies.
 * @property {boolean} generated True only for an explicit generated-file header.
 */

function validateInput(file, text) {
  if (typeof file !== 'string' || !file || file.length > 4096) throw new TypeError('Expected a bounded source file label');
  if (typeof text !== 'string') throw new TypeError(`${file}: expected source text`);
  if (text.length > MAX_BYTES || Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    throw new RangeError(`${file}: source exceeds the 2 MiB bound`);
  }
  if (text.includes('\0') || !text.isWellFormed()) throw new SyntaxError(`${file}: NUL or ill-formed Unicode in source`);
}

function doc(comment = '') {
  const description = [];
  const tags = [];
  for (const line of (comment ?? '').split('\n')) {
    const tag = /^\s*@([A-Za-z][\w-]*)(?:\s+(.*))?$/.exec(line);
    if (tag) tags.push({ name: tag[1], text: tag[2] ?? '' });
    else if (tags.length) tags.at(-1).text = `${tags.at(-1).text}\n${line}`.trim();
    else description.push(line);
  }
  return { description: description.join('\n').trim(), tags };
}

function parseError(language, file, error) {
  return new SyntaxError(`${file}: ${language} parse failed: ${String(error.message).slice(0, 600)}`, { cause: error });
}

function referenceCollector() {
  const entries = new Map();
  return {
    add(kind, name) { if (name) entries.set(JSON.stringify([kind, name]), { kind, name }); },
    values() { return [...entries.values()]; }
  };
}

function generated(description) {
  return /^(?:code generated\b[^\n]*\bdo not edit|(?:automatically )?generated (?:file|code|by)\b|automatically generated\b)/im.test(description);
}

function protoTokens(text) {
  // The added newline makes the tokenizer's EOF-comment line accounting stable.
  const tokenizer = protobuf.tokenize(`${text}\n`, true);
  const tokens = [];
  const pairs = new Map();
  const stack = [];
  const opening = new Map([['{', '}'], ['(', ')'], ['[', ']']]);
  const closing = new Set(opening.values());
  let value;
  while ((value = tokenizer.next()) !== null) {
    if (tokens.length >= MAX_TOKENS) throw new RangeError('Protobuf token count exceeds the 200000-token bound');
    const token = { value, line: tokenizer.line, comment: tokenizer.cmnt() };
    if (value === '"' || value === "'") {
      tokenizer.next();
      tokenizer.skip(value);
      token.value = null; // Quoted contents cannot participate in declaration alignment.
    }
    const index = tokens.push(token) - 1;
    if (opening.has(token.value)) {
      stack.push(index);
      if (stack.length > MAX_DEPTH) throw new RangeError('Protobuf nesting exceeds the 256-level bound');
    } else if (closing.has(token.value)) {
      const start = stack.pop();
      if (start === undefined || opening.get(tokens[start].value) !== token.value) throw new SyntaxError('Unbalanced protobuf delimiters');
      pairs.set(start, index);
    }
  }
  if (stack.length) throw new SyntaxError('Unclosed protobuf delimiter');
  if (tokenizer.line !== text.split('\n').length + 1) {
    throw new SyntaxError('Cannot establish truthful protobuf lines: literal multiline strings are unsupported by the tokenizer');
  }
  return { tokens, pairs };
}

function protoHeader(text, tokens) {
  if (tokens[0]?.comment) return tokens[0].comment;
  const prefix = tokens.length ? text.split('\n').slice(0, tokens[0].line - 1).join('\n') : text;
  const tokenizer = protobuf.tokenize(`${prefix.trimEnd()}\n__header__`, true);
  try {
    return tokenizer.next() === '__header__' ? tokenizer.cmnt() ?? '' : '';
  } catch {
    // A block comment may end on the first code line, outside this header prefix.
    return '';
  }
}

function protoKind(node) {
  if (node instanceof protobuf.Type && !node.group) return 'message';
  if (node instanceof protobuf.Enum) return 'enum';
  if (node instanceof protobuf.Service) return 'service';
  if (node instanceof protobuf.Method) return 'rpc';
  return undefined;
}

function protoSignature(node, kind, name) {
  if (kind !== 'rpc') return `${kind} ${name}`.slice(0, MAX_SIGNATURE);
  return `rpc ${name} (${node.requestStream ? 'stream ' : ''}${node.requestType}) returns (${node.responseStream ? 'stream ' : ''}${node.responseType})`.slice(0, MAX_SIGNATURE);
}

function protoSymbols(root, tokens, pairs) {
  const symbols = [];
  const matched = new Set();
  const keywords = new Set(['message', 'enum', 'service', 'rpc']);
  const visit = (scope, start, end) => {
    for (let i = start; i < end;) {
      const first = i;
      if (tokens[i].value === 'local' || tokens[i].value === 'export') i++;
      const keyword = tokens[i]?.value;
      const name = tokens[i + 1]?.value;
      const node = keywords.has(keyword) && (keyword === 'rpc' ? scope.methods?.[name] : scope.nested?.[name]);
      let cursor = i;
      let body;
      // Align whole statements/blocks, not protobuf grammar. Declarations must
      // exist in the validated reflection tree at this exact lexical scope.
      for (; cursor < end; cursor++) {
        const value = tokens[cursor].value;
        if (value === ';') break;
        if (value === '{') { body = cursor; cursor = pairs.get(cursor); break; }
        if (pairs.has(cursor)) cursor = pairs.get(cursor);
      }
      if (cursor >= end) throw new SyntaxError('Cannot align protobuf declaration with tokenizer');
      let last = cursor;
      if (body !== undefined && tokens[last + 1]?.value === ';') last++;
      if (node && protoKind(node) === keyword) {
        if (matched.has(node)) throw new SyntaxError('Ambiguous protobuf declaration location');
        matched.add(node);
        const qualified = node.fullName.replace(/^\./, '');
        symbols.push({ name: qualified, kind: keyword, exported: node.visibility !== 'local',
          line: tokens[first].line, endLine: tokens[last].line,
          signature: protoSignature(node, keyword, qualified),
          documentation: doc(tokens[first].comment || tokens[i].comment || node.comment) });
        if (body !== undefined && keyword !== 'rpc') visit(node, body + 1, cursor);
      }
      i = last + 1;
    }
  };
  visit(root, 0, tokens.length);
  return { symbols, matched };
}

/**
 * Parse an in-memory .proto without loading imports or resolving/generating types.
 * Explicit messages, enums, services and RPCs use package-qualified names and
 * tokenizer-confirmed inclusive line ranges. Fields/enum values are not symbols;
 * their types and RPC request/response types are unresolved `type` references.
 * Source comment tags, including "see" paths and repo-qualified IDs, are preserved
 * without resolution; go_package is retained verbatim for workspace integration.
 * Parser errors, inputs over 2 MiB, excessive tokens/nesting and tokenizer line
 * ambiguity throw with the file label. In particular literal multiline strings
 * are refused because protobufjs does not count their lines. Escapes are allowed.
 * @param {string} file Diagnostic label only.
 * @param {string} text Complete source text.
 * @returns {SchemaNavigation} A synchronous, source-derived navigation record.
 */
export function parseProto(file, text) {
  validateInput(file, text);
  try {
    const { tokens, pairs } = protoTokens(text);
    const parsed = protobuf.parse(text, { keepCase: true, alternateCommentMode: true });
    const scope = parsed.package ? parsed.root.lookup(parsed.package) : parsed.root;
    const { symbols, matched } = protoSymbols(scope, tokens, pairs);
    const references = referenceCollector();
    const addType = name => { if (name && !Object.hasOwn(protobuf.types.basic, name)) references.add('type', name); };
    const pending = [scope];
    while (pending.length) {
      const node = pending.pop();
      if (protoKind(node) && !matched.has(node)) throw new SyntaxError(`No confirmed source span for ${node.fullName}`);
      for (const field of Object.values(node.fields ?? {})) { addType(field.type); addType(field.extend); }
      for (const method of Object.values(node.methods ?? {})) { addType(method.requestType); addType(method.responseType); }
      pending.push(...Object.values(node.nested ?? {}), ...Object.values(node.methods ?? {}));
    }
    const description = protoHeader(text, tokens);
    const goPackage = scope.getOption('go_package');
    return { documentation: doc(description), symbols,
      imports: [...new Set([...(parsed.imports ?? []), ...(parsed.weakImports ?? [])])],
      ...(parsed.package ? { packageName: parsed.package } : {}),
      ...(typeof goPackage === 'string' ? { goPackage } : {}),
      references: references.values(), generated: generated(description) };
  } catch (error) { throw parseError('protobuf', file, error); }
}

function sqlIdentifier(name) {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

function sqlName(value) {
  if (!value) return undefined;
  if (typeof value === 'string') return sqlIdentifier(value);
  if (Array.isArray(value)) {
    const parts = value.map(item => item.String?.sval);
    return parts.length && parts.every(part => typeof part === 'string') ? parts.map(sqlIdentifier).join('.') : undefined;
  }
  if (value.relname) return [value.catalogname, value.schemaname, value.relname].filter(Boolean).map(sqlIdentifier).join('.');
  return sqlName(value.List?.items ?? value.ObjectWithArgs?.objname ?? value.objname ?? value.names);
}

function sqlObjectKind(type = '') {
  if (['OBJECT_TABLE', 'OBJECT_VIEW', 'OBJECT_MATVIEW', 'OBJECT_FOREIGN_TABLE', 'OBJECT_SEQUENCE'].includes(type)) return 'relation';
  if (['OBJECT_FUNCTION', 'OBJECT_PROCEDURE', 'OBJECT_ROUTINE'].includes(type)) return 'function';
  if (['OBJECT_TYPE', 'OBJECT_DOMAIN'].includes(type)) return 'type';
  return type.startsWith('OBJECT_') ? type.slice(7).toLowerCase() : 'object';
}

function sqlAlterTarget(type, node) {
  const objectType = node.objtype ?? node.objectType ?? node.renameType;
  const target = node.relation ?? node.sequence ?? node.func ?? node.typeName ?? node.object ?? node.defnames;
  let name = sqlName(target);
  let kind = node.relation || node.sequence ? 'relation' : sqlObjectKind(objectType);
  if (['AlterEnumStmt', 'AlterTypeStmt', 'AlterDomainStmt'].includes(type)) {
    name = sqlName(node.typeName); kind = 'type';
  }
  if (type === 'AlterFunctionStmt') kind = 'function';
  if (!name && type === 'RenameStmt' && node.subname) name = sqlName(node.subname);
  return name ? { kind, name } : undefined;
}

function sqlDefinition(type, node, definitions) {
  const definedRelation = (value, kind) => {
    if (!value) return undefined;
    definitions.add(value);
    return { kind, name: sqlName(value) };
  };
  switch (type) {
    case 'CreateStmt': return definedRelation(node.relation, 'table');
    case 'CreateForeignTableStmt': return definedRelation(node.base?.relation, 'table');
    case 'CreateTableAsStmt': return definedRelation(node.into?.rel, node.objtype === 'OBJECT_MATVIEW' ? 'view' : 'table');
    case 'ViewStmt': return definedRelation(node.view, 'view');
    case 'CreateSeqStmt': return definedRelation(node.sequence, 'sequence');
    case 'CreateFunctionStmt':
      definitions.add(node);
      return { kind: node.is_procedure ? 'procedure' : 'function', name: sqlName(node.funcname) };
    case 'CreateTrigStmt': return { kind: 'trigger', name: `${sqlName(node.relation)}.${sqlIdentifier(node.trigname)}` };
    case 'CreateEventTrigStmt': return { kind: 'trigger', name: sqlName(node.trigname) };
    case 'CreateEnumStmt': case 'CreateRangeStmt': return { kind: 'type', name: sqlName(node.typeName) };
    case 'CompositeTypeStmt': return definedRelation(node.typevar, 'type');
    case 'CreateDomainStmt': return { kind: 'type', name: sqlName(node.domainname) };
    case 'DefineStmt': return node.kind === 'OBJECT_TYPE' ? { kind: 'type', name: sqlName(node.defnames) } : undefined;
    case 'IndexStmt':
      // PostgreSQL may choose an index name at execution time; never invent it.
      return node.idxname ? { kind: 'index', name: sqlName({ schemaname: node.relation?.schemaname, relname: node.idxname }) } : undefined;
    default:
      if (type.startsWith('Alter') || type === 'RenameStmt') {
        const target = sqlAlterTarget(type, node);
        return target ? { kind: 'alter', name: target.name } : undefined;
      }
      return undefined;
  }
}

function sqlReferences(ast, definitions, references) {
  const pending = [ast];
  let count = 0;
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (++count > MAX_TOKENS) throw new RangeError('SQL AST exceeds the 200000-node bound');
    if (!definitions.has(node)) {
      if (typeof node.relname === 'string' && typeof node.relpersistence === 'string') references.add('relation', sqlName(node));
      if (node.funcname) references.add('function', sqlName(node.funcname));
    }
    if (node.names && Object.hasOwn(node, 'typemod')) references.add('type', sqlName(node.names));
    for (const [type, child] of Object.entries(node)) {
      if (!child || typeof child !== 'object') continue;
      if (type === 'DropStmt') for (const object of child.objects ?? []) references.add(sqlObjectKind(child.removeType), sqlName(object));
      if (type.startsWith('Alter') || type === 'RenameStmt') {
        const target = sqlAlterTarget(type, child);
        if (target) references.add(target.kind, target.name);
      }
      pending.push(child);
    }
  }
}

function sqlComment(token) {
  return token.tokenName === 'SQL_COMMENT' || token.tokenName === 'C_COMMENT';
}

function sqlCommentText(token) {
  const text = token.tokenName === 'SQL_COMMENT' ? token.text.slice(2) : token.text.slice(2, -2);
  return text.split('\n').map(line => line.replace(/^\s*\* ?/, '').trim()).join('\n').trim();
}

function lineLookup(bytes) {
  const starts = [0];
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) starts.push(i + 1);
  return position => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle] <= position) low = middle + 1;
      else high = middle;
    }
    return low;
  };
}

function leadingSqlComments(tokens, first, lineAt) {
  const comments = [];
  let nextLine = lineAt(tokens[first].start);
  for (let i = first - 1; i >= 0 && sqlComment(tokens[i]); i--) {
    const token = tokens[i];
    if (nextLine - lineAt(token.end - 1) > 1) break;
    if (i > 0 && !sqlComment(tokens[i - 1]) && lineAt(tokens[i - 1].end - 1) === lineAt(token.start)) break;
    comments.unshift(sqlCommentText(token));
    nextLine = lineAt(token.start);
  }
  return comments.join('\n');
}

/**
 * Parse PostgreSQL statements/migrations without executing SQL or connecting to a DB.
 * Top-level named tables, functions/procedures, triggers, types/domains, indexes, views,
 * sequences and AST-identifiable ALTER/rename targets become symbols. Unnamed
 * indexes have no fabricated name. ALTER symbols describe mutations, not exports.
 * Ranges combine raw-statement byte boundaries with PostgreSQL scanner tokens;
 * UTF-8 offsets are never mistaken for JS character offsets. Trailing comments
 * are excluded, and a terminating semicolon is included when present.
 * References are unresolved AST names, including possible CTE relation names.
 * Quoted function/DO bodies and dynamic SQL remain opaque, so internal syntax and
 * dependencies are NOT validated/extracted. SQL-standard parsed bodies are walked.
 * No catalog, search_path, overload, psql-command or migration-template resolution
 * is attempted. Invalid/unsupported SQL and bounded-input failures throw.
 * @param {string} file Diagnostic label only.
 * @param {string} text Complete source text, at most 2 MiB / 200000 tokens.
 * @returns {SchemaNavigation} A synchronous, source-derived navigation record.
 */
export function parseSql(file, text) {
  validateInput(file, text);
  try {
    if (!text.trim()) return { documentation: doc(), symbols: [], imports: [], references: [], generated: false };
    const bytes = Buffer.from(text, 'utf8');
    const tokens = scanSync(text).tokens;
    if (tokens.length > MAX_TOKENS) throw new RangeError('SQL token count exceeds the 200000-token bound');
    const ast = parseSync(text);
    const lineAt = lineLookup(bytes);
    const symbols = [];
    const definitions = new WeakSet();
    let cursor = 0;
    for (const raw of ast.stmts) {
      const start = raw.stmt_location ?? 0;
      const end = raw.stmt_len ? start + raw.stmt_len : bytes.length;
      while (cursor < tokens.length && (tokens[cursor].start < start || sqlComment(tokens[cursor]))) cursor++;
      const first = cursor;
      let last = first - 1;
      while (cursor < tokens.length && tokens[cursor].start < end) {
        if (!sqlComment(tokens[cursor])) last = cursor;
        cursor++;
      }
      if (tokens[cursor]?.start === end && tokens[cursor].tokenType === 59) last = cursor++;
      if (last < first) throw new SyntaxError('No confirmed PostgreSQL statement span');
      const [type, node] = Object.entries(raw.stmt)[0];
      const definition = sqlDefinition(type, node, definitions);
      if (definition?.name) symbols.push({ ...definition, exported: definition.kind !== 'alter',
        line: lineAt(tokens[first].start), endLine: lineAt(tokens[last].end - 1),
        signature: bytes.subarray(tokens[first].start, tokens[last].end).toString('utf8').trim().slice(0, MAX_SIGNATURE),
        documentation: doc(leadingSqlComments(tokens, first, lineAt)) });
    }
    const references = referenceCollector();
    sqlReferences(ast, definitions, references);
    const header = [];
    for (const token of tokens) { if (!sqlComment(token)) break; header.push(sqlCommentText(token)); }
    const description = header.join('\n');
    return { documentation: doc(description), symbols, imports: [], references: references.values(), generated: generated(description) };
  } catch (error) { throw parseError('PostgreSQL', file, error); }
}

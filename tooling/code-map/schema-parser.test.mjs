// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Verifies source-only schema navigation, bounded parsing and truthful locations.
 * @module
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { parseProto, parseSql } from './schema-parser.mjs';

const symbol = (result, name) => {
  const found = result.symbols.find(item => item.name === name);
  assert.ok(found, `Missing symbol ${name}`);
  return found;
};
const excerpt = (text, item) => text.split('\n').slice(item.line - 1, item.endLine).join('\n');
const hasReference = (result, kind, name) => result.references.some(ref => ref.kind === kind && ref.name === name);

test('protobuf derives nested names, RPCs, source comments, packages and literal imports', () => {
  const text = [
    '// Public protocol.',
    '// @module',
    '// @see runner::proto/runtime',
    'syntax = "proto3";',
    'package example.v1;',
    'import "shared.proto";',
    'import public "public.proto";',
    'import weak "missing.proto";',
    'option go_package = "example.org/project/gen/v1;wire";',
    '// The enclosing message.',
    '// @see src/service/worker.ts#Worker',
    'message Outer {',
    '  // Inner payload.',
    '  message Inner { string snake_case = 1; }',
    '  enum State { UNKNOWN = 0; READY = 1; }',
    '  Inner inner = 1;',
    '  map<string, .external.Record> records = 2;',
    '}',
    '// Work service.',
    'service Worker {',
    '  // Streams results.',
    '  // @see api::internal/worker',
    '  rpc Run (stream Outer.Inner)',
    '      returns (stream Outer) {',
    '    option deprecated = true;',
    '  }',
    '  rpc Get (Outer) returns (Outer.Inner);',
    '}'
  ].join('\n');
  const parsed = parseProto('api.proto', text);
  assert.equal(parsed.then, undefined);
  assert.deepEqual(parsed.documentation, { description: 'Public protocol.', tags: [
    { name: 'module', text: '' }, { name: 'see', text: 'runner::proto/runtime' }
  ] });
  assert.equal(parsed.packageName, 'example.v1');
  assert.equal(parsed.goPackage, 'example.org/project/gen/v1;wire');
  assert.deepEqual(parsed.imports, ['shared.proto', 'public.proto', 'missing.proto']);
  assert.deepEqual(parsed.symbols.map(item => [item.name, item.kind, item.line, item.endLine]), [
    ['example.v1.Outer', 'message', 12, 18], ['example.v1.Outer.Inner', 'message', 14, 14],
    ['example.v1.Outer.State', 'enum', 15, 15], ['example.v1.Worker', 'service', 20, 28],
    ['example.v1.Worker.Run', 'rpc', 23, 26], ['example.v1.Worker.Get', 'rpc', 27, 27]
  ]);
  assert.deepEqual(symbol(parsed, 'example.v1.Outer').documentation.tags, [{ name: 'see', text: 'src/service/worker.ts#Worker' }]);
  assert.equal(symbol(parsed, 'example.v1.Worker.Run').documentation.description, 'Streams results.');
  assert.deepEqual(symbol(parsed, 'example.v1.Worker.Run').documentation.tags, [{ name: 'see', text: 'api::internal/worker' }]);
  assert.equal(symbol(parsed, 'example.v1.Worker.Run').signature, 'rpc example.v1.Worker.Run (stream Outer.Inner) returns (stream Outer)');
  assert.ok(hasReference(parsed, 'type', '.external.Record'));
  assert.ok(!hasReference(parsed, 'type', 'string'));
  assert.ok(excerpt(text, symbol(parsed, 'example.v1.Worker.Run')).endsWith('  }'));
});

test('protobuf tokenizer ignores comment/string/option noise and preserves multiline declaration spans', () => {
  const text = String.raw`/* message Fake { service Wrong {} } */
syntax = "proto2";
option java_package = "message Fake { enum Noise { ZERO=0; } }";
// Real declaration.
message
Real
{
  optional string value = 1 [default = "escaped \" ; } message Other {}"];
  option (example.meta) = { message: "Child" nested: { rpc: "Call" } };
  // Child declaration.
  message Child {
    optional string rpc = 1;
  }
}
// service Ghost { rpc Go (Real) returns (Real); }
`;
  const parsed = parseProto('noise.proto', text);
  assert.deepEqual(parsed.symbols.map(item => [item.name, item.line, item.endLine]), [['Real', 5, 14], ['Real.Child', 11, 13]]);
  assert.equal(symbol(parsed, 'Real').documentation.description, 'Real declaration.');
  assert.equal(parsed.generated, false);
  const crlf = parseProto('crlf.proto', text.replaceAll('\n', '\r\n'));
  assert.deepEqual(crlf.symbols, parsed.symbols);
});

test('protobuf keeps sibling lexical scopes and explicit edition visibility', () => {
  const parsed = parseProto('scope.proto', `edition = "2024";
package p;
local message A { message Same {} }
export message B { message Same {} }
service One { rpc Same (A) returns (B); }
service Two { rpc Same (B) returns (A); }`);
  assert.deepEqual(parsed.symbols.map(item => item.name), ['p.A', 'p.A.Same', 'p.B', 'p.B.Same', 'p.One', 'p.One.Same', 'p.Two', 'p.Two.Same']);
  assert.equal(symbol(parsed, 'p.A').exported, false);
  assert.equal(symbol(parsed, 'p.B').exported, true);
});

test('protobuf generated headers are not inferred from string literals', () => {
  assert.equal(parseProto('generated.proto', '// Code generated by a tool. DO NOT EDIT.\nsyntax = "proto3";').generated, true);
  assert.equal(parseProto('source.proto', 'option java_package = "Code generated by a tool. DO NOT EDIT.";').generated, false);
  assert.equal(parseProto('handwritten.proto', '// This is not a generated file.\nsyntax = "proto3";').generated, false);
  assert.equal(parseProto('comments.proto', '// Ordinary source.\n').symbols.length, 0);
});

test('protobuf retains structured header tags across blank lines and in comment-only files', () => {
  const header = '/** Source contract.\n * @module\n * @see runners::internal/guard\n * @see src/service/worker.ts\n */\n\n';
  const expected = { description: 'Source contract.', tags: [
    { name: 'module', text: '' }, { name: 'see', text: 'runners::internal/guard' }, { name: 'see', text: 'src/service/worker.ts' }
  ] };
  assert.deepEqual(parseProto('header.proto', `${header}syntax = "proto3";`).documentation, expected);
  assert.deepEqual(parseProto('comments.proto', header).documentation, expected);
});

test('protobuf rejects malformed syntax and refuses known tokenizer line ambiguity', () => {
  for (const text of [
    'syntax = "proto3"; message Broken {',
    'message Broken { string field = ; }',
    'message Bad { string first = 1; string second = 1; }',
    'message Broken { string field = 1; } /* unfinished',
    'option java_package = "unterminated;',
    'this is not protobuf;'
  ]) assert.throws(() => parseProto('broken.proto', text), /broken\.proto: protobuf parse failed:/);
  assert.throws(() => parseProto('lines.proto', 'option java_package = "a\nb";\nmessage M {}'), /truthful protobuf lines/);
  assert.equal(parseProto('escapes.proto', String.raw`option java_package = "a\nb";
message M {}`).symbols[0].line, 2);
});

test('PostgreSQL definitions and ALTER targets come from AST with exact source ranges', () => {
  const text = [
    '-- Runtime schema.',
    '-- @module',
    '-- @see api::internal/runtime',
    'CREATE TABLE public.jobs (',
    '  id bigint PRIMARY KEY,',
    '  parent_id bigint REFERENCES public.parents(id),',
    '  state public.job_state',
    ');',
    '-- Valid states.',
    "CREATE TYPE public.job_state AS ENUM ('new', 'done');",
    'CREATE INDEX jobs_parent ON public.jobs(parent_id);',
    'ALTER TABLE public.jobs',
    '  ADD COLUMN detail text;',
    'ALTER TYPE public.job_state ADD VALUE \'failed\';',
    'CREATE TYPE public.payload AS (body text);',
    'CREATE DOMAIN public.label AS text;',
    'CREATE TYPE public.window AS RANGE (subtype = int8);',
    'CREATE TYPE public.shell;',
    '-- No statement here: CREATE TABLE fake (id int);'
  ].join('\n');
  const parsed = parseSql('schema.sql', text);
  assert.equal(parsed.then, undefined);
  assert.deepEqual(parsed.imports, []);
  assert.deepEqual(parsed.documentation, { description: 'Runtime schema.', tags: [
    { name: 'module', text: '' }, { name: 'see', text: 'api::internal/runtime' }
  ] });
  assert.deepEqual(parsed.symbols.map(item => [item.name, item.kind, item.line, item.endLine]), [
    ['public.jobs', 'table', 4, 8], ['public.job_state', 'type', 10, 10], ['public.jobs_parent', 'index', 11, 11],
    ['public.jobs', 'alter', 12, 13], ['public.job_state', 'alter', 14, 14], ['public.payload', 'type', 15, 15],
    ['public.label', 'type', 16, 16], ['public.window', 'type', 17, 17], ['public.shell', 'type', 18, 18]
  ]);
  assert.equal(parsed.symbols[3].exported, false);
  assert.equal(symbol(parsed, 'public.job_state').documentation.description, 'Valid states.');
  assert.ok(hasReference(parsed, 'relation', 'public.parents'));
  assert.ok(hasReference(parsed, 'type', 'public.job_state'));
  assert.ok(hasReference(parsed, 'relation', 'public.jobs'));
  assert.equal(excerpt(text, parsed.symbols[3]), 'ALTER TABLE public.jobs\n  ADD COLUMN detail text;');
  assert.ok(!parsed.references.some(ref => ref.name === 'public.payload' || ref.name === 'fake'));
});

test('PostgreSQL dollar bodies are opaque; internal semicolons and escaped strings cannot split statements', () => {
  const text = String.raw`-- Trigger function.
-- @see runners::internal/guard
CREATE OR REPLACE FUNCTION public.guard()
RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  PERFORM 'escaped '' quote; CREATE TABLE phantom (id int);';
  EXECUTE 'CREATE TABLE dynamic_only (id int)';
  RETURN NEW;
END;
$body$;
CREATE TRIGGER check_job
BEFORE INSERT ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public.guard();
CREATE TABLE public.audit (
  note text DEFAULT E'escaped \'quote; -- not a comment',
  message text DEFAULT 'CREATE FUNCTION fake() RETURNS int;'
);
DO $$ BEGIN EXECUTE 'DROP TABLE phantom'; END; $$;`;
  const parsed = parseSql('bodies.sql', text);
  assert.deepEqual(parsed.symbols.map(item => [item.name, item.line, item.endLine]), [
    ['public.guard', 3, 10], ['public.jobs.check_job', 11, 13], ['public.audit', 14, 17]
  ]);
  assert.deepEqual(parsed.symbols[0].documentation.tags, [{ name: 'see', text: 'runners::internal/guard' }]);
  assert.ok(hasReference(parsed, 'function', 'public.guard'));
  assert.ok(hasReference(parsed, 'relation', 'public.jobs'));
  assert.ok(!parsed.references.some(ref => /phantom|dynamic_only|fake/.test(ref.name)));
  assert.equal(excerpt(text, parsed.symbols[0]).split('\n').at(-1), '$body$;');
  // PostgreSQL's raw parser does not validate the contents of string bodies.
  assert.equal(parseSql('opaque.sql', 'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ NOT VALID SQL $$;').symbols.length, 1);
});

test('PostgreSQL walks SQL-standard bodies, DML, nested queries and drop references', () => {
  const parsed = parseSql('references.sql', `CREATE FUNCTION app.lookup() RETURNS int LANGUAGE sql
BEGIN ATOMIC
  SELECT app.transform(id) FROM app.source;
  SELECT 1;
END;
INSERT INTO app.target SELECT id FROM app.source WHERE EXISTS (SELECT 1 FROM app.guard);
UPDATE app.target SET id = app.transform(id);
DELETE FROM app.old;
DROP TABLE app.obsolete;
DROP FUNCTION app.removed(int);
CREATE VIEW app.visible AS SELECT * FROM app.source;
CREATE TABLE app.copied AS SELECT * FROM app.visible;
CREATE INDEX ON app.target(id);`);
  assert.deepEqual(parsed.symbols.map(item => item.name), ['app.lookup', 'app.visible', 'app.copied']);
  for (const name of ['app.source', 'app.target', 'app.guard', 'app.old', 'app.obsolete', 'app.visible']) {
    assert.ok(hasReference(parsed, 'relation', name), name);
  }
  for (const name of ['app.transform', 'app.removed']) assert.ok(hasReference(parsed, 'function', name), name);
  assert.ok(!hasReference(parsed, 'function', 'app.lookup'));
  assert.equal(parsed.symbols[0].endLine, 5);
  assert.equal(parsed.references.filter(ref => ref.name === 'app.transform').length, 1);
});

test('PostgreSQL uses UTF-8 offsets, quoted identifiers, CRLF and excludes trailing comments', () => {
  const text = '-- \u00e9\r\n/* Nested /* CREATE TABLE nope(i int); */ header */\r\nCREATE TABLE "caf\u00e9"."a.b"\r\n(\r\n "quote""name" text DEFAULT \'\u00e9;\'\r\n); -- previous statement only\r\n\r\n-- Second table.\r\nCREATE TABLE last_table (id int)\r\n-- trailing comment\r\n';
  const parsed = parseSql('unicode.sql', text);
  assert.deepEqual(parsed.symbols.map(item => [item.name, item.line, item.endLine]), [['"caf\u00e9"."a.b"', 3, 6], ['last_table', 9, 9]]);
  assert.equal(parsed.symbols[1].documentation.description, 'Second table.');
  assert.equal(parsed.symbols[1].signature, 'CREATE TABLE last_table (id int)');
  assert.ok(!parsed.symbols[0].signature.includes('previous statement'));
  assert.equal(parseSql('empty.sql', '').symbols.length, 0);
  assert.equal(parseSql('comments.sql', '-- comment only\n/* still no SQL */').symbols.length, 0);
  assert.equal(parseSql('generated.sql', '-- Code generated by tool. DO NOT EDIT.\nSELECT 1;').generated, true);
});

test('PostgreSQL indexes ALTER function, type, relation and rename targets without inventing new declarations', () => {
  const parsed = parseSql('alter.sql', `ALTER FUNCTION app.fn(int) IMMUTABLE;
ALTER TYPE app.state RENAME TO other;
ALTER DOMAIN app.label SET NOT NULL;
ALTER TABLE app.jobs RENAME COLUMN a TO b;
ALTER INDEX app.idx RENAME TO next_idx;
ALTER SEQUENCE app.seq INCREMENT BY 2;`);
  assert.deepEqual(parsed.symbols.map(item => [item.kind, item.name, item.exported]), [
    ['alter', 'app.fn', false], ['alter', 'app.state', false], ['alter', 'app.label', false],
    ['alter', 'app.jobs', false], ['alter', 'app.idx', false], ['alter', 'app.seq', false]
  ]);
  assert.ok(hasReference(parsed, 'function', 'app.fn'));
  assert.ok(hasReference(parsed, 'type', 'app.state'));
  assert.ok(!parsed.references.some(ref => ref.name.endsWith('other') || ref.name.endsWith('next_idx')));
});

test('PostgreSQL reports syntax failures, including statements following valid SQL', () => {
  for (const text of [
    'CREATE TABLE broken (id int;',
    'CREATE TABLE okay (id int);\nCREATE TABLE broken (id);',
    "SELECT 'unterminated;", 'SELECT $body$unterminated;',
    '/* unclosed comment', '\\i other.sql', 'CREATE TABLE {{ template }} (id int);'
  ]) assert.throws(() => parseSql('broken.sql', text), /broken\.sql: PostgreSQL parse failed:/);
});

test('both adapters bound input, reject NUL truncation and do not return partial results', () => {
  for (const parse of [parseProto, parseSql]) {
    assert.throws(() => parse('large', ' '.repeat(2 * 1024 * 1024 + 1)), /2 MiB/);
    assert.throws(() => parse('large-utf8', '\u00e9'.repeat(1024 * 1024 + 1)), /2 MiB/);
    assert.throws(() => parse('nul', '\0'), /NUL/);
    assert.throws(() => parse('unicode', '\ud800'), /Unicode/);
    assert.throws(() => parse('type', null), /expected source text/);
    assert.throws(() => parse('', ''), /file label/);
    assert.throws(() => parse('tokens', ';'.repeat(200_001)), /token.*bound/i);
  }
  assert.throws(() => parseProto('depth.proto', '{'.repeat(257)), /nesting.*bound/);
  const largeSignature = parseSql('signature.sql', `CREATE TABLE long_table (note text DEFAULT '${'x'.repeat(2000)}');`);
  assert.equal(largeSignature.symbols[0].signature.length, 800);
});

test('parsing never fetches imports, reads source labels, generates codecs or executes source', () => {
  const moduleUrl = new URL('./schema-parser.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import protobuf from 'protobufjs';
    import fs from 'node:fs';
    import net from 'node:net';
    import http from 'node:http';
    import https from 'node:https';
    import childProcess from 'node:child_process';
    globalThis.fetch = () => { throw new Error('Unexpected network fetch'); };
    const { parseProto, parseSql } = await import(${JSON.stringify(moduleUrl)});
    const denied = () => { throw new Error('Unexpected source IO, execution or code generation'); };
    protobuf.load = protobuf.loadSync = protobuf.Root.prototype.load = protobuf.Root.prototype.loadSync = denied;
    protobuf.Type.prototype.setup = protobuf.util.codegen = denied;
    protobuf.util.fetch = denied;
    fs.readFileSync = fs.readFile = fs.writeFileSync = fs.writeFile = denied;
    net.Socket.prototype.connect = http.get = http.request = https.get = https.request = denied;
    childProcess.exec = childProcess.execSync = childProcess.execFile = childProcess.execFileSync = childProcess.spawn = childProcess.spawnSync = denied;
    assert.equal(parseProto('https://invalid.example/source.proto', 'syntax="proto3"; import "https://invalid.example/missing.proto"; message M { .missing.Type body = 1; }').symbols.length, 1);
    const sql = "COPY users TO PROGRAM 'touch /tmp/never-execute-schema-source'; CREATE FUNCTION script() RETURNS text LANGUAGE plv8 AS $$ globalThis.schemaExecuted = true; $$; DO $$ BEGIN EXECUTE 'DROP TABLE users'; END; $$;";
    assert.equal(parseSql('/missing/do-not-open.sql', sql).symbols.length, 1);
    assert.equal(globalThis.schemaExecuted, undefined);
    process.stdout.write('source-only');
  `;
  assert.equal(execFileSync(process.execPath, ['--disallow-code-generation-from-strings', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024
  }), 'source-only');
});

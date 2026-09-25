// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Read-only CLI for progressive discovery and code-adjacent documentation checks.
 * @module
 * @remarks JSON is the default output. No command runs agent tasks or repository code.
 */
import { parseArgs } from 'node:util';
import { buildIndex, listComponents, inspectComponents, listDocuments, inspectDocuments, checkDocumentation } from './index.mjs';

const help = `code-map scan [--area AREA] [--offset N] [--limit N] [--include-tests]
code-map inspect COMPONENT... [--symbol NAME | --test-case NAME] [--source]
code-map docs [--include-historical]
code-map doc DOCUMENT...
code-map check
Use --root PATH for an explicit repository root. Output is JSON.
Discover IDs with scan/docs before inspecting a bounded batch. Source is opt-in.`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    root: { type: 'string', default: process.cwd() }, area: { type: 'string' },
    offset: { type: 'string', default: '0' }, limit: { type: 'string', default: '30' },
    symbol: { type: 'string' }, 'test-case': { type: 'string' }, source: { type: 'boolean', default: false },
    'include-tests': { type: 'boolean', default: false }, 'include-historical': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false }
  }});
  if (values.help) { console.log(help); }
  else {
    const [command, ...ids] = positionals;
    if (!['scan', 'inspect', 'docs', 'doc', 'check'].includes(command)) throw new Error(help);
    if (!['inspect', 'doc'].includes(command) && ids.length) throw new Error(`Unexpected IDs for ${command}`);
    let result;
    if (command === 'docs') result = listDocuments(values.root, { includeHistorical: values['include-historical'] });
    else if (command === 'doc') result = inspectDocuments(values.root, ids);
    else {
      const index = buildIndex(values.root);
      if (command === 'scan') result = listComponents(index, { area: values.area, offset: Number(values.offset), limit: Number(values.limit), includeTests: values['include-tests'] });
      if (command === 'inspect') result = inspectComponents(index, ids, { symbol: values.symbol, testCase: values['test-case'], source: values.source });
      if (command === 'check') { result = checkDocumentation(index); if (!result.ok) process.exitCode = 1; }
    }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}

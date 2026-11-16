import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialize, ParseError } from '../dist/index.js';
import { preprocess } from '../dist/preprocess.js';

// Refusal offsets from pinned unicode generation 5 rows: the raw-tree
// boundary reports UTF-8 offsets into the prepared grammar text, the typed
// model boundary into the caller's input. The same vectors pin umath-rs.
const REFUSALS = [
  ['α&b', 8, 3],
  ['⟨a', 9, 4],
  ['▒', 1, 0],
  ['α⁡', 15, 5],
];

const offset = (parse) => {
  try { parse(); } catch (error) {
    assert.ok(error instanceof ParseError, String(error));
    return error.byteOffset;
  }
  assert.fail('expected a parse refusal');
};

test('typed refusals report caller offsets, prepared raw refusals grammar offsets', async () => {
  const parser = await initialize();
  for (const [input, grammar, caller] of REFUSALS) {
    assert.equal(offset(() => parser.parsePreparedTree(preprocess(input).text)), grammar, `${input} raw`);
    assert.equal(offset(() => parser.parse(input)), caller, `${input} typed`);
    assert.equal(offset(() => parser.parseTree(input)), caller, `${input} public tree`);
  }
  // Leading spaces and a trailing label move the caller offset, not the
  // grammar offset.
  const labelled = '  α&b#(1)';
  assert.equal(offset(() => parser.parsePreparedTree(preprocess(labelled).text)), 8);
  assert.equal(offset(() => parser.parse(labelled)), 5);
});

// Run: node src/onenote-errors.check.ts — the plain-language messages for OneNote files that will not open.
import assert from 'node:assert/strict';
import { explainOneNoteError } from './onenote-errors.ts';

const empty = explainOneNoteError(
  'Malformed OneStore data: Root file node list did not contain a node with the root ID (in vendor/onenote_parser/src/onestore/desktop/objects/root_file_node_list.rs:38)',
  'Formal Lang and Automata.one',
);
assert.match(empty, /empty OneNote section/);
assert.match(empty, /Formal Lang and Automata\.one/);
assert.match(empty, /File → Export → Section/);
assert.ok(!empty.includes('root_file_node_list.rs'), 'no source paths for the person to read');

const damaged = explainOneNoteError(
  'Malformed OneNote file data: Unknown node consumed more bytes than declared size. Node type: 0x1, consumed: 4, declared: 0',
  'x.one',
);
assert.match(damaged, /damaged, cut short/);
assert.match(
  damaged,
  /Detail: Malformed OneNote file data/,
  'the technical detail stays, for a report',
);

assert.equal(explainOneNoteError('something new', 'y.one'), "Couldn't open y.one: something new");
assert.equal(explainOneNoteError('', 'z.one'), "Couldn't open z.one: unknown error");
console.log('onenote-errors checks passed');

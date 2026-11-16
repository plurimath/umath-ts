// Run from a clean consumer with the packed tarball installed: loads the
// package through its specifier, parses synchronously under the default
// policy and under the producer's Parslet policy with Deepest refusals.
import assert from 'node:assert/strict';
const umath = await import('@plurimath/umath-ts');
await umath.initialize();
const tree = umath.parseTree('a+b');
assert.ok(tree && !(tree instanceof Promise), 'parseTree is synchronous');
assert.deepEqual(umath.parseShape('a+b', { compatibility: 'parslet', reporter: 'deepest' }), umath.parseShape('a+b'));
assert.ok(umath.parse('(a+b)/c'), 'typed model parse');
console.log(`packed-node: ok on ${process.version}`);

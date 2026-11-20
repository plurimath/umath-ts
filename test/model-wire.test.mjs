import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { initialize } from "../dist/index.js";
import { model } from "../scripts/model-wire.mjs";

// These few rows are copied unchanged from checksum-verified Ruby payloads.
// Fixture metadata records the testsuite revision, payload hashes and IDs.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/model-wire.json", import.meta.url), "utf8"));
assert.ok(fixture.cases.length > 0, "focused oracle rows must not be empty");
let stage;
before(async () => { stage = await initialize(); });
for (const row of fixture.cases) test(`pinned Ruby model wire: ${row.id}`, () => {
  const expected = JSON.parse(JSON.stringify(row.expected.tree).replaceAll('"Unicodemath::Model::', '"Umath::Model::'));
  const actual = stage.parse(row.input.str, { ...row.options, compatibility: "parslet", reporter: "deepest" });
  assert.deepEqual(model(actual), expected);
  // A mutated public field must be visible to the same projection used in CI.
  const changed = Object.assign(Object.create(Object.getPrototypeOf(actual)), actual, { decimal: "changed" });
  assert.notDeepEqual(model(changed), expected);
});
test("wire refuses objects outside the generated model contract", () => {
  assert.throws(() => model({}), /not a generated model/);
});

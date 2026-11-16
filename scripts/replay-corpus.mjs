// Replays a pinned plurimath-testsuite unicode stage generation through this
// package.
//
//   node scripts/replay-corpus.mjs <testsuite-checkout> [--pin FILE]
//     [--limit N] [--group NAME[,NAME...]] [--report FILE] [--executed FILE]
//
// --pin names a pin file in scripts/ (default corpus-pin.json). Before any row
// runs, the generation's files must hash to the pinned snapshot digest and
// provenance, and each payload to its recorded size and SHA-256.
//
// raw-tree rows go through the prepared grammar boundary and are compared as
// whole raw trees (or refusal offsets). typed-model rows go through
// Parser.parse and the generated model is compared field by field with the
// Ruby model wire the row records (or the refusal offset). Legacy-oracle
// payloads are counted and not run. A full run must execute exactly the pinned
// row IDs of each boundary, and any failing row fails the replay. UMATH_TS_DIST replays an installed package's dist
// (for example an unpacked `npm pack` tarball) instead of the build tree.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pin: { type: "string", default: "corpus-pin.json" },
    limit: { type: "string" },
    group: { type: "string" },
    report: { type: "string" },
    executed: { type: "string" },
  },
});
const root = positionals[0];
if (!root) throw new Error("Pass the pinned plurimath-testsuite checkout path");
const limit = args.limit === undefined ? Infinity : Number(args.limit);
if (!(limit > 0)) throw new Error("--limit must be positive");
const groups = args.group === undefined ? null : new Set(args.group.split(",").map((g) => g + ".yaml"));
const partial = limit !== Infinity || groups !== null;

const dist = resolve(process.env.UMATH_TS_DIST ?? resolve(here, "../dist"));
const { initialize, ParseError } = await import(pathToFileURL(resolve(dist, "index.js")).href);
const { preprocess } = await import(pathToFileURL(resolve(dist, "preprocess.js")).href);

const pin = JSON.parse(readFileSync(resolve(here, args.pin), "utf8"));
const generation = resolve(root, pin.path);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Same digest as the testsuite's validate-stages.rb: sha256 over
// "<sha256>  <path>\n" for every file of the generation, paths relative to the
// generation directory and ordered by their bytes. Every file counts, so an
// added, removed or changed file fails the pin.
function files(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return files(path, base);
    assert.ok(entry.isFile(), `unexpected entry ${path}`);
    return [relative(base, path).split("\\").join("/")];
  });
}
const listed = files(generation).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
const digest = "sha256:" + sha(listed.map((path) => `${sha(readFileSync(resolve(generation, path)))}  ${path}\n`).join(""));
assert.equal(digest, pin.snapshot_digest, "pinned generation snapshot digest changed");

const provenanceBytes = readFileSync(resolve(generation, "provenance.yaml"));
assert.equal(sha(provenanceBytes), pin.provenance_sha256, "pinned corpus provenance changed");
const provenance = parse(provenanceBytes.toString("utf8"));
assert.equal(provenance.language, pin.language);
assert.equal(Number(provenance.generation), pin.generation);
assert.deepEqual(
  provenance.payloads.map((p) => p.path).concat("provenance.yaml").sort(),
  listed.slice().sort(),
  "generation files differ from the payloads provenance lists",
);

// Raw corpus atoms ({str}, {hash: [[k, v]]}, ...) to plain values.
function value(node) {
  if (node === null) return null;
  if (typeof node !== "object" || Array.isArray(node)) throw new Error("expected a tagged corpus atom");
  if ("str" in node) return node.str;
  if ("sym" in node) return node.sym;
  if ("slice" in node) return { text: node.slice, offset: node.byte_offset };
  if ("array" in node) return node.array.map(value);
  if ("hash" in node) {
    const entries = node.hash.map(([k, v]) => [value(k), value(v)]);
    assert.equal(new Set(entries.map(([k]) => k)).size, entries.length, "duplicate hash key");
    return Object.fromEntries(entries);
  }
  if ("nil" in node) return null;
  if ("bool" in node) return node.bool;
  if ("int" in node) return Number(node.int);
  throw new Error("unsupported raw corpus atom " + Object.keys(node).join(","));
}
// Nesting of an expected tree: hash, array and model node levels.
function depth(node) {
  if (node === null || typeof node !== "object") return 0;
  if (Array.isArray(node)) return node.reduce((m, x) => Math.max(m, depth(x)), 0);
  if ("hash" in node) return 1 + node.hash.reduce((m, [, v]) => Math.max(m, depth(v)), 0);
  if ("array" in node) return 1 + node.array.reduce((m, x) => Math.max(m, depth(x)), 0);
  if ("node" in node) return 1 + node.fields.reduce((m, [, v]) => Math.max(m, depth(v)), 0);
  return 0;
}
// Ruby model wire ({node, fields}, nil fields left out) for a generated model.
// Generation 4 rows name the model by the gem's earlier name Unicodemath.
function model(v) {
  if (v === null || v === undefined || typeof v === "symbol") return undefined;
  if (typeof v === "string") return { str: v };
  if (Array.isArray(v)) return { array: v.map(model) };
  const name = v.constructor.name;
  if (!name.startsWith("UmathModel")) throw new Error("not a generated model: " + name);
  return {
    node: "Umath::Model::" + name.slice(10),
    fields: Object.entries(v).map(([k, x]) => [k, model(x)]).filter(([, x]) => x !== undefined),
  };
}
function differs(kind, a, e) {
  let i = 0;
  while (a[i] === e[i]) i++;
  return new Error(`${kind} differs at ${i}: actual …${a.slice(Math.max(0, i - 120), i + 200)} expected …${e.slice(Math.max(0, i - 120), i + 200)}`);
}
function sameModel(actual, expected) {
  const a = JSON.stringify(model(actual));
  const e = JSON.stringify(expected).replaceAll('"Unicodemath::Model::', '"Umath::Model::');
  if (a !== e) throw differs("model", a, e);
}
function sameTree(actual, expected) {
  if (!isDeepStrictEqual(actual, expected)) throw differs("tree", JSON.stringify(actual), JSON.stringify(expected));
}

// Typed refusals report byte offsets into the caller's input.
function typedRow(row) {
  let actual, error;
  try { actual = stage.parse(row.input.str, row.options); } catch (e) { error = e; }
  if (row.expected.refusal) {
    assert.ok(error, "expected parse refusal");
    assert.ok(error instanceof ParseError, String(error));
    assert.equal(error.byteOffset, row.expected.refusal.byte_offset);
  } else {
    if (error) throw error;
    sameModel(actual, row.expected.tree);
  }
}
// The frozen Unicode RawParser boundary reports positions in prepared grammar
// text. Public parseTree positions intentionally refer to input.
function rawRow(row) {
  let actual, error;
  const prepared = pin.refusal_offset_basis === "preprocessed" ? preprocess(row.input.str) : null;
  if (prepared && row.expected.preprocessed) assert.equal(prepared.text, row.expected.preprocessed.str);
  try {
    actual = prepared ? stage.parsePreparedTree(prepared.text, row.options) : stage.parseTree(row.input.str, row.options);
  } catch (e) { error = e; }
  if (row.expected.refusal) {
    assert.ok(error, "expected parse refusal");
    assert.equal(row.expected.refusal.category, "parse_error");
    assert.ok(error instanceof ParseError, String(error));
    assert.equal(error.byteOffset, row.expected.refusal.byte_offset);
  } else {
    if (error) throw error;
    sameTree(actual, value(row.expected.tree));
  }
}

// Pins without boundaries (generation 4) replay raw-tree rows only.
const boundaries = pin.boundaries ?? { "raw-tree": null };
const prefixes = { "raw-tree": "raw-", "typed-model": "model-" };
const stage = await initialize();
const failures = [];
const ids = {};
const nesting = {};
let count = 0;
let skippedPayloads = 0;
const timings = [];
for (const payload of provenance.payloads) {
  const name = payload.path.split("/").pop();
  const boundary = Object.keys(boundaries).find((b) => name.startsWith(prefixes[b]));
  const path = resolve(generation, payload.path);
  const rel = relative(generation, path);
  assert.ok(!rel.startsWith("..") && !isAbsolute(rel), "payload escapes generation");
  const bytes = readFileSync(path);
  assert.equal(bytes.length, payload.bytes, `${payload.path}: size`);
  assert.equal(sha(bytes), payload.sha256, `${payload.path}: checksum`);
  if (!boundary) {
    skippedPayloads++;
    continue;
  }
  if (groups && !groups.has(name)) continue;
  const doc = parse(bytes.toString("utf8"), { maxAliasCount: -1 });
  assert.equal(doc.boundary, boundary);
  for (const row of doc.cases) {
    if (count >= limit) break;
    count++;
    (ids[boundary] ??= []).push(row.id);
    if (row.expected.tree) nesting[boundary] = Math.max(nesting[boundary] ?? 0, depth(row.expected.tree));
    const started = performance.now();
    try {
      if (boundary === "typed-model") typedRow(row);
      else rawRow(row);
    } catch (e) {
      failures.push({ id: row.id, boundary, input: row.input.str, error: String(e).slice(0, 900) });
    } finally {
      timings.push([row.id, Math.round(performance.now() - started)]);
    }
  }
}
assert.ok(count > 0, "no corpus cases");
// A complete run must execute exactly the pinned row IDs of each boundary,
// and reach the pinned deepest expected tree.
if (pin.boundaries && !partial) {
  for (const [boundary, expected] of Object.entries(pin.boundaries)) {
    const executed = ids[boundary] ?? [];
    assert.equal(new Set(executed).size, executed.length, `${boundary}: duplicate row id`);
    assert.equal(executed.length, expected.rows, `${boundary}: executed row count`);
    assert.equal(sha(Buffer.from(executed.join("\n"), "utf8")), expected.ids_sha256, `${boundary}: executed row IDs`);
    if (expected.max_nesting !== undefined) assert.equal(nesting[boundary], expected.max_nesting, `${boundary}: deepest expected tree`);
  }
}
timings.sort((a, b) => b[1] - a[1]);
const report = {
  language: pin.language,
  generation: pin.generation,
  revision: pin.revision,
  snapshot_digest: digest,
  dist,
  complete: !partial,
  checked: count,
  executed: Object.fromEntries(Object.entries(ids).map(([b, v]) => [b, v.length])),
  max_nesting: nesting,
  legacy_payloads_not_run: skippedPayloads,
  failed: failures.length,
  failed_ids: failures.map((f) => f.id),
  failures,
  slowest_ms: timings.slice(0, 10),
  total_row_ms: timings.reduce((sum, [, ms]) => sum + ms, 0),
};
if (args.report) writeFileSync(args.report, JSON.stringify(report, null, 1));
if (args.executed) writeFileSync(args.executed, Object.values(ids).flat().join("\n") + "\n");
const brief = (list) => list.slice(0, 20).map((f) => ({ id: f.id, error: f.error.slice(0, 300) }));
console.log(JSON.stringify({ ...report, failures: brief(failures) }));
process.exitCode = failures.length ? 1 : 0;

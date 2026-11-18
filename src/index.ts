import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PargRuntime, RecursionLimitExceeded, CallDepthLimitExceeded, ShapeDepthLimitExceeded } from 'parsanol';
import { createParser, Parser, NotInitializedError, ArtifactError, type Options, type Runtime, type Tree } from './browser.js';
import type { UmathModelDocument } from './generated/models.js';
export * from './browser.js';

// parsanol 1.5.8 ships the explicit failure reporter in its wasm engine but its
// PargRuntime wrapper does not expose it yet (parsanol-ts#80). Until a release
// carries that wrapper, call the engine directly with the same resource-error
// typing the wrapper's other parse methods use.
function nativeResource(value: unknown): Error | null {
  if (value === null || typeof value !== 'object') return null;
  const wire = value as Record<string, unknown>;
  if (typeof wire.depth !== 'number' || typeof wire.max_depth !== 'number') return null;
  const message = typeof wire.message === 'string' ? wire.message : undefined;
  if (wire.category === 'recursion_limit') return new RecursionLimitExceeded(wire.depth, wire.max_depth, message);
  if (wire.category === 'call_depth_limit') return new CallDepthLimitExceeded(wire.depth, wire.max_depth, message);
  if (wire.category === 'shape_depth_limit') return new ShapeDepthLimitExceeded(wire.depth, wire.max_depth, message);
  return null;
}
function withReporter(runtime: PargRuntime): Runtime {
  const target = runtime as unknown as Runtime;
  const engine = runtime.artifact as { parseShapeWithReporter?: (entry: string, input: string, compatibility: string, reporter: string) => string };
  if (typeof target.parseShapeWithReporter === 'function' || typeof engine.parseShapeWithReporter !== 'function') return target;
  target.parseShapeWithReporter = (input, compatibility, reporter) => {
    try {
      const result = JSON.parse(engine.parseShapeWithReporter!(runtime.entry, input, compatibility, reporter));
      const resource = nativeResource(result?.error);
      if (resource) throw resource;
      return result;
    } catch (error) { throw nativeResource(error) ?? error; }
  };
  return target;
}

let active: Parser | undefined;
let initializing: Promise<Parser> | undefined;
/** Load and verify pinned package artifacts once; subsequent parsing is synchronous. */
export function initialize(): Promise<Parser> {
  initializing ??= (async () => {
    const root = new URL('../', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('artifacts/manifest.json', root), 'utf8')) as { files: Record<string, string> };
    const files = new Map<string, string>();
    for (const [path, expected] of Object.entries(manifest.files)) {
      const bytes = await readFile(new URL(path, root));
      if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new ArtifactError(`checksum mismatch: ${path}`);
      files.set(path, bytes.toString('utf8'));
    }
    const parser = await createParser({ artifact: files.get('artifacts/umath.json')!, bindings: files.get('artifacts/umath.bindings.ts.json')!, wrappers: files.get('grammars/umath.wrappers.json')! }, (artifact, entry) => withReporter(new PargRuntime(artifact, entry)));
    active = parser;
    return parser;
  })();
  return initializing;
}
function ready(): Parser { if (!active) throw new NotInitializedError('await initialize() before parsing'); return active; }
export function parseTree(input: string, options?: Options): Tree { return ready().parseTree(input, options); }
export function parseShape(input: string, options?: Options): unknown { return ready().parseShape(input, options); }
export function parseBindings(input: string, options?: Options): ReturnType<Parser["parseBindings"]> { return ready().parseBindings(input, options); }
export function parse(input: string, options?: Options): UmathModelDocument { return ready().parse(input, options); }

export function parsePreparedTree(input: string, options?: Options): Tree { return ready().parsePreparedTree(input, options); }

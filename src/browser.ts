import { legacyTree, type Tree, type Wrappers } from './tree.js';
import { DIGESTS } from './pins.js';
import { CATALOG } from './catalog.js';
import { decodeUmathModelDocument } from './generated/json/codecs.js';
import type { UmathModelDocument } from './generated/models.js';
export * as Model from './generated/index.js';
export * as modelJson from './generated/json/index.js';
export { SOURCE_COMMIT } from './pins.js';

export type Decimal = '.' | ',' | '٫';
/** Parser policy. `strict` (the default) is the native PEG policy; `parslet` is the
 * explicit legacy policy of the Ruby producer (memo and ordered-choice semantics). */
export type Compatibility = 'strict' | 'parslet';
/** Failure reporter for refusals. `deepest` reports the furthest failure, as the Ruby engine does. */
export type Reporter = 'default' | 'deepest';
export interface Options { decimal?: Decimal; engine?: 'auto' | 'wasm' | 'native' | 'ruby'; compatibility?: Compatibility; reporter?: Reporter }
type CompatibleShape = { ok: true; shape: unknown } | { ok: false; error?: { offset?: number; message?: string } };
export interface Runtime {
  parseShape(input: string): unknown;
  applyBindingsArtifact(bindings: string, shape: unknown): Record<string, unknown>;
  parseShapeRecovering?(input: string): { ok: boolean; error?: { offset?: number; message?: string } };
  parseShapeWithCompatibility?(input: string, compatibility: string): CompatibleShape;
  parseShapeWithReporter?(input: string, compatibility: string, reporter: string): CompatibleShape;
}
export type RuntimeFactory = (artifact: string, entry: string) => Runtime | Promise<Runtime>;
export interface ArtifactBundle { artifact: string; bindings: string; wrappers: string }
export class ArtifactError extends Error { override name = 'ArtifactError'; }
export class EngineUnavailable extends Error { override name = 'EngineUnavailable'; }
export class NotInitializedError extends Error { override name = 'NotInitializedError'; }
export class ParseError extends Error {
  override name = 'ParseError';
  readonly category: string | null = null;
  readonly charOffset: number | null;
  constructor(message: string, readonly input: string, readonly byteOffset: number | null) {
    super(message);
    this.charOffset = byteOffset === null ? null : [...new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(input).subarray(0, byteOffset))].length;
  }
}
export class NestingTooDeep extends ParseError { override name = 'NestingTooDeep'; }

const entries = { '.': 'dot', ',': 'comma', '٫': 'arabic' } as const;
/** Initialized, synchronous WASM parser. No preprocessing or alternate parser. */

import { preprocess } from './preprocess.js';
import { SourceMap } from './source-map.js';
export class Parser {
  readonly capabilities = Object.freeze({ engine: 'wasm', rubyFallback: false });
  constructor(private readonly runtimes: ReadonlyMap<Decimal, Runtime>, private readonly bindings: string, private readonly wrappers: Wrappers) {}
  private run(input: string, options: Options = {}, prepared = false) {
    if (typeof input !== 'string') throw new TypeError('input must be a string');
    const encoder = new TextEncoder();
    if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoder.encode(input)) !== input) throw new TypeError('input must contain valid Unicode scalar values');
    const decimal = options.decimal ?? '.';
    if (!Object.hasOwn(entries, decimal)) throw new RangeError('unsupported decimal marker');
    for (const key of Object.keys(options)) if (!['decimal', 'engine', 'compatibility', 'reporter'].includes(key)) throw new RangeError(`unknown parse option ${key}`);
    if (options.engine === 'ruby') throw new EngineUnavailable('Ruby interpreter fallback is unavailable in WASM');
    if (options.engine !== undefined && !['auto','native','wasm'].includes(options.engine)) throw new RangeError('unknown engine');
    const compatibility = options.compatibility ?? 'strict';
    if (!['strict', 'parslet'].includes(compatibility)) throw new RangeError('unknown compatibility');
    const reporter = options.reporter ?? 'default';
    if (!['default', 'deepest'].includes(reporter)) throw new RangeError('unknown reporter');
    const processed = prepared || /^#*$/.test(input) ? { text: '', label: undefined, map: SourceMap.identity(input.length) } : preprocess(input);
    const empty = !prepared && /^#*$/.test(input);
    const text = prepared ? input : processed.text;
    const label = 'label' in processed ? processed.label : undefined;
    const map = prepared ? SourceMap.identity(input.length) : processed.map;
    if (!prepared && empty) return { input, text, label, decimal, shape: null, bound: {} as Record<string,unknown> };
    const runtime = this.runtimes.get(decimal)!;
    let shape: unknown;
    const relocate = (grammarOffset: number) => {
      const units = new TextDecoder().decode(encoder.encode(text).subarray(0, grammarOffset)).length;
      return encoder.encode(input.slice(0,map.toOriginal(units))).length;
    };
    let refusal: CompatibleShape | undefined;
    try {
      if (reporter !== 'default') {
        if (typeof runtime.parseShapeWithReporter !== 'function') throw new EngineUnavailable(`runtime does not expose the ${reporter} failure reporter`);
        refusal = runtime.parseShapeWithReporter(text, compatibility, reporter);
        if (refusal.ok) shape = refusal.shape;
      } else if (compatibility === 'strict') shape = runtime.parseShape(text);
      else {
        if (typeof runtime.parseShapeWithCompatibility !== 'function') throw new EngineUnavailable(`runtime does not expose the ${compatibility} parsing policy`);
        refusal = runtime.parseShapeWithCompatibility(text, compatibility);
        if (refusal.ok) shape = refusal.shape;
      }
    }
    catch (error) {
      if (typeof WebAssembly !== "undefined" && error instanceof WebAssembly.RuntimeError) throw error;
      if (error instanceof Error && ['CallDepthLimitExceeded', 'RecursionLimitExceeded', 'ShapeDepthLimitExceeded'].includes(error.name)) throw error;
      // Expected-token lists may include names such as substack or stackrel.
      // Only explicit resource failures identify an actual depth refusal.
      if ((error instanceof Error && error.name === 'NestingTooDeep') ||
          (error instanceof RangeError && /maximum call stack size exceeded/i.test(error.message)) ||
          (/^(?:NestingTooDeep:|recursion limit exceeded\b|maximum nesting depth exceeded\b|maximum call stack size exceeded\b|too much recursion\b|call stack exhausted\b|stack overflow\b|stack limit exceeded\b)/i.test(error instanceof Error ? error.message : String(error)))) {
        throw new NestingTooDeep(String(error), input, null);
      }
      if (error instanceof EngineUnavailable) throw error;
      let offset: number|null = null;
      try {
        const failure = runtime.parseShapeRecovering?.(text);
        if (failure && !failure.ok && Number.isInteger(failure.error?.offset)) offset = relocate(failure.error!.offset!);
      } catch { /* Preserve the primary refusal if diagnostic recovery fails. */ }
      throw new ParseError(String(error), input, offset);
    }
    if (refusal && !refusal.ok) {
      const at = refusal.error?.offset;
      throw new ParseError(refusal.error?.message ?? `parse failed at byte ${at}`, input, Number.isInteger(at) ? relocate(at!) : null);
    }
    return { input, text, label, decimal, shape, bound: runtime.applyBindingsArtifact(this.bindings, shape) };
  }
  parseShape(input: string, options: Options = {}): unknown { return this.run(input, options).shape; }
  parseBindings(input: string, options: Options = {}) { const state=this.run(input,options); return { expression: state.bound.model ?? null, label: state.label ?? null, decimal: state.decimal }; }
  parseTree(input: string, options: Options = {}): Tree { return this.capture(this.run(input,options)); }
  parsePreparedTree(input: string, options: Options = {}): Tree { return this.capture(this.run(input,options,true)); }
  private capture(state: ReturnType<Parser['run']>): Tree {
    if (state.shape === null) return null;
    return legacyTree(state.bound.umath_tree, state.text, this.wrappers);
  }
  parse(input: string, options: Options = {}): UmathModelDocument {
    const document = this.parseBindings(input,options);
    const pending: unknown[]=[document];
    while(pending.length) {
      const value=pending.pop(); if(Array.isArray(value)){pending.push(...value);continue;}
      if(value===null || typeof value!=='object')continue;
      const object=value as Record<string,unknown>;
      if(typeof object.spelling==='string') {
        const spelling=object.spelling.replace(/^[\x00\t\n\v\f\r ]+|[\x00\t\n\v\f\r ]+$/g,'');
        const record=CATALOG[spelling]; object.value=record?.value ?? decodeReferences(object.spelling); object.kind=record?.kind ?? 'unlisted';
      }
      pending.push(...Object.values(object));
    }
    return decodeUmathModelDocument(document);
  }
}
function decodeReferences(text:string):string { return text.replace(/&#(?:x([0-9a-fA-F]{1,6})|([0-9]{1,7}));/g,(_,hex:string|undefined,decimal:string|undefined)=>String.fromCodePoint(Number.parseInt(hex ?? decimal!,hex===undefined?10:16))); }
/** Browser callers provide the initialized upstream WASM factory explicitly. */
export async function createParser(bundle: ArtifactBundle, factory: RuntimeFactory): Promise<Parser> {
  let wrappers: Wrappers;
  try {
    for (const key of Object.keys(DIGESTS) as (keyof ArtifactBundle)[]) {
      const bytes = new TextEncoder().encode(bundle[key]);
      const actual = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
      if (actual !== DIGESTS[key]) throw new Error(`${key} differs from the pinned umath source`);
    }
    const artifact = JSON.parse(bundle.artifact) as Record<string, unknown>;
    const bindings = JSON.parse(bundle.bindings) as Record<string, unknown>;
    if (bindings.target !== 'ts' || bindings.artifact_kind !== 'parg-bindings') throw new Error('expected TS bindings');
    if (artifact.source_hash !== bindings.grammar_source_hash) throw new Error('grammar/bindings source hash mismatch');
    wrappers = JSON.parse(bundle.wrappers).wrappers as Wrappers;
    if (!wrappers || typeof wrappers !== 'object') throw new Error('missing wrapper declarations');
  } catch (error) { throw new ArtifactError(`invalid artifact bundle: ${String(error)}`); }
  const runtimes = new Map<Decimal, Runtime>();
  for (const decimal of Object.keys(entries) as Decimal[]) runtimes.set(decimal, await factory(bundle.artifact, entries[decimal]));
  return new Parser(runtimes, bundle.bindings, Object.freeze({ ...wrappers }));
}
export type { Tree, Slice } from './tree.js';

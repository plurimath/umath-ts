/**
 * UnicodeMath input preprocessing — `UnicodeMath::Parser#initialize` and
 * `#pre_processing` (`lib/plurimath/unicode_math/parser.rb:10-22, 43-53`),
 * ported together with the offset bookkeeping the gem does not need.
 *
 * The gem, in the order it runs:
 *
 * ```ruby
 * def initialize(text)
 *   text = pre_processing(text)                                    # :11
 *   @text = ::HTMLEntities.new.encode(text, :hexadecimal)          # :12
 *   @text = @text.gsub("&#x26;", "&")                              # :13
 *   @text = @text.gsub("&#x22;", "\"")                             # :14
 *   @text = @text.gsub(/&#x2af7;.*&#x2af8;/, "")                   # :15
 *   @text = @text.gsub("\\\\", "\\")                               # :16
 *   @text = @text.gsub(/\\u([\da-fA-F]{1,5})\w{0,5}/) do           # :17-20
 *     "&#x#{$1};"
 *   end
 *   @text = @text.strip                                            # :21
 * end
 *
 * def pre_processing(text)
 *   text unless text.include?("#") && !text.match?(LABELED_TR_REGEX)  # :44
 *   text = text.gsub(/✎\(.*(\#).*\)/) do |str|                        # :46-48
 *     str.gsub("#", "\"replacement\"")
 *   end
 *   splitted = text.split("#")                                        # :49
 *   splitted[0] = splitted.first.gsub("\"replacement\"", "#")         # :50
 *   @splitted = splitted.last if splitted.count > 1                   # :51
 *   splitted.first                                                    # :52
 * end
 * ```
 *
 * It runs in the CONSTRUCTOR, so `UnicodeMath::Parser#text` is already
 * normalised before `#parse` is called — which is why the grammar matches
 * ENTITY-ENCODED characters and why the fixture set records a `preprocessed`
 * field at all.
 *
 * ## What it does, in one line
 *
 * Cut the input at the first `#` (keeping the tail as an equation label),
 * hex-encode every character that is NOT printable ASCII, and the five
 * printable ones `<`, `>`, `'`, `"` and `&` as well, undo the `&` and `"`
 * encodings again, delete `⫷…⫸` spans, halve doubled backslashes, rewrite
 * `\uXXXX` escapes to hex entities, and strip.
 *
 * ## It is NOT LaTeX's, and the differences are load-bearing
 *
 * `latex/preprocess.ts` shares only the encoder. Measured differences:
 *
 *   - LaTeX encodes `@enti.encode(@enti.decode(text), :hexadecimal)`; this
 *     encodes with **no decode first**. So `"&amp;"` here becomes `"&#x26;amp;"`
 *     at `:12` and then `"&amp;"` again at `:13` — a round trip — where LaTeX
 *     would have decoded it to `"&"` first. Measured on the pinned clone:
 *     `Parser.new("&amp;").text == "&amp;"`.
 *   - LaTeX strips unescaped spaces (`/((?<!\\) )|\n+/`); UnicodeMath keeps
 *     every interior space and only `strip`s the ends. Measured:
 *     `Parser.new("2 π r").text == "2 &#x3c0; r"`.
 *   - The `#` split, the `⫷…⫸` deletion and the `\uXXXX` rewrite have no LaTeX
 *     counterpart at all.
 *
 * ## Offsets
 *
 * Almost every pass changes lengths, and the `#` split TRUNCATES, so an offset
 * into the preprocessed text does not index the caller's input. Every position
 * that reaches a user — `ParseError.index` above all — goes through the
 * returned `SourceMap` first.
 */

import { type PreprocessSegment, SourceMap } from "./source-map.js";

/**
 * The encoder's two passes, and the character set they cover.
 *
 * Measured rather than transcribed: every code point in `0..0x2FFFF` (skipping
 * surrogates) was fed to `HTMLEntities.new.encode(ch, :hexadecimal)` on the
 * pinned clone with htmlentities 4.4.2. The code points left AS-IS came back as
 * exactly `0020-0021, 0023-0025, 0028-003b, 003d, 003f-007e` — that is, printable
 * ASCII minus `"`, `&`, `'`, `<` and `>`. Everything else encoded. The two
 * patterns below are precisely the complement of that set.
 *
 * Both replace with `"&#x#{codepoint.to_s(16)};"` — lowercase, unpadded
 * (measured: `0x9` → `"&#x9;"`, `0x3b1` → `"&#x3b1;"`). An astral character is
 * ONE code point and therefore ONE entity (measured: `𝕒` → `"&#x1d552;"`),
 * which is why `ENCODE_EXTENDED` carries the `u` flag.
 *
 * They are separate passes and in this order, which matters: `replace_basic`
 * turns `&` into `&#x26;`, and every character of that is printable ASCII, so
 * `replace_extended` leaves it alone.
 */
const ENCODE_BASIC = /[<>'"&]/g;
const ENCODE_EXTENDED = /[^ -~]/gu;

function hexEntity(character: string): string {
  const codepoint = character.codePointAt(0);
  if (codepoint === undefined) {
    // Unreachable: a regex match is never the empty string here.
    throw new Error("unicodemath preprocess: empty match while encoding");
  }
  return `&#x${codepoint.toString(16)};`;
}

/**
 * `parser.rb:46` — `/✎\(.*(\#).*\)/`.
 *
 * `[^\n]` rather than `.`: Ruby's `.` excludes ONLY `\n`, while JavaScript's
 * also excludes `\r`, U+2028 and U+2029. Measured on the clone — `/a.b/` against
 * `"a\rb"`, `"a b"` and `"a b"` all matched, and `"a\nb"` did not — so
 * a literal `.` here would refuse spans the gem accepts.
 *
 * Both `.*` are GREEDY, and that is observable: for `"✎(a#b) # ✎(c#d)"` the match
 * runs from the first `✎(` to the LAST `)`, swallowing the separator `#` as
 * well, so the input does not split at all. Measured:
 * `Parser.new("✎(a#b) # ✎(c#d)")` yields `text == "&#x270e;(a#b) # &#x270e;(c#d)"`
 * and no label.
 */
const PENCIL_LABEL = /✎\([^\n]*#[^\n]*\)/g;

/** The stand-in `parser.rb:47` writes over a protected `#`, and `:50` undoes. */
const REPLACEMENT_TOKEN = '"replacement"';

/**
 * `parser.rb:17-20` — `/\\u([\da-fA-F]{1,5})\w{0,5}/`.
 *
 * The trailing `\w{0,5}` is a gem bug, reproduced deliberately: it EATS up to
 * five word characters after the hex digits and writes nothing in their place.
 * Measured on the clone: `"\\u0041abc"` → `"&#x0041a;"` (the hex run greedily
 * takes `0041a`, then `bc` is eaten) and `"\\u0041abcdefgh"` → `"&#x0041a;gh"`.
 */
const U_ESCAPE = /\\u([\da-fA-F]{1,5})\w{0,5}/g;

/**
 * `parser.rb:21` — `String#strip`.
 *
 * Ruby strips NUL as well as ASCII whitespace. Measured on the clone by testing
 * each code point in `0..0x100`: the set is exactly
 * `00, 09, 0a, 0b, 0c, 0d, 20`.
 *
 * Only `0x20` can actually reach this pass — every other member is outside
 * printable ASCII and so was turned into an entity at `:12` — but the full set
 * is transcribed because that is a fact about `String#strip`, not about this
 * composition.
 */
const STRIP_CHARS = new Set(["\0", "\t", "\n", "\v", "\f", "\r", " "]);

export interface PreprocessedUnicodemath {
  /** The rewritten text the grammar parses — `UnicodeMath::Parser#text`. */
  readonly text: string;
  /**
   * `@splitted` — the raw text after the last `#`, or `undefined` when the
   * input had no split point.
   *
   * Never encoded or stripped — `Parser.new("✎(a#b) # 3")` leaves
   * `@splitted == " 3"`, leading space and all. It is NOT always a verbatim
   * slice of the input, though: the pencil pass runs before the split and `:50`
   * un-protects field 0 only, so a `✎(…)` span landing in the tail keeps the
   * stand-in. Measured: `Parser.new("x # ✎(a#b)")` leaves
   * `@splitted == " ✎(a\"replacement\"b)"`.
   */
  readonly label: string | undefined;
  /** Translates an offset in `text` back to an offset in the caller's input. */
  readonly map: SourceMap;
}

/**
 * The half-open span of ORIGINAL code units each unit of the working text came
 * from. Two flat arrays rather than an array of pairs: rebuilt once per pass
 * and discarded as soon as the segments are cut.
 */
interface OriginSpans {
  readonly start: number[];
  /** Exclusive. */
  readonly end: number[];
}

interface Working {
  readonly text: string;
  readonly spans: OriginSpans;
}

/** One replacement a pass makes: where it starts, what it eats, what it writes. */
interface Rewrite {
  readonly start: number;
  readonly length: number;
  readonly text: string;
}

/**
 * Apply one pass's rewrites, carrying spans.
 *
 * The rewrites must be non-overlapping and in ascending order — which is what a
 * single left-to-right `gsub` produces, and the only shape Ruby's `gsub` can
 * produce, since it never rescans its own output.
 *
 * Every code unit of a replacement points at the WHOLE span the match covered,
 * so a failure inside a rewritten region reports the start of what was rewritten
 * rather than a position inside a string the caller never wrote.
 */
function applyRewrites(working: Working, rewrites: readonly Rewrite[]): Working {
  if (rewrites.length === 0) return working;
  const { text, spans } = working;
  const pieces: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let cursor = 0;

  const copyUnits = (from: number, to: number): void => {
    for (let unit = from; unit < to; unit++) {
      pieces.push(text.slice(unit, unit + 1));
      start.push(spans.start[unit] as number);
      end.push(spans.end[unit] as number);
    }
  };

  for (const rewrite of rewrites) {
    copyUnits(cursor, rewrite.start);
    if (rewrite.length > 0) {
      const spanStart = spans.start[rewrite.start] as number;
      const spanEnd = spans.end[rewrite.start + rewrite.length - 1] as number;
      for (let unit = 0; unit < rewrite.text.length; unit++) {
        pieces.push(rewrite.text.slice(unit, unit + 1));
        start.push(spanStart);
        end.push(spanEnd);
      }
    }
    cursor = rewrite.start + rewrite.length;
  }
  copyUnits(cursor, text.length);
  return { text: pieces.join(""), spans: { start, end } };
}

/** One `gsub(regexp) { ... }`: every non-overlapping match, left to right. */
function regexPass(
  working: Working,
  pattern: RegExp,
  replacement: (match: RegExpExecArray) => string,
): Working {
  const fresh = new RegExp(pattern.source, pattern.flags);
  const rewrites: Rewrite[] = [];
  for (const match of working.text.matchAll(fresh)) {
    // A zero-length match does NOT hang `matchAll` — it advances past it, so
    // `/(?:)/g` over `"a"` yields indices 0 and 1 and terminates (measured).
    // The hazard is `applyRewrites`, which skips any rewrite of length 0 and
    // would therefore DROP this replacement's text silently. None of the
    // patterns here can match empty, so this is refused rather than handled.
    if (match[0].length === 0) {
      throw new Error(`unicodemath preprocess: empty match from ${String(pattern)}`);
    }
    rewrites.push({
      start: match.index,
      length: match[0].length,
      text: replacement(match as RegExpExecArray),
    });
  }
  return applyRewrites(working, rewrites);
}

/**
 * `parser.rb:46-48` — the pencil pass, rewriting each protected `#` on its own.
 *
 * The text this produces is identical to rewriting the whole `✎(…)` match, since
 * the gem's nested `gsub` changes nothing but the `#`s. The SPANS are not.
 * `applyRewrites` points every character a rewrite emits at the start of what
 * that rewrite matched, so replacing the span whole made every character inside
 * it — the `√`, the `@`, all of it — claim to come from the `✎`. Measured before
 * this was split up: `parseUnicodemath("✎(#f00&√@)")` reported `index` 0 for a
 * refusal at the `@`, which is at index 8.
 *
 * A one-character rewrite per `#` keeps every other character's own origin,
 * which is why this pass is written out rather than handed to `regexPass`.
 * The rewrites stay ascending and non-overlapping: `matchAll` yields
 * non-overlapping matches left to right, and the hashes within each are scanned
 * in order.
 *
 * Only this pass rewrote a REGION. The others rewrite a token — one character to
 * an entity, `&#x26;` back to `&`, `\\` to `\`, one `\uXXXX` escape to one
 * entity — where collapsing to the token's start is the correct attribution.
 */
function pencilPass(working: Working): Working {
  const fresh = new RegExp(PENCIL_LABEL.source, PENCIL_LABEL.flags);
  const rewrites: Rewrite[] = [];
  for (const match of working.text.matchAll(fresh)) {
    const span = match[0];
    for (let at = span.indexOf("#"); at !== -1; at = span.indexOf("#", at + 1)) {
      rewrites.push({ start: match.index + at, length: 1, text: REPLACEMENT_TOKEN });
    }
  }
  return applyRewrites(working, rewrites);
}

/** One `gsub("literal", "replacement")`: Ruby's String pattern form. */
function literalPass(working: Working, from: string, to: string): Working {
  const rewrites: Rewrite[] = [];
  let cursor = 0;
  for (;;) {
    const found = working.text.indexOf(from, cursor);
    if (found === -1) break;
    rewrites.push({ start: found, length: from.length, text: to });
    cursor = found + from.length;
  }
  return applyRewrites(working, rewrites);
}

/** Keep `[from, to)` of the working text, spans intact. */
function sliceWorking(working: Working, from: number, to: number): Working {
  return {
    text: working.text.slice(from, to),
    spans: {
      start: working.spans.start.slice(from, to),
      end: working.spans.end.slice(from, to),
    },
  };
}

/** `String#strip`, as a slice so the spans survive. */
function stripWorking(working: Working): Working {
  const { text } = working;
  let from = 0;
  let to = text.length;
  while (from < to && STRIP_CHARS.has(text[from] as string)) from += 1;
  while (to > from && STRIP_CHARS.has(text[to - 1] as string)) to -= 1;
  if (from === 0 && to === text.length) return working;
  return sliceWorking(working, from, to);
}

function identity(input: string): Working {
  return {
    text: input,
    spans: {
      start: Array.from({ length: input.length }, (_, index) => index),
      end: Array.from({ length: input.length }, (_, index) => index + 1),
    },
  };
}

/**
 * `String#split(separator)` with Ruby's trailing-empty rule.
 *
 * Ruby drops trailing empty fields, and `"".split("#")` is `[]` rather than
 * `[""]`. Both matter here, because `parser.rb:50` calls `splitted.first.gsub`
 * without a nil guard: an empty result means the gem raises `NoMethodError`.
 * Measured on the clone — `Parser.new("#")` and `Parser.new("")` both raise
 * `NoMethodError: undefined method 'gsub' for nil`.
 */
function rubySplitOnHash(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("#");
  let end = parts.length;
  while (end > 0 && parts[end - 1] === "") end -= 1;
  return parts.slice(0, end);
}

/**
 * Preprocess UnicodeMath input as `UnicodeMath::Parser#initialize` does, and
 * return the map that takes offsets in the result back to the caller's input.
 *
 * Throws for the inputs the gem cannot preprocess — see `rubySplitOnHash`.
 * `parseUnicodemath` turns that into a `ParseError`, which is what the gem's own
 * public boundary does with the `NoMethodError` (`math.rb:45-49` rescues
 * `StandardError`); measured, `Plurimath::Math.parse("", :unicode)` raises
 * `Plurimath::Math::ParseError`.
 *
 * A non-string is rejected here for the reason `asciimath/preprocess.ts` gives:
 * `String(null)` would silently preprocess the text `"null"`, and nil is not a
 * supported input in the gem either.
 */
export function preprocess(input: string): PreprocessedUnicodemath {
  const received: unknown = input;
  if (typeof received !== "string") {
    const kind = received === null ? "null" : typeof received;
    throw new TypeError(`UnicodeMath input must be a string, received ${kind}`);
  }

  let working = identity(input);

  // `parser.rb:44` is a DEAD statement: `text unless ...` computes a value and
  // discards it — it is not a guard and not an early return, so nothing below
  // is conditional on it. Reproduced by omission, and measured: `"✎(a#b)"`
  // contains `#` and does NOT match `LABELED_TR_REGEX`, so a real early return
  // would have skipped the pencil pass; on the clone the pencil pass still ran
  // (`Parser.new("✎(a#b)").text == "&#x270e;(a#b)"`, with the `#` restored by
  // `:50` rather than left split).

  // `:46-48` — protect every `#` inside a `✎(…)` span from the split below, by
  // overwriting it with a stand-in. The nested `gsub` runs on the matched
  // substring, so ALL of that span's `#` are protected, not only the one the
  // capture group named.
  working = pencilPass(working);

  // `:49` — split on `#`. Everything after the FIRST `#` is dropped from the
  // formula; `:51` keeps only the LAST field as the label, so a middle field is
  // silently discarded. Measured: `Parser.new("a#b#c")` gives text `"a"` and
  // label `"c"` — `"b"` is gone.
  const fields = rubySplitOnHash(working.text);
  if (fields.length === 0) {
    throw new Error(
      `unicodemath preprocess: ${JSON.stringify(input)} splits to no fields, and the gem ` +
        "raises NoMethodError on nil here (parser.rb:50)",
    );
  }
  const head = fields[0] as string;
  working = sliceWorking(working, 0, head.length);

  // `:51` — the label is the LAST field, taken from the text AFTER the pencil
  // pass and never restored: `:50` rewrites index 0 only. So a `✎(…)` span that
  // lands in the tail keeps the stand-in verbatim. Measured on the clone:
  // `Parser.new("x # ✎(a#b)")` leaves `@splitted == " ✎(a\"replacement\"b)"`.
  const label = fields.length > 1 ? (fields[fields.length - 1] as string) : undefined;

  // `:50` — restore the protected `#` in field 0. This is a blind literal
  // rewrite, so a `"replacement"` the CALLER wrote is corrupted into `#` as
  // well. Measured: `Parser.new("a\"replacement\"#b").text == "a#"`.
  working = literalPass(working, REPLACEMENT_TOKEN, "#");

  // `:12` — `@enti.encode(text, :hexadecimal)`, the encoder's two passes in
  // order. There is no `decode` first, unlike LaTeX's.
  working = regexPass(working, ENCODE_BASIC, (match) => hexEntity(match[0]));
  working = regexPass(working, ENCODE_EXTENDED, (match) => hexEntity(match[0]));

  // `:13`, `:14` — undo two of the encodings just made, so `&` and `"` reach the
  // grammar as themselves.
  working = literalPass(working, "&#x26;", "&");
  working = literalPass(working, "&#x22;", '"');

  // `:15` — delete `⫷…⫸` spans. The pattern runs on the ENTITY-ENCODED text, so
  // it matches the entities rather than the characters, and `.*` is GREEDY:
  // two spans on one line are deleted together WITH the text between them.
  // Measured: `Parser.new("x⫷a⫸y⫷b⫸z").text == "xz"` — the `y` is gone.
  working = regexPass(working, /&#x2af7;[^\n]*&#x2af8;/g, () => "");

  // `:16` — two backslashes become ONE. Ruby's replacement string `"\\"` is a
  // single backslash character and Ruby's backslash processing leaves it alone;
  // measured, `Parser.new("a\\\\b").text == "a\\b"` (two in, one out).
  working = literalPass(working, "\\\\", "\\");

  // `:17-20` — `\uXXXX` to a hex entity. This runs AFTER `:16`, so an input
  // written with TWO backslashes has already been halved to the one-backslash
  // escape `\u0041` — still those six literal characters, not the letter `A`
  // they name — and is rewritten here like any other. Measured:
  // `Parser.new("\\\\u0041").text == "&#x0041;"`.
  working = regexPass(working, U_ESCAPE, (match) => `&#x${match[1] as string};`);

  // `:21`
  working = stripWorking(working);

  // When nothing survives (`" "`), there is no character to point past, and a
  // refusal lands at the start of the input: the umath stage gem reports byte
  // 0 for `" "`, and the gem's own rejection corpus records offset 0 into ''.
  // Closing the tail here would clamp it to the input's end instead.
  return {
    text: working.text,
    label,
    map: SourceMap.fromSegments(toSegments(working, working.text === "" ? 0 : input.length)),
  };
}

/**
 * Cut the working text into `PreprocessSegment`s: adjacent units sharing a span
 * came from one rewrite and stay together, everything else becomes its own
 * one-unit segment. `SourceMap.fromSegments` points every unit of a segment at
 * that segment's start, so an untouched character must not be merged with its
 * neighbours.
 *
 * This preprocessor DELETES text — the `#` tail, `⫷…⫸` spans, stripped ends — so
 * the last surviving segment need not reach the end of the input, and a trailing
 * deletion would leave `SourceMap`'s past-the-end clamp short. The tail is
 * therefore closed explicitly with a zero-output segment covering whatever was
 * dropped after the last surviving character.
 */
function toSegments(working: Working, inputLength: number): PreprocessSegment[] {
  const { text, spans } = working;
  const segments: PreprocessSegment[] = [];
  let unit = 0;

  while (unit < text.length) {
    const spanStart = spans.start[unit] as number;
    const spanEnd = spans.end[unit] as number;
    let after = unit + 1;
    while (
      after < text.length &&
      spans.start[after] === spanStart &&
      spans.end[after] === spanEnd
    ) {
      after += 1;
    }
    segments.push({
      originStart: spanStart,
      originLength: spanEnd - spanStart,
      output: text.slice(unit, after),
    });
    unit = after;
  }

  const covered = text.length === 0 ? 0 : (spans.end[text.length - 1] as number);
  if (covered < inputLength) {
    segments.push({ originStart: covered, originLength: inputLength - covered, output: "" });
  }
  return segments;
}

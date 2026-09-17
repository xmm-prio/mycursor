/**
 * A tiny reader for the object-literal subset `@bufbuild/protobuf` code
 * generation emits.
 *
 * The field tables in Cursor's bundles are ordinary JavaScript object
 * literals, but they cannot be read with `JSON.parse` — keys are unquoted,
 * booleans are minified to `!0`/`!1`, and type references are bare
 * identifiers or `ns.getEnumType(VAR)` calls.
 *
 * Parsing them with a full JavaScript parser would mean parsing a 38 MB bundle
 * to read a few thousand small literals. This reader handles exactly the
 * constructs that appear, starting from a known offset, so extraction stays
 * proportional to the size of the schema rather than the size of the bundle.
 *
 * Nothing here evaluates the input.
 */

const IDENT = /[A-Za-z0-9_$]/;

/** A bare identifier, which in a field table is a type reference. */
export interface Reference {
  ref: string;
}

/** A call such as `ns.getEnumType(VAR)`, whose argument is the reference. */
export interface CallReference {
  call: string;
  arg: string;
}

export type LiteralValue =
  | string
  | number
  | boolean
  | Reference
  | CallReference
  | LiteralValue[]
  | { [key: string]: LiteralValue };

export function isReference(value: unknown): value is Reference {
  return Boolean(value) && typeof value === 'object' && 'ref' in (value as object);
}

export function isCallReference(value: unknown): value is CallReference {
  return Boolean(value) && typeof value === 'object' && 'call' in (value as object);
}

/** Resolves either reference form to the referenced identifier. */
export function referencedIdentifier(value: unknown): string | null {
  if (isReference(value)) return value.ref;
  if (isCallReference(value)) return value.arg;
  return null;
}

export function skipWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  return i;
}

/** Returns the index just past the bracket matching the one at `start`. */
export function matchBracket(text: string, start: number): number {
  const open = text[start];
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipStringLiteral(text, i);
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

export function skipStringLiteral(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

export function readStringLiteral(text: string, start: number): { value: string; end: number } {
  const quote = text[start];
  let value = '';
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\') {
      value += text[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (ch === quote) return { value, end: i + 1 };
    value += ch;
    i += 1;
  }
  return { value, end: i };
}

/** Reads the identifier ending immediately before `endExclusive`. */
export function readIdentifierBackwards(text: string, endExclusive: number): string {
  let i = endExclusive - 1;
  while (i >= 0 && IDENT.test(text[i]!)) i -= 1;
  return text.slice(i + 1, endExclusive);
}

export function parseValue(text: string, index: number): { value: LiteralValue; end: number } {
  const i = skipWhitespace(text, index);
  const ch = text[i];

  if (ch === '{') return parseObject(text, i);
  if (ch === '[') return parseArray(text, i);
  if (ch === '"' || ch === "'" || ch === '`') return readStringLiteral(text, i);
  // Minified booleans.
  if (ch === '!') return { value: text[i + 1] === '0', end: i + 2 };

  if (ch !== undefined && /[-\d]/.test(ch)) {
    let j = i;
    if (text[j] === '-') j += 1;
    while (j < text.length && /[\d.eE+]/.test(text[j]!)) j += 1;
    return { value: Number(text.slice(i, j)), end: j };
  }

  let j = i;
  while (j < text.length && (IDENT.test(text[j]!) || text[j] === '.')) j += 1;
  const name = text.slice(i, j);
  if (text[j] === '(') {
    const end = matchBracket(text, j);
    if (end === -1) return { value: { ref: name }, end: j };
    return { value: { call: name, arg: text.slice(j + 1, end - 1).trim() }, end };
  }
  return { value: { ref: name }, end: j };
}

export function parseObject(
  text: string,
  start: number,
): { value: Record<string, LiteralValue>; end: number } {
  const result: Record<string, LiteralValue> = {};
  let i = start + 1;
  for (;;) {
    i = skipWhitespace(text, i);
    if (i >= text.length) return { value: result, end: i };
    if (text[i] === '}') return { value: result, end: i + 1 };

    let key: string;
    if (text[i] === '"' || text[i] === "'") {
      const read = readStringLiteral(text, i);
      key = read.value;
      i = read.end;
    } else {
      let j = i;
      while (j < text.length && IDENT.test(text[j]!)) j += 1;
      key = text.slice(i, j);
      i = j;
    }

    i = skipWhitespace(text, i);
    if (text[i] !== ':') return { value: result, end: i };
    const parsed = parseValue(text, i + 1);
    result[key] = parsed.value;
    i = skipWhitespace(text, parsed.end);
    if (text[i] === ',') i += 1;
  }
}

export function parseArray(text: string, start: number): { value: LiteralValue[]; end: number } {
  const result: LiteralValue[] = [];
  let i = start + 1;
  for (;;) {
    i = skipWhitespace(text, i);
    if (i >= text.length) return { value: result, end: i };
    if (text[i] === ']') return { value: result, end: i + 1 };
    const parsed = parseValue(text, i);
    result.push(parsed.value);
    i = skipWhitespace(text, parsed.end);
    if (text[i] === ',') i += 1;
  }
}

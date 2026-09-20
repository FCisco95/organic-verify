import { ValidationError } from "./errors.js";

/**
 * Shared shape checks for the committed, non-secret manifests in this package.
 * They reject rather than coerce: a caller that hands over a wrong shape gets
 * an error naming the field, never a silently repaired value.
 */

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(record).filter(key => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ValidationError(`${label} contains unknown fields: ${unknown.sort().join(", ")}`);
  }
}

/**
 * Own properties only. `rejectUnknownKeys` can only see own keys, so reading
 * through the prototype chain would let an object whose fields all live on its
 * prototype pass validation with nothing to reject.
 */
export function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = own(record, key);
  if (typeof value !== "string") throw new ValidationError(`${label}.${key} must be a string`);
  return value;
}

/**
 * A single line of printable text within a length range. Control characters,
 * line separators and surrounding whitespace are rejected, never trimmed: the
 * value is rendered verbatim into a signed message, so what the caller wrote
 * is what the wallet displays.
 */
export function requireSingleLine(
  value: string,
  bounds: { readonly min: number; readonly max: number },
  label: string,
): string {
  if (value.length < bounds.min || value.length > bounds.max) {
    throw new ValidationError(`${label} must be ${bounds.min} to ${bounds.max} characters`);
  }
  for (const character of value) {
    const code = character.codePointAt(0)!;
    // Two classes are rejected. First, anything that could end a line in a
    // rendered message: C0, DEL, C1, and the Unicode line/paragraph
    // separators. Second, anything invisible or capable of reordering what a
    // wallet displays: zero-width marks, the bidi embeddings, overrides and
    // isolates, and a byte-order mark. A member is taught to read this text
    // and compare it, so a character that can hide or reverse part of it is as
    // dangerous as one that can add a line.
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ||
        (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069) || code === 0xfeff) {
      throw new ValidationError(`${label} must not contain control, invisible or bidirectional characters`);
    }
  }
  if (value !== value.trim()) {
    throw new ValidationError(`${label} must not have leading or trailing whitespace`);
  }
  return value;
}

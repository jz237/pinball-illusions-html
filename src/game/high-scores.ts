/**
 * High score table.
 *
 * The original keeps one file per table under `Scores/PinballIllusions/`, fifty
 * bytes holding five records of three initials followed by a seven-byte packed
 * BCD score. All three shipped files are byte-identical factory defaults giving
 * the ladder 10M / 5M / 2.5M / 1M / 500K.
 *
 * Scores are packed BCD rather than binary because the original ran on a 68000
 * and displayed decimal digits directly; keeping that representation means the
 * displayed digits are the stored digits, and a score can never render as
 * something the machine could not have shown.
 */

import type { TableId } from "./contracts.js";

/** Records per table, from the fifty-byte score files. */
export const HIGH_SCORE_SLOTS = 5;

/** Initials are exactly three characters, space-padded. */
export const INITIALS_LENGTH = 3;

/** Seven BCD bytes hold fourteen decimal digits. */
export const SCORE_BCD_BYTES = 7;

export const SCORE_RECORD_BYTES = INITIALS_LENGTH + SCORE_BCD_BYTES;

export interface HighScoreEntry {
  readonly initials: string;
  readonly score: number;
}

/**
 * Factory ladder, decoded from the original score files.
 *
 * Identical on all three tables — unlike the nudge allowance, this is not a
 * per-table value, so it lives once rather than being repeated per table.
 *
 * These are the seven BCD bytes read in full, i.e. fourteen digits. The RATIOS
 * are certain (20 : 10 : 5 : 2 : 1) because they are visible directly in the
 * stored digits; the absolute magnitude depends on the score field really being
 * all seven bytes rather than four or five followed by padding, which the file
 * alone cannot settle since every candidate tail byte is zero. If the field
 * turns out to be narrower these all scale down by a power of a hundred and the
 * ladder keeps its shape.
 */
export const FACTORY_HIGH_SCORES: readonly HighScoreEntry[] = Object.freeze([
  Object.freeze({ initials: "AXL", score: 1_000_000_000 }),
  Object.freeze({ initials: "M N", score: 500_000_000 }),
  Object.freeze({ initials: "ORG", score: 250_000_000 }),
  Object.freeze({ initials: "F L", score: 100_000_000 }),
  Object.freeze({ initials: "P B", score: 50_000_000 }),
]);

/** Largest score the seven-byte BCD field can hold. */
export const MAX_BCD_SCORE = 99_999_999_999_999;

/** Reads a packed BCD run as a decimal number. Throws on a non-decimal nibble. */
export function decodeBcd(bytes: Uint8Array, offset: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i += 1) {
    const byte = bytes[offset + i];
    if (byte === undefined) throw new RangeError(`BCD read past end at ${offset + i}`);
    const high = byte >> 4;
    const low = byte & 0x0f;
    if (high > 9 || low > 9) {
      throw new RangeError(`invalid BCD byte 0x${byte.toString(16)} at ${offset + i}`);
    }
    value = value * 100 + high * 10 + low;
  }
  return value;
}

/** Writes a decimal number as packed BCD, most significant byte first. */
export function encodeBcd(value: number, length: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`BCD value must be a non-negative integer: ${value}`);
  }
  const out = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    const pair = remaining % 100;
    out[i] = (Math.floor(pair / 10) << 4) | pair % 10;
    remaining = Math.floor(remaining / 100);
  }
  if (remaining !== 0) {
    throw new RangeError(`score ${value} does not fit in ${length} BCD bytes`);
  }
  return out;
}

/** Trims trailing padding but keeps interior spaces, as `M N` requires. */
function readInitials(bytes: Uint8Array, offset: number): string {
  let text = "";
  for (let i = 0; i < INITIALS_LENGTH; i += 1) {
    const code = bytes[offset + i];
    if (code === undefined) throw new RangeError(`initials read past end at ${offset + i}`);
    text += String.fromCharCode(code);
  }
  return text.replace(/\s+$/, "");
}

/** Parses a fifty-byte score file in the original's layout. */
export function parseScoreFile(bytes: Uint8Array): HighScoreEntry[] {
  const expected = HIGH_SCORE_SLOTS * SCORE_RECORD_BYTES;
  if (bytes.length !== expected) {
    throw new RangeError(`score file must be ${expected} bytes, got ${bytes.length}`);
  }
  const entries: HighScoreEntry[] = [];
  for (let slot = 0; slot < HIGH_SCORE_SLOTS; slot += 1) {
    const base = slot * SCORE_RECORD_BYTES;
    entries.push({
      initials: readInitials(bytes, base),
      score: decodeBcd(bytes, base + INITIALS_LENGTH, SCORE_BCD_BYTES),
    });
  }
  return entries;
}

/** Serialises a ladder back to the original's fifty-byte layout. */
export function writeScoreFile(entries: readonly HighScoreEntry[]): Uint8Array {
  const out = new Uint8Array(HIGH_SCORE_SLOTS * SCORE_RECORD_BYTES);
  for (let slot = 0; slot < HIGH_SCORE_SLOTS; slot += 1) {
    const entry = entries[slot] ?? { initials: "", score: 0 };
    const base = slot * SCORE_RECORD_BYTES;
    const padded = entry.initials.padEnd(INITIALS_LENGTH, " ").slice(0, INITIALS_LENGTH);
    for (let i = 0; i < INITIALS_LENGTH; i += 1) {
      out[base + i] = padded.charCodeAt(i);
    }
    out.set(encodeBcd(entry.score, SCORE_BCD_BYTES), base + INITIALS_LENGTH);
  }
  return out;
}

/** True when a score earns a place on the ladder. */
export function qualifies(entries: readonly HighScoreEntry[], score: number): boolean {
  if (score <= 0) return false;
  if (entries.length < HIGH_SCORE_SLOTS) return true;
  const last = entries[HIGH_SCORE_SLOTS - 1];
  return last === undefined || score > last.score;
}

/** Zero-based place a score would take, or -1 if it does not qualify. */
export function placeFor(entries: readonly HighScoreEntry[], score: number): number {
  if (!qualifies(entries, score)) return -1;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    // Strictly greater, so an equal score ranks below the incumbent — ties go to
    // whoever got there first, as the original's ladder does.
    if (entry !== undefined && score > entry.score) return i;
  }
  return Math.min(entries.length, HIGH_SCORE_SLOTS - 1);
}

/** Inserts a score, returning a new ladder trimmed to the slot count. */
export function insertScore(
  entries: readonly HighScoreEntry[],
  initials: string,
  score: number,
): HighScoreEntry[] {
  const place = placeFor(entries, score);
  const next = [...entries];
  if (place < 0) return next.slice(0, HIGH_SCORE_SLOTS);
  const padded = initials.padEnd(INITIALS_LENGTH, " ").slice(0, INITIALS_LENGTH).toUpperCase();
  next.splice(place, 0, { initials: padded.replace(/\s+$/, ""), score });
  return next.slice(0, HIGH_SCORE_SLOTS);
}

/** Fresh factory ladder. Copied, so callers cannot mutate the frozen original. */
export function factoryLadder(): HighScoreEntry[] {
  return FACTORY_HIGH_SCORES.map((entry) => ({ ...entry }));
}

function storageKey(tableId: TableId): string {
  return `pinball-illusions/high-scores/${tableId}`;
}

/**
 * Loads a saved ladder, falling back to the factory one.
 *
 * Any parse failure falls back rather than throwing: a corrupt saved score must
 * never stop the game booting.
 */
export function loadHighScores(
  tableId: TableId,
  storage: Pick<Storage, "getItem" | "setItem"> | null,
): HighScoreEntry[] {
  if (storage === null) return factoryLadder();
  try {
    const raw = storage.getItem(storageKey(tableId));
    if (raw === null) return factoryLadder();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return factoryLadder();
    const entries = parsed
      .filter(
        (item): item is HighScoreEntry =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as HighScoreEntry).initials === "string" &&
          Number.isFinite((item as HighScoreEntry).score),
      )
      .slice(0, HIGH_SCORE_SLOTS);
    return entries.length > 0 ? entries : factoryLadder();
  } catch {
    return factoryLadder();
  }
}

export function saveHighScores(
  tableId: TableId,
  entries: readonly HighScoreEntry[],
  storage: Pick<Storage, "getItem" | "setItem"> | null,
): void {
  if (storage === null) return;
  try {
    storage.setItem(storageKey(tableId), JSON.stringify(entries.slice(0, HIGH_SCORE_SLOTS)));
  } catch {
    // A full or blocked storage must not interrupt play.
  }
}

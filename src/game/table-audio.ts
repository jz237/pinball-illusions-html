/**
 * Loader for the shipped sound effects (`public/generated/tables/*.audio.json`).
 *
 * ---------------------------------------------------------------------------
 * WHY A MANIFEST AND NOT JUST A DIRECTORY OF WAVs
 * ---------------------------------------------------------------------------
 * Two reasons, and the second is the one that matters.
 *
 * A WAV carries its own sample rate but nothing else this machine needs: not the
 * Paula VOLUME the sound record asks for, not its PRIORITY — `$779E` refuses to
 * displace a sounding effect with a lower-priority one, which is the whole of
 * the original's mixing policy — and not what plays it. All three live here.
 *
 * And a sound file cannot carry provenance inside itself. These are recordings
 * off the operator's own disks, several of them speech, which is a heavier
 * rights question than the artwork was; so every one of them is claimed by this
 * manifest with a sha256, and `scripts/check-public-build.mjs` refuses a build
 * containing an audio file no manifest claims or whose bytes do not match. The
 * gate is the same one the playfield artwork goes through.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE MAY TOUCH THE SIMULATION
 * ---------------------------------------------------------------------------
 * This module is pure data and the player is in `src/browser/audio.ts`. The
 * simulation never imports either. A recorded input log has to replay to the
 * same bytes on a machine with the sound off, on a machine whose audio device
 * failed to open, and on a machine where `decodeAudioData` is still running when
 * the first bumper is hit — so audio is downstream of the tick report and can
 * never be upstream of anything.
 */

import { TABLE_IDS } from "./contracts.js";
import type { EngineAudioDocument, TableAudioDocument, TableId } from "./contracts.js";

/** The only per-table document schema this loader understands. */
export const TABLE_AUDIO_SCHEMA = "pinball-illusions/table-audio/v1";

/** The engine-sound document schema; same samples, event-name triggers. */
export const ENGINE_AUDIO_SCHEMA = "pinball-illusions/engine-audio/v1";

/** Where the exported documents live under the site root (Vite serves `public/`). */
export const TABLE_AUDIO_BASE_PATH = "generated/tables/";

/** Where the engine manifest and its WAVs live. */
export const ENGINE_AUDIO_BASE_PATH = "generated/";

/** Paula's volume register is 0..64, and it is a plain linear multiplier. */
export const PAULA_MAX_VOLUME = 64;

/**
 * One sound effect.
 *
 * `provenance` is "decoded" for every current export: a kind-2 record's sample
 * pointer is a relocated address the decode follows, and a kind-5 record's
 * (bank, instrument) pair is resolved by the rule the table loader at main.seg00
 * `$343E` executes — the resolver an earlier round could not find, whose absence
 * is why "inferred" exists in this union. The value stays accepted so an older
 * manifest still parses.
 */
export interface AudioSample {
  readonly index: number;
  readonly file: string;
  readonly sha256: string;
  /** Bytes of 8-bit PCM, which at `rate` is `milliseconds` long. */
  readonly bytes: number;
  readonly rate: number;
  /** The Paula period the sound record asks for. `rate` is 3546895 / period. */
  readonly period: number;
  readonly volume: number;
  /** A sounding effect is only displaced by one of equal or higher priority. */
  readonly priority: number;
  readonly kind: "sample" | "instrument";
  readonly milliseconds: number;
  readonly provenance: "decoded" | "inferred";
}

export interface TableAudio {
  readonly tableId: TableId;
  readonly displayName: string;
  readonly samples: readonly AudioSample[];
  /**
   * The sample an award plays, or null.
   *
   * Keyed by the award id the scoring layer builds — `device-36`, `bumper-16`,
   * `zone-0-8` — because that key is what a tick report actually carries.
   */
  sampleForAward(awardId: string): AudioSample | null;
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(length ${value.length})`;
  return `${typeof value} ${String(value)}`;
}

function isTableId(value: string): value is TableId {
  return (TABLE_IDS as readonly string[]).includes(value);
}

function requireWholeNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be a whole number in ${min}..${max}, got ${describeValue(value)}`);
  }
  return value;
}

/** Expands one document into a `TableAudio`, checking every field. */
export function parseTableAudioDocument(doc: TableAudioDocument): TableAudio {
  const raw = doc as unknown as Record<string, unknown> | null | undefined;
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error(`table audio document must be an object, got ${describeValue(doc)}`);
  }
  if (raw["schema"] !== TABLE_AUDIO_SCHEMA) {
    throw new Error(
      `table audio document has schema ${describeValue(raw["schema"])}, expected "${TABLE_AUDIO_SCHEMA}"`,
    );
  }
  const tableIdValue = raw["tableId"];
  if (typeof tableIdValue !== "string" || !isTableId(tableIdValue)) {
    throw new Error(`table audio document has unknown tableId ${describeValue(tableIdValue)}`);
  }
  const tableId: TableId = tableIdValue;
  const label = `table audio "${tableId}"`;

  const displayName = raw["displayName"];
  if (typeof displayName !== "string" || displayName.length === 0) {
    throw new Error(`${label} has a non-string or empty displayName`);
  }

  const samples = parseSamples(raw, label);
  const triggers = parseTriggers(raw, label, samples);

  return Object.freeze({
    tableId,
    displayName,
    samples: Object.freeze(samples),
    sampleForAward(awardId: string): AudioSample | null {
      return triggers.get(awardId) ?? null;
    },
  });
}

/** The `samples` array of either document shape, checked field by field. */
function parseSamples(raw: Record<string, unknown>, label: string): AudioSample[] {
  const rawSamples = raw["samples"];
  if (!Array.isArray(rawSamples)) throw new Error(`${label} has non-array samples`);
  const samples: AudioSample[] = [];
  for (const [at, entry] of rawSamples.entries()) {
    const item = entry as Record<string, unknown>;
    const where = `${label} sample ${at}`;
    const file = item["file"];
    if (typeof file !== "string" || !/^[A-Za-z0-9._-]+$/.test(file)) {
      throw new Error(`${where} has a file name of ${describeValue(file)}`);
    }
    const sha256 = item["sha256"];
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`${where} carries no sha256 digest`);
    }
    const kind = item["kind"];
    if (kind !== "sample" && kind !== "instrument") {
      throw new Error(`${where} has kind ${describeValue(kind)}`);
    }
    const provenance = item["provenance"];
    if (provenance !== "decoded" && provenance !== "inferred") {
      throw new Error(`${where} has provenance ${describeValue(provenance)}`);
    }
    samples.push(
      Object.freeze({
        index: requireWholeNumber(item["index"], `${where} index`, at, at),
        file,
        sha256,
        bytes: requireWholeNumber(item["bytes"], `${where} bytes`, 1, 1 << 24),
        rate: requireWholeNumber(item["rate"], `${where} rate`, 1000, 60000),
        period: requireWholeNumber(item["period"], `${where} period`, 100, 900),
        volume: requireWholeNumber(item["volume"], `${where} volume`, 0, PAULA_MAX_VOLUME),
        priority: requireWholeNumber(item["priority"], `${where} priority`, 0, 0xffff),
        kind,
        milliseconds: requireWholeNumber(item["milliseconds"], `${where} milliseconds`, 0, 60000),
        provenance,
      }),
    );
  }
  if (samples.length === 0) throw new Error(`${label} carries no samples`);
  return samples;
}

/** The `triggers` array of either document shape, as an id -> sample map. */
function parseTriggers(
  raw: Record<string, unknown>,
  label: string,
  samples: readonly AudioSample[],
): Map<string, AudioSample> {
  const rawTriggers = raw["triggers"];
  if (!Array.isArray(rawTriggers)) throw new Error(`${label} has non-array triggers`);
  const triggers = new Map<string, AudioSample>();
  for (const [at, entry] of rawTriggers.entries()) {
    const item = entry as Record<string, unknown>;
    const id = item["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`${label} trigger ${at} has id ${describeValue(id)}`);
    }
    if (triggers.has(id)) throw new Error(`${label} binds ${id} twice`);
    const index = requireWholeNumber(item["sample"], `${label} trigger ${id}`, 0, samples.length - 1);
    const sample = samples[index];
    if (sample === undefined) throw new Error(`${label} trigger ${id} names sample ${index}`);
    triggers.set(id, sample);
  }
  return triggers;
}

// ---------------------------------------------------------------------------
// The engine sounds
// ---------------------------------------------------------------------------

/**
 * The ENGINE'S OWN SOUNDS — the seven effects `main.bin` plays itself, decoded
 * from its hunks 10/11 and shared by all three tables. Same sample shape as a
 * table's; the triggers are the engine's event names — `flipper-raise`,
 * `flipper-rest`, `serve`, `drain`, `level-transfer`, `capture`, `eject` — and
 * `src/browser/audio.ts` maps the tick report onto them.
 */
export interface EngineAudio {
  readonly displayName: string;
  readonly samples: readonly AudioSample[];
  /** The sample one engine event plays, or null. */
  sampleFor(triggerId: string): AudioSample | null;
}

/** Expands the engine document, checking every field. */
export function parseEngineAudioDocument(doc: EngineAudioDocument): EngineAudio {
  const raw = doc as unknown as Record<string, unknown> | null | undefined;
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error(`engine audio document must be an object, got ${describeValue(doc)}`);
  }
  if (raw["schema"] !== ENGINE_AUDIO_SCHEMA) {
    throw new Error(
      `engine audio document has schema ${describeValue(raw["schema"])}, expected "${ENGINE_AUDIO_SCHEMA}"`,
    );
  }
  const label = "engine audio";
  const displayName = raw["displayName"];
  if (typeof displayName !== "string" || displayName.length === 0) {
    throw new Error(`${label} has a non-string or empty displayName`);
  }
  const samples = parseSamples(raw, label);
  const triggers = parseTriggers(raw, label, samples);
  return Object.freeze({
    displayName,
    samples: Object.freeze(samples),
    sampleFor(triggerId: string): AudioSample | null {
      return triggers.get(triggerId) ?? null;
    },
  });
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const REGISTRY = new Map<TableId, TableAudio>();

export function registerTableAudio(audio: TableAudio): void {
  REGISTRY.set(audio.tableId, audio);
}

export function clearTableAudio(): void {
  REGISTRY.clear();
}

/** One table's sound effects, or null. Silence is never a boot failure. */
export function tableAudioFor(tableId: TableId): TableAudio | null {
  return REGISTRY.get(tableId) ?? null;
}

/** URL of one table's manifest, relative to the site root. */
export function tableAudioUrl(tableId: TableId, basePath: string = TABLE_AUDIO_BASE_PATH): string {
  return `${basePath}${tableId}.audio.json`;
}

/** URL of one sample's WAV, relative to the site root. */
export function audioSampleUrl(sample: AudioSample, basePath: string = TABLE_AUDIO_BASE_PATH): string {
  return `${basePath}${sample.file}`;
}

/** The slice of `Response` this loader needs, so tests can pass a plain object. */
export interface TableAudioResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

export type TableAudioFetch = (url: string) => Promise<TableAudioResponse>;

const defaultFetch: TableAudioFetch = (url) => fetch(url);

/** Fetches, parses and REGISTERS one table's sound effects. */
export async function loadTableAudio(
  tableId: TableId,
  fetchImpl: TableAudioFetch = defaultFetch,
  basePath: string = TABLE_AUDIO_BASE_PATH,
): Promise<TableAudio> {
  const url = tableAudioUrl(tableId, basePath);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const doc = (await response.json()) as TableAudioDocument;
  const audio = parseTableAudioDocument(doc);
  registerTableAudio(audio);
  return audio;
}

/** URL of the engine manifest, relative to the site root. */
export function engineAudioUrl(basePath: string = ENGINE_AUDIO_BASE_PATH): string {
  return `${basePath}engine.audio.json`;
}

/**
 * Fetches and parses the engine's sound manifest. No registry: there is one
 * document for the whole machine and the caller keeps it.
 */
export async function loadEngineAudio(
  fetchImpl: TableAudioFetch = defaultFetch,
  basePath: string = ENGINE_AUDIO_BASE_PATH,
): Promise<EngineAudio> {
  const url = engineAudioUrl(basePath);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const doc = (await response.json()) as EngineAudioDocument;
  return parseEngineAudioDocument(doc);
}

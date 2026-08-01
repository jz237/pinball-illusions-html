/**
 * Loader for the shipped mode and mission layer
 * (`public/generated/tables/*.modes.json`).
 *
 * ---------------------------------------------------------------------------
 * WHAT ARRIVES IN THIS DOCUMENT
 * ---------------------------------------------------------------------------
 * The missions are a BYTECODE PROGRAM, not a table of rules, and everything
 * needed to run one arrives together because none of it means anything alone:
 *
 *   SCRIPTS     the event records. Each is a list of instructions, each
 *               instruction a small opcode index and its operands, terminated by
 *               opcode 0. `jsr $6C10` in the original is a QUEUE APPEND, not an
 *               interpreter — the interpreters are at 0x58BC (the background
 *               queue) and 0x57AC (the running mission).
 *   ELEMENTS    the things a script arms, awards and waits on: the physical
 *               shots of a mission, each with a packed-BCD score, a bonus and an
 *               award-effect index.
 *   MESSAGES    the display records, expanded to their text so a mission can
 *               announce itself.
 *   MISSIONS    which script each selector entry starts, and its title.
 *   TRIGGERS    which script a device surface id, a trigger zone or a ball lock
 *               fires. This is the join between the physics and the rules, and
 *               it is the piece that took longest to find: a device's award
 *               record carries the script at +$1A, a mode record at +$16, a
 *               trigger zone's object at +$06 and a lock's object at +$14.
 *
 * `scripts/export-table-modes.mjs` has the disassembly behind every one of those
 * offsets, the checks the decode passes, and — at least as important — the list
 * of things it could not settle, chiefly that nine of the pointer-taking opcodes
 * address a record type nobody has identified and that the last hop of a mission
 * ladder is written at run time by an opcode whose stack has no decoded reader.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PARSER IS AS SUSPICIOUS AS THE OTHERS
 * ---------------------------------------------------------------------------
 * Same reason as `table-devices.ts`: a rules layer that is quietly one index out
 * awards the wrong shot, arms the wrong lamp and ends the wrong mission, and
 * none of that is visible from the outside. So every cross-reference in the
 * document is re-checked here — every element index, script index, message index
 * and branch target — and the first inconsistency throws. A game that refuses to
 * start is a better outcome than a game that runs the wrong mission.
 */

import { TABLE_IDS } from "./contracts.js";
import type { PlayfieldLevel, TableId, TableModesDocument } from "./contracts.js";

/** The only document schema this loader understands. */
export const TABLE_MODES_SCHEMA = "pinball-illusions/table-modes/v1";

/** Where the exported documents live under the site root (Vite serves `public/`). */
export const TABLE_MODES_BASE_PATH = "generated/tables/";

/**
 * The opcodes, by index. Names and lengths are the dispatch table at
 * main.seg00 0x5912; the operand kinds are settled per opcode in the exporter.
 *
 *   e  element index, -1 when the operand was NULL
 *   s  script index                    m  message index
 *   o  a record this decode has not identified; always -1 here
 *   w  a signed word                   c  a branch target, -1 when it dangles
 *   i  a 32-bit immediate
 */
export type ModeOperandKind = "e" | "s" | "m" | "o" | "w" | "c" | "i";

export interface ModeOpcodeInfo {
  readonly index: number;
  readonly name: string;
  readonly length: number;
  readonly args: readonly ModeOperandKind[];
}

/** One decoded instruction. `args` is positional and matches the opcode's kinds. */
export interface ModeInstruction {
  /** Byte offset of this instruction inside its script, which is what branches name. */
  readonly pc: number;
  readonly op: number;
  readonly args: readonly number[];
}

export interface ModeScript {
  readonly index: number;
  readonly ops: readonly ModeInstruction[];
  /** Instruction index for a pc, so a branch is a lookup rather than a search. */
  indexOfPc(pc: number): number;
}

/**
 * One playfield element: a shot a mission can arm, award and wait on.
 *
 * `score` and `bonus` are the packed-BCD fields at +$1E and +$26 read as decimal
 * numbers. `effect` is the index into the award-effect table at 0x5D0E, of which
 * six entries are decoded; see `mode-vm.ts` for which and for what the rest do
 * (nothing, deliberately).
 */
export interface ModeElement {
  readonly index: number;
  readonly flags: number;
  readonly score: number;
  readonly bonus: number;
  readonly effect: number;
  /** The record's own countdown field; -1 is "no timer". */
  readonly countdown: number;
  readonly lampStart: boolean;
  readonly lampAward: boolean;
  readonly soundStart: boolean;
  readonly soundAward: boolean;
  readonly displayStart: number;
  readonly displayAward: number;
  /** Award effect 21's ladder step: the script queued when the count is reached. */
  readonly counterScript: number;
  readonly counterTarget: number;
}

export interface ModeMessage {
  readonly index: number;
  readonly lines: readonly string[];
}

export interface ModeMission {
  /** 1-based id inside its selector table, or 0 for a mode nothing selects. */
  readonly id: number;
  readonly selector: number;
  /** True when a selector table offers this mode to the player. */
  readonly selected: boolean;
  readonly script: number;
  readonly launcher: number;
  readonly lamp: boolean;
  readonly title: string;
}

export interface ModeTrigger {
  readonly level: PlayfieldLevel;
  /** Surface id for a device binding, zone list index for a zone or lock. */
  readonly id: number;
  readonly script: number;
}

export interface TableModes {
  readonly tableId: TableId;
  readonly displayName: string;
  readonly opcodes: readonly ModeOpcodeInfo[];
  readonly elements: readonly ModeElement[];
  readonly messages: readonly ModeMessage[];
  readonly scripts: readonly ModeScript[];
  readonly missions: readonly ModeMission[];
  /** Indices into `missions` of the modes a selector table offers, in table order. */
  readonly selectable: readonly number[];
  /**
   * THE MODE-ARM ELEMENTS, derived rather than declared.
   *
   * Every mission's prologue runs `COMPLETE` on the same three-to-five elements
   * and its epilogue runs `CLEAR_DONE` on exactly those same ones: a mission
   * takes the arm shot away while it runs and gives it back when it finishes. So
   * an arm element is one that some mission both COMPLETEs and CLEAR_DONEs, and
   * that is computable from the shipped scripts without anybody declaring it.
   *
   * They matter because they are the physical join to mission SELECTION. Law 'n
   * Justice's type-1 mode device fires a script that does nothing but
   * `START <arm element>` — the shot that lights "a mission may now begin". What
   * the engine does with that is not decoded; see the selector reconstruction in
   * `mode-vm.ts`.
   */
  readonly armElements: readonly number[];
  /** The script a device surface id fires on one level, or -1. */
  scriptForDevice(level: PlayfieldLevel, surfaceId: number): number;
  /** The script a trigger zone fires, or -1. */
  scriptForZone(level: PlayfieldLevel, index: number): number;
  /** The script a ball lock fires when it swallows a ball, or -1. */
  scriptForLock(level: PlayfieldLevel, index: number): number;
  opcodeName(op: number): string;
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

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array, got ${describeValue(value)}`);
  return value;
}

const OPERAND_KINDS: readonly string[] = ["e", "s", "m", "o", "w", "c", "i"];

/** The two opcodes that bracket a mission's use of an arm element. */
const OPCODE_COMPLETE = 3;
const OPCODE_CLEAR_DONE = 12;

/** Expands one document into a `TableModes`, checking every cross-reference. */
export function parseTableModesDocument(doc: TableModesDocument): TableModes {
  const raw = doc as unknown as Record<string, unknown> | null | undefined;
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error(`table modes document must be an object, got ${describeValue(doc)}`);
  }
  if (raw["schema"] !== TABLE_MODES_SCHEMA) {
    throw new Error(
      `table modes document has schema ${describeValue(raw["schema"])}, expected "${TABLE_MODES_SCHEMA}"`,
    );
  }
  const tableIdValue = raw["tableId"];
  if (typeof tableIdValue !== "string" || !isTableId(tableIdValue)) {
    throw new Error(`table modes document has unknown tableId ${describeValue(tableIdValue)}`);
  }
  const tableId: TableId = tableIdValue;
  const label = `table modes "${tableId}"`;

  const displayName = raw["displayName"];
  if (typeof displayName !== "string" || displayName.length === 0) {
    throw new Error(`${label} has a non-string or empty displayName`);
  }

  // --- opcodes -------------------------------------------------------------
  const opcodes: ModeOpcodeInfo[] = [];
  for (const [at, entry] of requireArray(raw["opcodes"], `${label} opcodes`).entries()) {
    const item = entry as Record<string, unknown>;
    const where = `${label} opcode ${at}`;
    const index = requireWholeNumber(item["index"], `${where} index`, 0, 255);
    if (index !== at) throw new Error(`${where} is filed at slot ${at}; the table must be dense`);
    const name = item["name"];
    if (typeof name !== "string" || name.length === 0) throw new Error(`${where} has no name`);
    const args = item["args"];
    if (typeof args !== "string" || [...args].some((kind) => !OPERAND_KINDS.includes(kind))) {
      throw new Error(`${where} has operand kinds ${describeValue(args)}`);
    }
    opcodes.push(
      Object.freeze({
        index,
        name,
        length: requireWholeNumber(item["length"], `${where} length`, 2, 64),
        args: Object.freeze([...args] as ModeOperandKind[]),
      }),
    );
  }
  if (opcodes.length === 0) throw new Error(`${label} carries no opcode table`);

  // --- messages ------------------------------------------------------------
  const messages: ModeMessage[] = [];
  for (const [at, entry] of requireArray(raw["messages"], `${label} messages`).entries()) {
    const item = entry as Record<string, unknown>;
    const lines = requireArray(item["lines"], `${label} message ${at} lines`);
    if (lines.some((line) => typeof line !== "string")) {
      throw new Error(`${label} message ${at} has a non-string line`);
    }
    messages.push(Object.freeze({ index: at, lines: Object.freeze(lines as string[]) }));
  }

  // --- elements ------------------------------------------------------------
  const rawElements = requireArray(raw["elements"], `${label} elements`);
  const elements: ModeElement[] = [];
  for (const [at, entry] of rawElements.entries()) {
    const item = entry as Record<string, unknown>;
    const where = `${label} element ${at}`;
    const displayStart = requireWholeNumber(item["displayStart"], `${where} displayStart`, -1, messages.length - 1);
    const displayAward = requireWholeNumber(item["displayAward"], `${where} displayAward`, -1, messages.length - 1);
    elements.push(
      Object.freeze({
        index: requireWholeNumber(item["index"], `${where} index`, at, at),
        flags: requireWholeNumber(item["flags"], `${where} flags`, 0, 255),
        score: requireWholeNumber(item["score"], `${where} score`, 0, Number.MAX_SAFE_INTEGER),
        bonus: requireWholeNumber(item["bonus"], `${where} bonus`, 0, Number.MAX_SAFE_INTEGER),
        effect: requireWholeNumber(item["effect"], `${where} effect`, 0, 0xffff),
        countdown: requireWholeNumber(item["countdown"], `${where} countdown`, -0x8000, 0x7fff),
        lampStart: item["lampStart"] === true,
        lampAward: item["lampAward"] === true,
        soundStart: item["soundStart"] === true,
        soundAward: item["soundAward"] === true,
        displayStart,
        displayAward,
        counterScript: requireWholeNumber(item["counterScript"], `${where} counterScript`, -1, 0xffff),
        counterTarget: requireWholeNumber(item["counterTarget"], `${where} counterTarget`, 0, 0xffff),
      }),
    );
  }

  // --- scripts -------------------------------------------------------------
  const rawScripts = requireArray(raw["scripts"], `${label} scripts`);
  const scriptCount = rawScripts.length;

  // Two passes: the shapes first, so a MODE_START can be checked against the
  // real script count rather than against however many happen to be parsed yet.
  const parsed = rawScripts.map((entry, at) => {
    const item = entry as Record<string, unknown>;
    const ops = requireArray(item["ops"], `${label} script ${at} ops`);
    let previous = -1;
    return ops.map((opEntry, opAt) => {
      const op = opEntry as Record<string, unknown>;
      const where = `${label} script ${at} op ${opAt}`;
      const pc = requireWholeNumber(op["pc"], `${where} pc`, 0, 0x7fff);
      if (pc <= previous) throw new Error(`${where} has pc ${pc} after ${previous}; pcs must ascend`);
      previous = pc;
      const index = requireWholeNumber(op["op"], `${where} op`, 0, opcodes.length - 1);
      const args = requireArray(op["args"], `${where} args`);
      const kinds = opcodes[index]?.args ?? [];
      if (args.length !== kinds.length) {
        throw new Error(
          `${where} is ${opcodes[index]?.name} and carries ${args.length} operand(s), not ${kinds.length}`,
        );
      }
      return { pc, op: index, args: args as number[], kinds };
    });
  });

  const scripts: ModeScript[] = parsed.map((ops, at) => {
    const boundaries = new Set(ops.map((op) => op.pc));
    const instructions: ModeInstruction[] = ops.map((op, opAt) => {
      const where = `${label} script ${at} op ${opAt} (${opcodes[op.op]?.name})`;
      for (const [argAt, kind] of op.kinds.entries()) {
        const value = op.args[argAt];
        if (typeof value !== "number" || !Number.isInteger(value)) {
          throw new Error(`${where} operand ${argAt} is ${describeValue(value)}`);
        }
        if (kind === "e" && (value < -1 || value >= elements.length)) {
          throw new Error(`${where} names element ${value}, and there are ${elements.length}`);
        }
        if (kind === "s" && (value < -1 || value >= scriptCount)) {
          throw new Error(`${where} names script ${value}, and there are ${scriptCount}`);
        }
        if (kind === "m" && (value < -1 || value >= messages.length)) {
          throw new Error(`${where} names message ${value}, and there are ${messages.length}`);
        }
        // -1 is a branch the record does not contain: several missions share one
        // timeout label that lives outside their own code. The runtime ends the
        // script there rather than jumping into somebody else's.
        if (kind === "c" && value !== -1 && !boundaries.has(value)) {
          throw new Error(`${where} branches to +0x${value.toString(16)}, which is not an instruction`);
        }
      }
      return Object.freeze({
        pc: op.pc,
        op: op.op,
        args: Object.freeze([...(op.args as number[])]),
      });
    });
    const byPc = new Map(instructions.map((op, i) => [op.pc, i]));
    return Object.freeze({
      index: at,
      ops: Object.freeze(instructions),
      indexOfPc(pc: number): number {
        return byPc.get(pc) ?? -1;
      },
    });
  });

  for (const [at, element] of elements.entries()) {
    if (element.counterScript >= scriptCount) {
      throw new Error(`${label} element ${at} names counter script ${element.counterScript}`);
    }
  }

  // --- missions ------------------------------------------------------------
  const missions: ModeMission[] = [];
  for (const [at, entry] of requireArray(raw["missions"], `${label} missions`).entries()) {
    const item = entry as Record<string, unknown>;
    const where = `${label} mission ${at}`;
    const title = item["title"];
    missions.push(
      Object.freeze({
        id: requireWholeNumber(item["id"], `${where} id`, 0, 255),
        selector: requireWholeNumber(item["selector"], `${where} selector`, -1, 15),
        selected: item["selected"] === true,
        script: requireWholeNumber(item["script"], `${where} script`, 0, scriptCount - 1),
        launcher: requireWholeNumber(item["launcher"], `${where} launcher`, -1, scriptCount - 1),
        lamp: item["lamp"] === true,
        title: typeof title === "string" ? title : "",
      }),
    );
  }

  // --- triggers ------------------------------------------------------------
  const rawTriggers = raw["triggers"];
  if (rawTriggers === null || typeof rawTriggers !== "object") {
    throw new Error(`${label} has no triggers block`);
  }
  const triggers = rawTriggers as Record<string, unknown>;
  const readTriggers = (kind: "devices" | "zones" | "locks", idKey: string): Map<string, number> => {
    const out = new Map<string, number>();
    for (const [at, entry] of requireArray(triggers[kind], `${label} ${kind} triggers`).entries()) {
      const item = entry as Record<string, unknown>;
      const where = `${label} ${kind} trigger ${at}`;
      const level = requireWholeNumber(item["level"], `${where} level`, 0, 1);
      const id = requireWholeNumber(item[idKey], `${where} ${idKey}`, 0, 255);
      const script = requireWholeNumber(item["script"], `${where} script`, 0, scriptCount - 1);
      const bindKey = `${level}:${id}`;
      if (out.has(bindKey)) throw new Error(`${where} binds ${bindKey} twice`);
      out.set(bindKey, script);
    }
    return out;
  };
  const deviceTriggers = readTriggers("devices", "surfaceId");
  const zoneTriggers = readTriggers("zones", "index");
  const lockTriggers = readTriggers("locks", "index");

  const opcodeNames = opcodes.map((op) => op.name);

  const selectable = missions.flatMap((mission, at) => (mission.selected ? [at] : []));

  // An arm element is one some mission both COMPLETEs and CLEAR_DONEs. Derived
  // here, once, so the runtime never walks the scripts looking for it.
  const armElements: number[] = [];
  const completed = new Set<number>();
  const restored = new Set<number>();
  for (const mission of missions) {
    for (const op of scripts[mission.script]?.ops ?? []) {
      const operand = op.args[0] ?? -1;
      if (operand < 0) continue;
      if (op.op === OPCODE_COMPLETE) completed.add(operand);
      if (op.op === OPCODE_CLEAR_DONE) restored.add(operand);
    }
  }
  for (const element of completed) {
    if (restored.has(element)) armElements.push(element);
  }
  armElements.sort((a, b) => a - b);

  return Object.freeze({
    tableId,
    displayName,
    opcodes: Object.freeze(opcodes),
    elements: Object.freeze(elements),
    messages: Object.freeze(messages),
    scripts: Object.freeze(scripts),
    missions: Object.freeze(missions),
    selectable: Object.freeze(selectable),
    armElements: Object.freeze(armElements),
    scriptForDevice(level: PlayfieldLevel, surfaceId: number): number {
      return deviceTriggers.get(`${level === 1 ? 1 : 0}:${surfaceId}`) ?? -1;
    },
    scriptForZone(level: PlayfieldLevel, index: number): number {
      return zoneTriggers.get(`${level === 1 ? 1 : 0}:${index}`) ?? -1;
    },
    scriptForLock(level: PlayfieldLevel, index: number): number {
      return lockTriggers.get(`${level === 1 ? 1 : 0}:${index}`) ?? -1;
    },
    opcodeName(op: number): string {
      return opcodeNames[op] ?? `op${op}`;
    },
  });
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const REGISTRY = new Map<TableId, TableModes>();

/** Makes one table's mission layer available to `createGame`. Idempotent. */
export function registerTableModes(modes: TableModes): void {
  REGISTRY.set(modes.tableId, modes);
}

/** Forgets every registration. For tests that need a clean slate. */
export function clearTableModes(): void {
  REGISTRY.clear();
}

/**
 * One table's mission layer, or null.
 *
 * Nullable for the same reason the scoring layer is: a table without missions
 * rolls exactly the same ball, and every physics test in this project builds a
 * game on a synthetic map that has no missions at all and must go on working.
 */
export function tableModesFor(tableId: TableId): TableModes | null {
  return REGISTRY.get(tableId) ?? null;
}

/** URL of one table's exported mission layer, relative to the site root. */
export function tableModesUrl(tableId: TableId, basePath: string = TABLE_MODES_BASE_PATH): string {
  return `${basePath}${tableId}.modes.json`;
}

/** The slice of `Response` this loader needs, so tests can pass a plain object. */
export interface TableModesResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

export type TableModesFetch = (url: string) => Promise<TableModesResponse>;

const defaultFetch: TableModesFetch = (url) => fetch(url);

/** Fetches, parses and REGISTERS one table's mission layer. */
export async function loadTableModes(
  tableId: TableId,
  fetchImpl: TableModesFetch = defaultFetch,
  basePath: string = TABLE_MODES_BASE_PATH,
): Promise<TableModes> {
  const url = tableModesUrl(tableId, basePath);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const doc = (await response.json()) as TableModesDocument;
  const modes = parseTableModesDocument(doc);
  registerTableModes(modes);
  return modes;
}

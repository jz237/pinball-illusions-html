/**
 * THE RAM-CORPUS PHYSICS GATE — the scorer, in one place.
 *
 * This module is the ONLY implementation of the score. It is imported by two
 * callers and by nothing else:
 *
 *   game/tests/physics-gate.test.ts        the suite's copy: pins the figures,
 *                                          skips cleanly without the corpus
 *   research/physics-gate/physics-gate.mts the operator's copy: same numbers,
 *                                          plus the per-frame CSV, the report
 *                                          file and a non-zero exit on drift
 *
 * It lives in `tests/` rather than in the research tree on purpose. Here it is
 * covered by `npx tsc --noEmit` and by the suite, so it cannot quietly rot; the
 * arch round's post-mortem of the film instrument (see
 * `research/view/compare/tools/README.md`) is the whole argument for not letting
 * a load-bearing instrument live as an unchecked script.
 *
 * WHAT IT MEASURES. The original AGA machine's own ball record, read frame by
 * frame out of live emulator RAM over four untouched Law 'n Justice launches
 * (session 4, 2026-08-03; provenance in
 * `research/physics-gate/corpus/CORPUS.txt`). For every frame pair the corpus
 * offers, the SHIPPED `stepBalls` is handed the machine's own exact start state
 * — its Q10 centre, its 1/256-px/frame velocity word, its level, the shipped
 * map, drive and surface layer — and run for exactly ONE tick. The answer is
 * compared with what the machine's RAM held on the next frame.
 *
 * One frame at a time is the point: errors cannot accumulate, so a rule that is
 * right about the trajectory but wrong about the contact cannot hide, and a rule
 * that is wrong about the contact cannot be excused by drift.
 *
 * THE CORPUS, as `research/ARCH_NORMAL_DECODE.md` section 4 defines it:
 * 866 sampled frames -> 854 pairs with a stable level -> 576 after dropping
 * frame 0 and every frame whose ring touches a FLIPPER-BAT footprint (surface
 * ids 1..4), which `flippers.ts` owns and the map does not model. 218 of the
 * 576 are frames the machine itself flags as a contact.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { PlayfieldLevel, TableId } from "../src/game/contracts.js";
import { REST_THRESHOLD, createBall, createBallSet, stepBalls } from "../src/game/ball-physics.js";
import { parseTableMapDocument } from "../src/game/table-map.js";
import {
  parseTableAccelDocument,
  registerTableAcceleration,
  tableAccelerationFor,
} from "../src/game/table-accel.js";
import {
  parseTableDevicesDocument,
  registerTableDevices,
  tableDevicesFor,
} from "../src/game/table-devices.js";
import { materialTableFor } from "../src/game/materials.js";
import { PROBE_RING, numberAt } from "../src/game/collision-probe.js";
import { SIMULATION_GRAVITY } from "../src/game/timebase.js";

// ---------------------------------------------------------------------------
// The pin
// ---------------------------------------------------------------------------

export interface GateFigures {
  /** Frames scored. Part of the pin: a different count means a different corpus. */
  readonly frames: number;
  /** Of those, frames the machine's own record flags as a contact. */
  readonly contacts: number;
  /** Frames whose velocity answer is under half a unit of 1/256 px/frame out. */
  readonly velExact: number;
  /** Frames within four units — the acceptance band ARCH_NORMAL_DECODE quotes. */
  readonly velWithin4: number;
  /** Total per-frame velocity error in the machine's own units, rounded. */
  readonly errorSum: number;
  /** Frames whose per-tick POSITION is the machine's, to the Q10 unit. */
  readonly posExact: number;
}

/**
 * THE BASELINE, measured on the shipped `stepBalls` at game commit 78bed65
 * ("The tick is the machine's frame: eight substeps, four collision passes").
 *
 * These are not targets anybody chose. They are what the machine's own RAM says
 * this port scores, and the tolerance is EXACT — see
 * `research/physics-gate/README.md` for why a band would hide the regressions
 * that matter.
 */
export const PHYSICS_GATE_BASELINE: GateFigures = {
  frames: 576,
  contacts: 218,
  velExact: 466,
  velWithin4: 517,
  errorSum: 1790,
  posExact: 464,
};

/**
 * THE PRE-FIX CONTROL, measured on the same corpus with the same instrument at
 * game commit c9724a4 — the swept path with the `|v|/4` walk along the contact
 * bearing and `v += a; x += v` integration. Recorded so a future reader can see
 * the SCALE the baseline sits on: the fix is 11.8x on velocity, and it took the
 * per-tick position from never right to right on 464 of 576 frames.
 *
 * Not asserted anywhere — it describes a tree that no longer exists. It is here
 * so that "1790" is a number with a size rather than a number with a colour.
 */
export const PHYSICS_GATE_CONTROL: GateFigures = {
  frames: 576,
  contacts: 218,
  velExact: 436,
  velWithin4: 440,
  errorSum: 21089,
  posExact: 0,
};

// ---------------------------------------------------------------------------
// Locating the corpus
// ---------------------------------------------------------------------------

export const CORPUS_TRACES = [
  "trace-coldA.csv",
  "trace-coldB.csv",
  "trace-coldD.csv",
  "trace-warm-ball1.csv",
] as const;

/**
 * Walks up from `from` to the directory that holds BOTH `game/` and `research/`.
 *
 * Deliberately not `import.meta.url`-relative arithmetic: this module is also
 * bundled by esbuild into `research/physics-gate/build/`, where a module-relative
 * path would resolve against the bundle instead of the source. Both callers pass
 * their own starting directory and this walk finds the same root from either.
 */
export function findProjectRoot(from: string): string | null {
  let dir = from;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, "game", "public", "generated", "tables"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export function corpusDirFor(root: string): string {
  return join(root, "research", "physics-gate", "corpus");
}

/** True when every trace of the corpus is on disk beside the repo. */
export function corpusPresent(root: string | null): root is string {
  if (root === null) return false;
  const dir = corpusDirFor(root);
  return CORPUS_TRACES.every((name) => existsSync(join(dir, name)));
}

// ---------------------------------------------------------------------------
// The traces
// ---------------------------------------------------------------------------

interface TraceRow {
  readonly frame: number;
  readonly level: PlayfieldLevel;
  readonly qx: number;
  readonly qy: number;
  readonly vx: number;
  readonly vy: number;
  readonly cx: number;
  readonly cy: number;
  readonly contact: boolean;
}

function loadTrace(path: string): TraceRow[] {
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const head = (lines[0] ?? "").split(",");
  const col = (name: string): number => {
    const at = head.indexOf(name);
    if (at < 0) throw new Error(`${path}: trace has no ${name} column`);
    return at;
  };
  const [frame, lvl, cx, cy, vxRaw, vyRaw, contact] = [
    col("frame"),
    col("lvl"),
    col("cx"),
    col("cy"),
    col("vxRaw"),
    col("vyRaw"),
    col("contact"),
  ] as const;
  const rows: TraceRow[] = [];
  for (const line of lines.slice(1)) {
    const f = line.split(",");
    const x = Number(f[cx]);
    const y = Number(f[cy]);
    rows.push({
      frame: Number(f[frame]),
      level: f[lvl] === "0" ? 0 : 1,
      // The trace prints the machine's Q10 centre as a decimal; 1024ths recover
      // it exactly, which is why the corpus is stored with four decimal places.
      qx: Math.round(x * 1024),
      qy: Math.round(y * 1024),
      vx: Number(f[vxRaw]),
      vy: Number(f[vyRaw]),
      cx: x,
      cy: y,
      contact: f[contact] === "1",
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------

/** The table the four traces were taken on. */
const TABLE: TableId = "law-n-justice";

/** One of the machine's velocity units is four Q10. */
const Q10_PER_MACHINE_UNIT = 4;

export interface GateRow {
  readonly trace: string;
  readonly frame: number;
  readonly level: PlayfieldLevel;
  readonly cx: number;
  readonly cy: number;
  readonly inVx: number;
  readonly inVy: number;
  readonly portVx: number;
  readonly portVy: number;
  readonly machineVx: number;
  readonly machineVy: number;
  readonly error: number;
  readonly portQx: number;
  readonly portQy: number;
  readonly machineQx: number;
  readonly machineQy: number;
  readonly posExact: boolean;
  readonly contact: boolean;
}

export interface TraceFigures extends GateFigures {
  readonly trace: string;
}

export interface GateReport {
  readonly all: GateFigures;
  /** The same score restricted to the frames the machine flags as contacts. */
  readonly contactOnly: GateFigures;
  readonly perTrace: readonly TraceFigures[];
  readonly rows: readonly GateRow[];
  readonly medianError: number;
  readonly p90Error: number;
  /** The largest single-frame error, and where it is. */
  readonly worst: GateRow | null;
}

function figuresFor(rows: readonly GateRow[]): GateFigures {
  let velExact = 0;
  let velWithin4 = 0;
  let posExact = 0;
  let contacts = 0;
  let sum = 0;
  for (const row of rows) {
    if (row.error < 0.5) velExact += 1;
    if (row.error <= 4) velWithin4 += 1;
    if (row.posExact) posExact += 1;
    if (row.contact) contacts += 1;
    sum += row.error;
  }
  return {
    frames: rows.length,
    contacts,
    velExact,
    velWithin4,
    errorSum: Math.round(sum),
    posExact,
  };
}

function quantile(sorted: readonly number[], at: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.trunc(sorted.length * at))] ?? 0;
}

/**
 * Scores the SHIPPED physics against the machine's own record.
 *
 * `root` is the directory holding `game/` and `research/`; everything is read
 * from under it, so the same call works from the suite and from the bundled
 * research runner.
 */
export function runPhysicsGate(root: string): GateReport {
  const tables = join(root, "game", "public", "generated", "tables");
  const readJson = (path: string): never => JSON.parse(readFileSync(path, "utf8")) as never;

  registerTableAcceleration(parseTableAccelDocument(readJson(join(tables, `${TABLE}.accel.json`))));
  registerTableDevices(parseTableDevicesDocument(readJson(join(tables, `${TABLE}.devices.json`))));
  const map = parseTableMapDocument(readJson(join(tables, `${TABLE}.map.json`)));
  const materials = materialTableFor(TABLE);
  const drive = tableAccelerationFor(TABLE);
  const devices = tableDevicesFor(TABLE);
  if (devices === null) {
    throw new Error(`${TABLE}.devices.json did not register a surface layer`);
  }

  /** ARCH_NORMAL_DECODE section 4: a bat footprint under the ring disqualifies. */
  const touchesBat = (level: PlayfieldLevel, px: number, py: number): boolean => {
    for (let i = 0; i < PROBE_RING.size; i += 1) {
      const id = devices.surfaceIdAt(
        level,
        px + numberAt(PROBE_RING.dx, i),
        py + numberAt(PROBE_RING.dy, i),
      );
      if (id >= 1 && id <= 4) return true;
    }
    return false;
  };

  const forces = { gravityY: SIMULATION_GRAVITY, nudgeX: 0, nudgeY: 0 };
  const options = {
    rampDrive: drive,
    surfaces: devices,
    poweredKicksLive: true,
    ballToBall: false,
    restThreshold: REST_THRESHOLD,
  };

  const corpus = corpusDirFor(root);
  const rows: GateRow[] = [];
  const perTrace: TraceFigures[] = [];

  for (const name of CORPUS_TRACES) {
    const trace = loadTrace(join(corpus, name));
    const label = name.replace(/^trace-/, "").replace(/\.csv$/, "");
    const before = rows.length;
    for (let i = 0; i < trace.length - 1; i += 1) {
      const from = trace[i];
      const to = trace[i + 1];
      if (from === undefined || to === undefined) continue;
      // A level hand-off swaps the collision line underneath the ball, so the
      // pair is not one frame of one machine; frame 0 is the plunger kick.
      if (from.level !== to.level) continue;
      if (from.frame === 0) continue;
      if (touchesBat(from.level, from.qx >> 10, from.qy >> 10)) continue;

      const ball = createBall(
        1,
        from.qx,
        from.qy,
        from.vx * Q10_PER_MACHINE_UNIT,
        from.vy * Q10_PER_MACHINE_UNIT,
        from.level,
      );
      const set = createBallSet([ball]);
      stepBalls(set, map, materials, forces, options);
      const stepped = set.balls[0];
      if (stepped === undefined) throw new Error(`${name} frame ${from.frame}: the ball vanished`);

      const portVx = stepped.velocityX / Q10_PER_MACHINE_UNIT;
      const portVy = stepped.velocityY / Q10_PER_MACHINE_UNIT;
      const dx = portVx - to.vx;
      const dy = portVy - to.vy;
      // `sqrt(dx*dx + dy*dy)` and not `Math.hypot`: multiplication, addition and
      // square root are all correctly rounded by IEEE 754, so this figure is
      // bit-identical on every platform and every node build. `Math.hypot` is
      // implementation-defined and would put the pin at the mercy of a V8
      // upgrade. (They agree to the last digit on this corpus; the point is that
      // they are GUARANTEED to, this way.)
      rows.push({
        trace: label,
        frame: from.frame,
        level: from.level,
        cx: from.cx,
        cy: from.cy,
        inVx: from.vx,
        inVy: from.vy,
        portVx,
        portVy,
        machineVx: to.vx,
        machineVy: to.vy,
        error: Math.sqrt(dx * dx + dy * dy),
        portQx: stepped.x,
        portQy: stepped.y,
        machineQx: to.qx,
        machineQy: to.qy,
        posExact: stepped.x === to.qx && stepped.y === to.qy,
        contact: to.contact,
      });
    }
    perTrace.push({ trace: label, ...figuresFor(rows.slice(before)) });
  }

  const sorted = rows.map((row) => row.error).sort((a, b) => a - b);
  let worst: GateRow | null = null;
  for (const row of rows) {
    if (worst === null || row.error > worst.error) worst = row;
  }

  return {
    all: figuresFor(rows),
    contactOnly: figuresFor(rows.filter((row) => row.contact)),
    perTrace,
    rows,
    medianError: quantile(sorted, 0.5),
    p90Error: quantile(sorted, 0.9),
    worst,
  };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export type GateVerdict = "pass" | "regression" | "moved" | "corpus";

export interface GateDelta {
  readonly field: keyof GateFigures;
  readonly baseline: number;
  readonly measured: number;
  /** True when the move is away from the machine. */
  readonly worse: boolean;
}

export interface GateJudgement {
  readonly verdict: GateVerdict;
  readonly deltas: readonly GateDelta[];
}

/**
 * Compares a measured score with the pin.
 *
 * `frames` and `contacts` describe the CORPUS, not the physics: if either moves,
 * the data underneath the instrument changed and no statement about the physics
 * can be made from this run at all. That is `"corpus"`, and it is reported
 * separately so nobody reads instrument rot as a regression (which is exactly
 * how the film instrument's false ~14% alarm was misread in 2026-08-02).
 *
 * Of the rest, `errorSum` rising, or any of the three exact/near counts falling,
 * is `"regression"`. Anything else that moved is `"moved"` — an improvement, or
 * a mixture, and either way something a round has to explain and re-pin.
 */
export function judgePhysicsGate(
  measured: GateFigures,
  baseline: GateFigures = PHYSICS_GATE_BASELINE,
): GateJudgement {
  const deltas: GateDelta[] = [];
  const push = (field: keyof GateFigures, worseWhen: (a: number, b: number) => boolean): void => {
    const a = measured[field];
    const b = baseline[field];
    if (a !== b) deltas.push({ field, baseline: b, measured: a, worse: worseWhen(a, b) });
  };
  push("frames", () => true);
  push("contacts", () => true);
  if (deltas.length > 0) return { verdict: "corpus", deltas };

  push("velExact", (a, b) => a < b);
  push("velWithin4", (a, b) => a < b);
  push("posExact", (a, b) => a < b);
  push("errorSum", (a, b) => a > b);

  if (deltas.length === 0) return { verdict: "pass", deltas };
  return { verdict: deltas.some((d) => d.worse) ? "regression" : "moved", deltas };
}

/** The human-readable score, identical in the suite's failure and the report. */
export function formatGateFigures(tag: string, figures: GateFigures): string {
  return (
    `${tag.padEnd(10)} n=${String(figures.frames).padStart(3)} ` +
    `contacts=${String(figures.contacts).padStart(3)} ` +
    `velExact=${String(figures.velExact).padStart(3)} ` +
    `<=4=${String(figures.velWithin4).padStart(3)} ` +
    `errorSum=${String(figures.errorSum).padStart(5)} ` +
    `posExact=${String(figures.posExact).padStart(3)}`
  );
}

export function formatGateReport(report: GateReport): string {
  const lines = [
    formatGateFigures("ALL", report.all),
    formatGateFigures("CONTACT", report.contactOnly),
    `           median=${report.medianError.toFixed(2)} p90=${report.p90Error.toFixed(2)}` +
      (report.worst === null
        ? ""
        : `  worst=${report.worst.error.toFixed(2)} at ${report.worst.trace} frame ` +
          `${report.worst.frame} (${report.worst.cx.toFixed(2)},${report.worst.cy.toFixed(2)})`),
    "",
    "per trace:",
  ];
  for (const trace of report.perTrace) lines.push(`  ${formatGateFigures(trace.trace, trace)}`);
  return lines.join("\n");
}

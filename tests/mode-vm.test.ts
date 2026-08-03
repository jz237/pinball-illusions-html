/**
 * The mission machine.
 *
 * The unit half runs a hand-built two-element table so each opcode's behaviour is
 * isolated and readable; the integration half runs the real Law 'n Justice
 * document, because the thing that actually had to be proved is that a MISSION
 * STARTS AND FINISHES on the shipped data. Everything in between — the queue
 * running one opcode a frame, the wait falling through when a shot goes out, the
 * timeout branching — is checked on the fixture where a failure names one rule.
 */

import { describe, expect, it } from "vitest";
import type { TableModesDocument } from "../src/game/contracts.js";
import { parseTableModesDocument } from "../src/game/table-modes.js";
import type { TableModes } from "../src/game/table-modes.js";
import {
  MODE_MAX_BALLS,
  MODE_QUEUE_SLOTS,
  TICKS_PER_SECOND,
  comboCount,
  createModeState,
  endMission,
  litElements,
  missionRunning,
  missionSecondsLeft,
  queueScript,
  resetModesForNewBall,
  startSelectedMission,
  tickModes,
} from "../src/game/mode-vm.js";
import type { ModeState } from "../src/game/mode-vm.js";
import {
  createGame,
  runTicks,
  runningMission,
  startGame,
} from "../src/browser/game-loop.js";
import type { InputSource } from "../src/browser/game-loop.js";
import { CONTROLS, IDLE_SNAPSHOT } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { devicesFor, mapFor, modesFor } from "./table-fixtures.js";
import { pixelsToQ10 } from "../src/core/fixed-point.js";

/**
 * One tick of a player who plunges early and taps both bats on fixed beats.
 *
 * Stateless on purpose — `runTicks` is called one tick at a time here so the
 * mission can be inspected between frames, and a router that remembered its own
 * previous sample would report every press twice.
 */
function playingInput(tick: number, left = 23, right = 29): InputSource {
  const wanted = new Set<Control>();
  const phase = tick % 400;
  if (phase >= 40 && phase < 100) wanted.add("plunger");
  if (tick % left < 4) wanted.add("leftFlipper");
  if ((tick + 11) % right < 4) wanted.add("rightFlipper");
  const previous = new Set<Control>();
  const priorPhase = (tick - 1 + 400) % 400;
  if (tick > 0) {
    if (priorPhase >= 40 && priorPhase < 100) previous.add("plunger");
    if ((tick - 1) % left < 4) previous.add("leftFlipper");
    if ((tick + 10) % right < 4) previous.add("rightFlipper");
  }
  const controls = {} as Record<Control, ControlEdges>;
  for (const control of CONTROLS) {
    const down = wanted.has(control);
    const was = previous.has(control);
    controls[control] = {
      down,
      pressed: down && !was,
      released: !down && was,
      pressCount: down && !was ? 1 : 0,
      releaseCount: !down && was ? 1 : 0,
    };
  }
  const snapshot: ControlSnapshot = { sequence: tick + 1, controls };
  return { sample: () => snapshot };
}

// ---------------------------------------------------------------------------
// A fixture table
// ---------------------------------------------------------------------------

const OPCODES = Array.from({ length: 32 }, (_, index) => {
  const named: Readonly<Record<number, readonly [string, number, string]>> = {
    0: ["END", 2, ""],
    1: ["START", 6, "e"],
    2: ["START_TIMED", 8, "ew"],
    3: ["COMPLETE", 6, "e"],
    5: ["AWARD", 6, "e"],
    9: ["MODE_START", 6, "s"],
    10: ["JMP", 4, "c"],
    12: ["CLEAR_DONE", 6, "e"],
    14: ["LAMP_OFF", 6, "e"],
    // The music command post, handler main.seg00 $5B3E. Its operand is the
    // kind-4 record, which this document has no pool for and exports as -1.
    19: ["MUSIC", 6, "o"],
    23: ["JMP_IF_UNLIT", 8, "ec"],
    27: ["BALLS_UP_TO", 4, "w"],
    28: ["WAIT", 10, "ewc"],
  };
  const entry = named[index] ?? ([`OP${index}`, 2, ""] as const);
  return { index, name: entry[0], length: entry[1], args: entry[2] };
});

function element(index: number, score: number, bonus = 0, flags = 0, effect = 0, counter = -1) {
  return {
    index,
    flags,
    score,
    bonus,
    effect,
    countdown: -1,
    lampStart: false,
    lampAward: false,
    soundStart: false,
    soundAward: false,
    displayStart: -1,
    displayAward: -1,
    counter,
  };
}

/**
 * Two elements, four scripts:
 *   0  the MISSION: complete the arm shot, light element 0, wait 10s on it,
 *      light element 1, wait 10s on it, clear the arm shot, END
 *   1  the LAUNCHER: MODE_START 0
 *   2  a SHOT: AWARD element 0
 *   3  the ARM shot: START element 2 (the arm element)
 */
function fixtureDocument(): TableModesDocument {
  return {
    schema: "pinball-illusions/table-modes/v1",
    tableId: "law-n-justice",
    displayName: "fixture",
    provenance: { sourceClass: "disk-derived-mode-scripts", description: "test", authorizationRequired: true },
    opcodes: OPCODES,
    elements: [element(0, 5000), element(1, 25000, 7000), element(2, 0)],
    messages: [],
    scripts: [
      {
        index: 0,
        ops: [
          { pc: 0, op: 3, args: [2] },
          { pc: 6, op: 1, args: [0] },
          { pc: 12, op: 28, args: [0, 10, 40] },
          { pc: 22, op: 1, args: [1] },
          { pc: 28, op: 28, args: [1, 10, 40] },
          { pc: 38, op: 0, args: [] },
          { pc: 40, op: 12, args: [2] },
          { pc: 46, op: 0, args: [] },
        ],
      },
      { index: 1, ops: [{ pc: 0, op: 9, args: [0] }, { pc: 6, op: 0, args: [] }] },
      { index: 2, ops: [{ pc: 0, op: 5, args: [0] }, { pc: 6, op: 0, args: [] }] },
      { index: 3, ops: [{ pc: 0, op: 1, args: [2] }, { pc: 6, op: 0, args: [] }] },
      { index: 4, ops: [{ pc: 0, op: 27, args: [3] }, { pc: 6, op: 0, args: [] }] },
      { index: 5, ops: [{ pc: 0, op: 27, args: [4] }, { pc: 6, op: 0, args: [] }] },
    ],
    missions: [{ id: 1, selector: 0, selected: true, script: 0, launcher: 1, lamp: true, title: "FIXTURE" }],
    triggers: { devices: [{ level: 0, surfaceId: 32, script: 3 }], zones: [], locks: [] },
  } as unknown as TableModesDocument;
}

function fixture(): TableModes {
  return parseTableModesDocument(fixtureDocument());
}

/**
 * The same table with three flagged elements bolted on, for the resets.
 *
 *   3  flags $02 — lit at game start (per-game +0x004052, per-ball +0x003FB0)
 *   4  flags $01 — ARMED survives a ball (+0x003FA4)
 *   5  flags $20 — DONE survives a ball (+0x003F9A)
 */
function resetFixture(): TableModes {
  const doc = fixtureDocument() as unknown as Record<string, unknown>;
  doc["elements"] = [
    ...(doc["elements"] as unknown[]),
    element(3, 100, 0, 0x02),
    element(4, 100, 0, 0x01),
    element(5, 100, 0, 0x20),
  ];
  return parseTableModesDocument(doc as unknown as TableModesDocument);
}

/**
 * The same table with TWO PROGRESS COUNTERS and four elements that step them.
 *
 * Counter 0 is the shape of Law 'n Justice's counter 14: a reset value of one,
 * a cap of three and a continuation. Counter 1 is the shape of its COMBO record:
 * flags $08 (bit 3 — the ball-start walk at +0x004158 branches past the reset),
 * uncapped, with a packed-BCD step of 1,000,000.
 *
 * Elements 3 and 4 both name counter 0, which is the point of the fixture: the
 * count belongs to the RECORD, so two different shots step one word.
 */
function counterFixture(): TableModes {
  const doc = fixtureDocument() as unknown as Record<string, unknown>;
  doc["counters"] = [
    { index: 0, flags: 0, reset: 1, cap: 3, step: 0, continuation: 2, ladder: -1, keepAcrossBall: false },
    { index: 1, flags: 0x08, reset: 0, cap: 0, step: 1_000_000, continuation: -1, ladder: -1, keepAcrossBall: true },
  ];
  doc["elements"] = [
    ...(doc["elements"] as unknown[]),
    element(3, 100, 0, 0, 21, 0),
    element(4, 100, 0, 0, 21, 0),
    element(5, 100, 0, 0, 16, 1),
    element(6, 100, 0, 0, 24, 0),
  ];
  doc["scripts"] = [
    ...(doc["scripts"] as unknown[]),
    { index: 6, ops: [{ pc: 0, op: 5, args: [3] }, { pc: 6, op: 0, args: [] }] },
    { index: 7, ops: [{ pc: 0, op: 5, args: [4] }, { pc: 6, op: 0, args: [] }] },
    { index: 8, ops: [{ pc: 0, op: 5, args: [5] }, { pc: 6, op: 0, args: [] }] },
    { index: 9, ops: [{ pc: 0, op: 5, args: [6] }, { pc: 6, op: 0, args: [] }] },
  ];
  return parseTableModesDocument(doc as unknown as TableModesDocument);
}

/** Arms `element`, fires the one-op script that AWARDs it, and lets it run. */
function fireShot(modes: TableModes, state: ModeState, element: number, script: number): void {
  state.armed[element] = 1;
  state.done[element] = 0;
  queueScript(state, script);
  run(modes, state, 8);
}

/** Runs `ticks` frames and returns everything that happened, flattened. */
function run(modes: TableModes, state: ModeState, ticks: number) {
  const awards: { element: number; score: number; bonus: number }[] = [];
  let started = 0;
  let ended = 0;
  let ballsUpTo = 0;
  for (let i = 0; i < ticks; i += 1) {
    const report = tickModes(modes, state);
    awards.push(...report.awards);
    if (report.missionStarted >= 0) started += 1;
    if (report.missionEnded) ended += 1;
    ballsUpTo = Math.max(ballsUpTo, report.ballsUpTo);
  }
  return { awards, started, ended, ballsUpTo };
}

/** A digest of everything mutable, for the determinism check. */
function digest(state: ModeState): string {
  return JSON.stringify({
    armed: [...state.armed],
    done: [...state.done],
    timers: [...state.timers],
    counterCounts: [...state.counterCounts],
    counterTotals: [...state.counterTotals],
    queue: [...state.queue],
    queueRead: state.queueRead,
    queueWrite: state.queueWrite,
    background: state.background,
    backgroundPc: state.backgroundPc,
    mission: state.mission,
    missionPc: state.missionPc,
    suspended: state.suspended,
    waitElement: state.waitElement,
    waitTicks: state.waitTicks,
    cursor: state.selectorCursor,
    played: [...state.played],
  });
}

// ---------------------------------------------------------------------------

describe("the background queue", () => {
  it("runs one opcode per frame, which is what makes a bank of targets ripple", () => {
    const modes = fixture();
    const state = createModeState(modes);
    queueScript(state, 3); // START element 2, then END: two instructions.

    // Frame one runs the START and nothing else; the arm element is lit at once.
    tickModes(modes, state);
    expect(litElements(state)).toEqual([2]);
    expect(state.background).toBe(3);
    // Frame two reaches the END and lets the record go.
    tickModes(modes, state);
    expect(state.background).toBe(-1);
  });

  it("wraps at sixty-four slots rather than growing, as `andi.w #$3f` does", () => {
    const modes = fixture();
    const state = createModeState(modes);
    for (let i = 0; i < MODE_QUEUE_SLOTS + 5; i += 1) queueScript(state, 2);
    expect(state.queue.length).toBe(MODE_QUEUE_SLOTS);
    expect(state.queueWrite).toBe(5);
  });

  it("ignores a request to queue nothing", () => {
    const modes = fixture();
    const state = createModeState(modes);
    queueScript(state, -1);
    expect(state.queueWrite).toBe(0);
  });
});

describe("the MUSIC opcode", () => {
  /**
   * Opcode 19 is the MUSIC command post — handler main.seg00 $5B3E, two
   * instructions into the mailbox poster $6868 — and this port reports the
   * SITE it executed, `{script, pc}` into the modes document, for the audio
   * layer to resolve through the music manifest. It carries no sound and no
   * state: a report field, like `messagesShown`.
   */
  function musicFixture(): TableModes {
    const doc = fixtureDocument() as unknown as Record<string, unknown>;
    const scripts = [...(doc["scripts"] as Record<string, unknown>[])];
    scripts.push({
      index: scripts.length,
      ops: [
        { pc: 0, op: 19, args: [-1] },
        { pc: 6, op: 1, args: [0] },
        { pc: 12, op: 19, args: [-1] },
        { pc: 18, op: 0, args: [] },
      ],
    });
    doc["scripts"] = scripts;
    return parseTableModesDocument(doc as unknown as TableModesDocument);
  }

  it("reports the script and pc of every opcode-19 it runs, in order", () => {
    const modes = musicFixture();
    const state = createModeState(modes);
    const site = modes.scripts.length - 1;
    queueScript(state, site);
    const seen: { script: number; pc: number }[] = [];
    for (let tick = 0; tick < 8; tick += 1) {
      for (const cue of tickModes(modes, state).musicCues) seen.push({ ...cue });
    }
    expect(seen).toEqual([
      { script: site, pc: 0 },
      { script: site, pc: 12 },
    ]);
  });

  it("is no longer counted as an opcode nobody has decoded", () => {
    const modes = musicFixture();
    const state = createModeState(modes);
    queueScript(state, modes.scripts.length - 1);
    let unimplemented = 0;
    for (let tick = 0; tick < 8; tick += 1) unimplemented += tickModes(modes, state).unimplemented;
    expect(unimplemented).toBe(0);
  });

  it("a tick with no music opcode carries no cues at all", () => {
    const modes = musicFixture();
    const state = createModeState(modes);
    queueScript(state, 3); // START element 2, then END.
    for (let tick = 0; tick < 4; tick += 1) {
      expect(tickModes(modes, state).musicCues).toEqual([]);
    }
  });
});

describe("the display-queue feed", () => {
  it("reports STARTed element indices and shown message records by index", () => {
    // The panel layer queues animations off these indices — the element's +$14
    // record on START and the message record's own list — so the report has to
    // carry the INDEX, not just the arming and the flattened text.
    const raw = fixtureDocument() as unknown as Record<string, unknown>;
    raw["messages"] = [{ lines: ["READY"] }];
    (raw["elements"] as { displayStart: number }[])[2]!.displayStart = 0;
    const modes = parseTableModesDocument(raw as unknown as TableModesDocument);
    const state = createModeState(modes);

    queueScript(state, 3); // START element 2, whose displayStart is message 0.
    const report = tickModes(modes, state);
    expect(report.elementStarts).toEqual([2]);
    expect(report.messagesShown).toEqual([0]);
    expect(report.messages).toEqual(["READY"]);
  });

  it("reports nothing on a tick that starts and shows nothing", () => {
    const modes = fixture();
    const state = createModeState(modes);
    const report = tickModes(modes, state);
    expect(report.elementStarts).toEqual([]);
    expect(report.messagesShown).toEqual([]);
  });
});

describe("arming and awarding", () => {
  it("pays an element's packed-BCD score and bonus once, and puts the shot out", () => {
    const modes = fixture();
    const state = createModeState(modes);
    state.armed[1] = 1;
    queueScript(state, 2); // AWARD element 0 — not armed, so nothing.
    const first = run(modes, state, 4);
    expect(first.awards).toEqual([]);

    state.armed[0] = 1;
    queueScript(state, 2);
    const second = run(modes, state, 4);
    expect(second.awards).toEqual([{ element: 0, score: 5000, bonus: 0, effect: 0 }]);
    expect(state.armed[0]).toBe(0);

    // A second award with the bit already clear pays nothing: the handler's
    // `bclr` skips when the bit was not set, which is what stops a ball rattling
    // across one target from paying twice.
    queueScript(state, 2);
    expect(run(modes, state, 4).awards).toEqual([]);
  });

  it("refuses to pay a shot the player has already finished", () => {
    const modes = fixture();
    const state = createModeState(modes);
    state.done[0] = 1;
    state.armed[0] = 1;
    queueScript(state, 2);
    expect(run(modes, state, 4).awards).toEqual([]);
  });
});

describe("a mission", () => {
  it("starts, waits for its shots, pays them and ends", () => {
    const modes = fixture();
    const state = createModeState(modes);
    queueScript(state, 1); // the launcher

    run(modes, state, 2);
    expect(missionRunning(state)).toBe(true);
    // COMPLETE arm, START element 0, WAIT: three mission frames.
    run(modes, state, 3);
    expect(state.armed[0]).toBe(1);
    expect(state.suspended).toBe(true);
    // Nine, not ten: five frames have run — one to dequeue the launcher, one for
    // its END, then COMPLETE, START and the WAIT itself — and the frame after the
    // WAIT has already taken a tick off the clock.
    expect(missionSecondsLeft(state)).toBe(9);

    // The shot. Two frames for the bound script, one for the wait to notice.
    queueScript(state, 2);
    const shot = run(modes, state, 4);
    expect(shot.awards.map((award) => award.element)).toEqual([0]);
    expect(state.armed[1]).toBe(1);

    // Time out the second wait and run off the end of the timeout branch.
    const timeout = run(modes, state, 10 * TICKS_PER_SECOND + 6);
    expect(timeout.ended).toBe(1);
    expect(missionRunning(state)).toBe(false);
    expect(state.done[2]).toBe(0);
  });

  it("branches to the timeout PC when the clock beats the shot", () => {
    const modes = fixture();
    const state = createModeState(modes);
    queueScript(state, 1);
    run(modes, state, 5);
    expect(state.suspended).toBe(true);

    // Nothing awards element 0, so the wait must expire and jump to +40, which
    // is CLEAR_DONE followed by END.
    const out = run(modes, state, 10 * TICKS_PER_SECOND + 4);
    expect(out.ended).toBe(1);
    expect(out.awards).toEqual([]);
  });

  it("refuses to start a second while one is running", () => {
    const modes = fixture();
    const state = createModeState(modes);
    queueScript(state, 1);
    run(modes, state, 2);
    const first = state.mission;
    expect(first).toBeGreaterThanOrEqual(0);

    queueScript(state, 1);
    run(modes, state, 4);
    expect(state.mission).toBe(first);
  });

  it("goes away with the ball, and takes the queue with it", () => {
    const modes = fixture();
    const state = createModeState(modes);
    queueScript(state, 1);
    run(modes, state, 4);
    expect(missionRunning(state)).toBe(true);
    state.done[0] = 1;

    resetModesForNewBall(modes, state);
    expect(missionRunning(state)).toBe(false);
    expect(litElements(state)).toEqual([]);
    expect(state.queueRead).toBe(0);
    expect(state.queueWrite).toBe(0);
    // DECODED, +0x003F9A: the DONE bit is CLEARED by the per-ball reset unless
    // the element's flags carry bit 5. Element 0's flags are 0, so it clears.
    // The old assertion here — "DONE bits are per player and per GAME and must
    // survive the ball" — was a reconstruction and the disassembly overturns it.
    expect(state.done[0]).toBe(0);
  });
});

describe("the per-ball reset, decoded from +0x003F80", () => {
  it("clears DONE by default and keeps it for a flags bit-5 element", () => {
    const modes = resetFixture();
    const state = createModeState(modes);
    state.done[0] = 1;
    state.done[5] = 1;

    resetModesForNewBall(modes, state);

    expect(modes.keepDoneAcrossBall).toEqual([5]);
    expect(state.done[0]).toBe(0);
    expect(state.done[5]).toBe(1);
  });

  it("clears ARMED by default and keeps it for a flags bit-0 element", () => {
    const modes = resetFixture();
    const state = createModeState(modes);
    state.armed[0] = 1;
    state.armed[4] = 1;

    resetModesForNewBall(modes, state);

    expect(modes.keepArmedAcrossBall).toEqual([4]);
    expect(state.armed[0]).toBe(0);
    expect(state.armed[4]).toBe(1);
  });

  it("re-arms every flags bit-1 element, on a new game and on a new ball", () => {
    const modes = resetFixture();
    expect(modes.litAtGameStart).toEqual([3]);

    const state = createModeState(modes);
    expect(state.armed[3]).toBe(1);

    state.armed[3] = 0;
    resetModesForNewBall(modes, state);
    expect(state.armed[3]).toBe(1);
  });
});

describe("the opcode corrections that a permanently lit shot forces", () => {
  /** Runs one script from the reset fixture and returns the state it left. */
  function runScript(ops: readonly { pc: number; op: number; args: number[] }[]) {
    const doc = fixtureDocument() as unknown as Record<string, unknown>;
    doc["elements"] = [
      ...(doc["elements"] as unknown[]),
      element(3, 100, 0, 0x02),
      element(4, 100, 0, 0x01),
      element(5, 100, 0, 0x20),
    ];
    (doc["scripts"] as unknown[]).push({ index: 6, ops });
    const modes = parseTableModesDocument(doc as unknown as TableModesDocument);
    const state = createModeState(modes);
    queueScript(state, 6);
    run(modes, state, ops.length + 2);
    return state;
  }

  it("LAMP_OFF refuses a bit-1 element and disarms an ordinary one", () => {
    // main.seg00 +0x005A10. Without this, one LAMP_OFF anywhere in a script
    // would put an always-lit shot out for the rest of the game.
    const state = runScript([
      { pc: 0, op: 1, args: [0] },
      { pc: 6, op: 14, args: [0] },
      { pc: 12, op: 14, args: [3] },
      { pc: 18, op: 0, args: [] },
    ]);
    expect(state.armed[0]).toBe(0);
    expect(state.armed[3]).toBe(1);
  });

  it("START on an already-armed or DONE element is a complete no-op", () => {
    // main.seg00 +0x005A36 is `bset.b d6,$1(a2) / bne`, so the handler leaves on
    // the OLD bit: no timer rewrite, no re-blink.
    const state = runScript([
      { pc: 0, op: 2, args: [0, 5] },
      { pc: 8, op: 2, args: [0, 9] },
      { pc: 16, op: 0, args: [] },
    ]);
    expect(state.armed[0]).toBe(1);
    // Still the FIRST start's five seconds, four ticks down — not the nine the
    // second START asked for. A handler that rewrote the timer would read 450.
    expect(state.timers[0]).toBe(5 * TICKS_PER_SECOND - 4);
  });

  it("JMP_IF_UNLIT jumps on DONE, not only on unarmed", () => {
    // main.seg00 +0x005C90: the branch is `done OR not armed`. Element 0 is
    // armed AND done here, which the old `armed === 0 && done === 0` reading
    // fell straight through.
    const doc = fixtureDocument() as unknown as Record<string, unknown>;
    (doc["scripts"] as unknown[]).push({
      index: 6,
      ops: [
        { pc: 0, op: 23, args: [0, 14] },
        { pc: 8, op: 5, args: [1] },
        { pc: 14, op: 0, args: [] },
      ],
    });
    const modes = parseTableModesDocument(doc as unknown as TableModesDocument);
    const state = createModeState(modes);
    state.armed[0] = 1;
    state.done[0] = 1;
    queueScript(state, 6);
    const { awards } = run(modes, state, 6);
    expect(awards, "the branch was taken, so element 1 was never awarded").toEqual([]);
  });

  it("COMPLETE leaves a bit-1 element armed", () => {
    // main.seg00 +0x005B88: DONE is set, but the `bclr` at +0x005B9C is skipped
    // for a bit-1 element.
    const state = runScript([
      { pc: 0, op: 3, args: [3] },
      { pc: 6, op: 0, args: [] },
    ]);
    expect(state.done[3]).toBe(1);
    expect(state.armed[3]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The progress counters
// ---------------------------------------------------------------------------

describe("a progress counter, keyed by RECORD and not by element", () => {
  it("gives every element that names one record the same count", () => {
    // The correction: `movea.l $34(a2),a0 / move.w $6(a0,d6.w*2),d0` reaches ONE
    // word whichever element got there. Keyed per element, two shots on one
    // record would leave two counts of one and neither would reach a cap.
    const modes = counterFixture();
    const state = createModeState(modes);
    expect(state.counterCounts[0], "the game-start walk writes +$02").toBe(1);

    fireShot(modes, state, 3, 6);
    fireShot(modes, state, 4, 7);
    expect(state.counterCounts[0]).toBe(3);
    expect(state.counterTotals[0]).toBe(3);
  });

  it("fires its continuation ONCE, on the award that reaches the cap", () => {
    // `+0x005FB8`: an award that finds the count already at the cap returns
    // without touching anything, so the +$48 script cannot run twice. The old
    // per-element reading zeroed the count and re-fired every `max(1, cap)`.
    const modes = counterFixture();
    const state = createModeState(modes);
    // Script 2 is the continuation and it AWARDs element 0, so the report says
    // when it ran. Element 0 stays armed the whole time.
    let fired = 0;
    for (let i = 0; i < 6; i += 1) {
      state.armed[0] = 1;
      state.done[0] = 0;
      state.armed[3] = 1;
      state.done[3] = 0;
      queueScript(state, 6);
      fired += run(modes, state, 16).awards.filter((award) => award.element === 0).length;
    }
    expect(state.counterCounts[0], "the count sticks at the cap").toBe(3);
    expect(fired, "the continuation ran more than once").toBe(1);
  });

  it("never fires a continuation on an UNCAPPED record, however far it counts", () => {
    // `tst.w d2 / beq` at +0x005E76 and +0x005FC4: a cap of zero skips the
    // continuation entirely. Every counter in the corpus but two is uncapped,
    // so the old `Math.max(1, target)` reading fired on EVERY award.
    const modes = counterFixture();
    const state = createModeState(modes);
    for (let i = 0; i < 20; i += 1) fireShot(modes, state, 5, 8);
    expect(state.counterCounts[1]).toBe(20);
  });

  it("steps back on effect 24, and never below zero", () => {
    const modes = counterFixture();
    const state = createModeState(modes);
    fireShot(modes, state, 3, 6); // count 1 -> 2
    fireShot(modes, state, 6, 9); // -> 1
    fireShot(modes, state, 6, 9); // -> 0
    fireShot(modes, state, 6, 9); // `tst.w / beq` holds it there
    expect(state.counterCounts[0]).toBe(0);
    expect(state.counterTotals[0]).toBe(0);
  });

  it("resets with the ball unless the record says otherwise", () => {
    // `+0x00412C` writes +$02 into both words unless flags bit 0 or bit 3 is
    // set. Counter 0 is plain; counter 1 carries bit 3.
    const modes = counterFixture();
    const state = createModeState(modes);
    fireShot(modes, state, 3, 6);
    fireShot(modes, state, 5, 8);
    expect(state.counterCounts[0]).toBe(2);
    expect(state.counterCounts[1]).toBe(1);

    resetModesForNewBall(modes, state);
    expect(state.counterCounts[0], "a plain counter goes back to its reset value").toBe(1);
    expect(state.counterCounts[1], "a bit-3 counter survives the drain").toBe(1);
  });
});

describe("the wait machinery", () => {
  it("holds a WAIT with a clock and no shot for the whole clock", () => {
    // The intro pause every mission opens with is `WAIT NULL, 3, <pc>`: three
    // seconds with nothing to watch. Falling through it immediately would run a
    // mission's whole prologue in a handful of frames, which is how the wait
    // machinery was wrong on its first pass.
    const modes = fixture();
    const state = createModeState(modes);
    state.mission = 0;
    state.suspended = true;
    state.waitElement = -1;
    state.waitTicks = 3 * TICKS_PER_SECOND;
    state.waitTimeoutPc = 40;
    run(modes, state, 3 * TICKS_PER_SECOND - 1);
    expect(state.suspended).toBe(true);
    run(modes, state, 1);
    expect(state.suspended).toBe(false);
    expect(state.missionPc).toBe(40);
  });

  it("lets a shot end a TIMED wait early, which is the whole game", () => {
    // The first version tested the clock and returned, so a shot made while the
    // clock was running did nothing and every timed stage ran to its timeout.
    // Both tests happen every frame.
    const modes = fixture();
    const state = createModeState(modes);
    state.mission = 0;
    state.armed[0] = 1;
    state.suspended = true;
    state.waitElement = 0;
    state.waitTicks = 10 * TICKS_PER_SECOND;
    state.waitTimeoutPc = 40;
    state.missionPc = 22;

    run(modes, state, 5);
    expect(state.suspended).toBe(true);
    queueScript(state, 2); // AWARD element 0
    // Frame one runs the AWARD in the background; frame two is the one the wait
    // notices on, and it falls through to +22 rather than to the timeout at +40.
    run(modes, state, 2);
    expect(state.armed[1]).toBe(1);
    expect(state.waitTicks).toBeGreaterThan(0);
  });

});

describe("the multiball opcode", () => {
  it("asks for up to three balls", () => {
    const modes = fixture();
    const state = createModeState(modes);
    queueScript(state, 4); // BALLS_UP_TO 3
    expect(run(modes, state, 3).ballsUpTo).toBe(MODE_MAX_BALLS);
  });

  it("refuses a request for four outright, as `cmpi.w #$3,d1 / bhi` does", () => {
    const modes = fixture();
    const state = createModeState(modes);
    queueScript(state, 5); // BALLS_UP_TO 4
    expect(run(modes, state, 3).ballsUpTo).toBe(0);
  });
});

describe("the selector reconstruction", () => {
  it("walks the selector in order and does not repeat until it has run out", () => {
    const modes = modesFor("law-n-justice");
    const state = createModeState(modes);
    const seen: number[] = [];
    for (let i = 0; i < modes.selectable.length; i += 1) {
      const started = startSelectedMission(modes, state);
      expect(started).toBeGreaterThanOrEqual(0);
      seen.push(started);
      endMission(state);
    }
    expect(new Set(seen).size).toBe(modes.selectable.length);
    expect(seen).toEqual(modes.selectable);

    // Round the loop again once every mission has been played.
    const again = startSelectedMission(modes, state);
    expect(again).toBe(modes.selectable[0]);
  });

  it("will not start anything while a mission is running", () => {
    const modes = modesFor("law-n-justice");
    const state = createModeState(modes);
    startSelectedMission(modes, state);
    run(modes, state, 2);
    expect(missionRunning(state)).toBe(true);
    expect(startSelectedMission(modes, state)).toBe(-1);
  });
});

describe("on the shipped Law 'n Justice data", () => {
  it("runs a real mission from its launcher and lights the shots it names", () => {
    const modes = modesFor("law-n-justice");
    const state = createModeState(modes);
    const started = startSelectedMission(modes, state);
    expect(started).toBeGreaterThanOrEqual(0);
    const mission = modes.missions[started];
    expect(mission?.selected).toBe(true);

    run(modes, state, 200);
    expect(missionRunning(state)).toBe(true);
    // A mission that has run its prologue is asking for shots.
    expect(litElements(state).length).toBeGreaterThan(0);
    // And it is parked on one of them with a clock.
    expect(state.suspended).toBe(true);
  });

  it("never spins: an unattended mission either ends or parks on an untimed shot", () => {
    // Nothing awards anything here, so each mission has to reach its END through
    // its own timeout branches — OR be sitting on a wait with no clock, which is
    // what an untimed jackpot stage is and what the ball ending is there to
    // resolve. What must NOT happen is a mission still executing instructions
    // after ten minutes of frames, because that is a loop with no exit.
    const modes = modesFor("law-n-justice");
    let parked = 0;
    for (const at of modes.selectable) {
      const state = createModeState(modes);
      state.mission = modes.missions[at]?.script ?? -1;
      state.missionIndex = at;
      run(modes, state, 30_000);
      if (!missionRunning(state)) continue;
      parked += 1;
      expect(state.suspended, `mission ${at} is still running instructions`).toBe(true);
      expect(state.waitTicks, `mission ${at} is parked but its clock is running`).toBe(0);
      expect(state.waitElement, `mission ${at} is parked on nothing`).toBeGreaterThanOrEqual(0);
    }
    // Most of them do end on their own; if they ALL parked, the timeout branches
    // would not be working and this test would be asserting nothing.
    expect(parked).toBeLessThan(modes.selectable.length);
  });

  it("counts a COMBO on each of the six shots the bonus routine pays for", () => {
    // The decode this pins: the end-of-ball bonus reads `+$06 + 2p` of the
    // counter record at h4+0x454A (h4+0x2A62 -> h4+0x4550), and the six shots
    // that step it are the three upper-deck rollovers, the right-hand lower
    // rollover and the two jail saucers. The bindings are taken from the shipped
    // trigger tables rather than written down, so a re-export that moved a shot
    // fails here rather than quietly counting a different one.
    const modes = modesFor("law-n-justice");
    const combo = modes.comboCounter;
    expect(combo, "law-n-justice must carry a combo counter").toBeGreaterThanOrEqual(0);

    const shots = [
      modes.scriptForZone(1, 7),
      modes.scriptForZone(1, 8),
      modes.scriptForZone(1, 9),
      modes.scriptForZone(0, 13),
      modes.scriptForLock(0, 5),
      modes.scriptForLock(0, 7),
    ];
    for (const script of shots) expect(script, "a combo shot lost its binding").toBeGreaterThanOrEqual(0);

    const state = createModeState(modes);
    expect(comboCount(modes, state)).toBe(0);
    for (const script of shots) {
      // The element this shot's own script AWARDs into the combo counter. Each
      // script awards a dozen other things too; only one of them is a combo.
      const own = (modes.scripts[script]?.ops ?? [])
        .filter((op) => op.op === 5)
        .map((op) => op.args[0] ?? -1)
        .filter((index) => modes.elements[index]?.counter === combo && modes.elements[index]?.effect === 16);
      expect(own.length, `script ${script} awards ${own.length} combo elements`).toBe(1);
      const element = own[0] ?? -1;
      // A combo shot only counts while it is LIT, which is what the previous
      // shot in the chain does with its 5- or 10-second START_TIMED.
      state.armed[element] = 1;
      state.done[element] = 0;
      queueScript(state, script);
      run(modes, state, 200);
    }
    expect(comboCount(modes, state), "six lit combo shots, six combos").toBe(6);

    // And an UNLIT one pays nothing: AWARD's `bclr` refusal at +0x005CB2 is what
    // makes the chain a chain rather than six independent shots. Every combo
    // element goes dark first, because the six scripts spend their lives arming
    // each other and several are still lit at this point — and only ONE cold
    // shot is fired, since firing a second would be shooting a lamp the first
    // had just lit, which is the chain working rather than a bug.
    for (const element of modes.elements) {
      if (element.counter !== combo) continue;
      state.armed[element.index] = 0;
      state.timers[element.index] = 0;
    }
    queueScript(state, shots[0] ?? -1);
    run(modes, state, 200);
    expect(comboCount(modes, state), "an unlit combo shot counted").toBe(6);
  });

  it("is deterministic: the same frames from the same start give the same state", () => {
    const modes = modesFor("law-n-justice");
    const a = createModeState(modes);
    const b = createModeState(modes);
    for (const state of [a, b]) {
      startSelectedMission(modes, state);
      for (let i = 0; i < 900; i += 1) {
        if (i % 137 === 0) queueScript(state, i % modes.scripts.length);
        tickModes(modes, state);
      }
    }
    expect(digest(a)).toBe(digest(b));
  });
});

// ---------------------------------------------------------------------------
// On the assembled machine
// ---------------------------------------------------------------------------

describe("the missions, wired into a real game", () => {
  /**
   * Every shot on Law 'n Justice that can start a mission, straight off the
   * disk: the zones whose script reaches an element in `modes.armElements`.
   *
   * There are exactly three — the two right-inlane rollovers L0#10 and L0#11,
   * each bound to a `START_TIMED(13,5)`, and the upper-level box L1#9, whose
   * script contains `START(10)`. L0#8, L0#9 and L0#12 bind to scripts that are
   * a bare `END` and cannot start anything.
   */
  function armingZones(): readonly { level: 0 | 1; index: number }[] {
    const modes = modesFor("law-n-justice");
    const armed = new Set(modes.armElements);
    const found: { level: 0 | 1; index: number }[] = [];
    for (const zone of devicesFor("law-n-justice").zones) {
      const index = modes.scriptForZone(zone.level, zone.index);
      const script = index < 0 ? undefined : modes.scripts[index];
      if (script === undefined) continue;
      // START (1) and START_TIMED (2) are the two opcodes that put an element on
      // the machine; an arm element is one every mission COMPLETEs and
      // CLEAR_DONEs, which is what `armElements` derives.
      const starts = script.ops.some(
        (op) =>
          (op.op === 1 || op.op === 2) && op.args[0] !== undefined && armed.has(op.args[0] as number),
      );
      if (starts) found.push({ level: zone.level, index: zone.index });
    }
    return found;
  }

  it("start from EVERY shot on the disk that arms one, one shot at a time", () => {
    // THE MECHANISM TEST, and it replaces a blind-cadence one that was really a
    // coin flip. Round 5 found the old single 23/29 player no longer reaching a
    // mission and widened the test to "any of four cadences". Measured on three
    // fully-specified grids (Law 'n Justice, 3 balls, 20,000 ticks each, every
    // ordered pair of bat cadences from the set, diagonal excluded):
    //
    //   {17,19,23,29,31,37}                        HEAD 18/30    now 15/30
    //   {13,17,19,21,23,25,27,29,31,33,35,37}      HEAD 60/132   now 61/132
    //   {17,19,23,29,31,37,41,43,47,53,59,61}      HEAD 53/132   now 43/132
    //
    // Note what those three disagree about: whether the rate went DOWN at all
    // depends on which cadences you happen to pick — flat on the second grid,
    // down a fifth on the third. That is the whole argument. A randomly chosen
    // cadence is close to a coin flip on either tree, "at least one of four"
    // passes by luck most of the time WHATEVER the physics does, and a quantity
    // whose sign is set by the choice of probe cannot pin a regression.
    //
    // So the end-to-end claim is split in two. This half is deterministic and
    // names every shot: the ball is pinned inside each arming rectangle in turn
    // — the pattern `scoring-play.test.ts` uses for the lock award — and each
    // must pay its zone and put a mission on the machine. It is strictly
    // stronger than the cadence pin it replaces, which could only ever have
    // exercised whichever one shot that cadence happened to find.
    const zones = armingZones();
    expect(zones.length, "the disk's arming shots").toBe(3);
    expect(zones).toEqual([
      { level: 0, index: 10 },
      { level: 0, index: 11 },
      { level: 1, index: 9 },
    ]);

    const devices = devicesFor("law-n-justice");
    for (const where of zones) {
      const zone = devices.zones.find(
        (one) => one.level === where.level && one.index === where.index,
      );
      expect(zone, `zone ${where.level}-${where.index} is in the shipped list`).toBeDefined();
      if (zone === undefined) continue;

      const game = createGame(mapFor("law-n-justice"), { ballsPerGame: 3 });
      startGame(game);
      runTicks(game, { sample: () => IDLE_SNAPSHOT }, 60);
      const ball = game.balls.balls[0];
      expect(ball).toBeDefined();
      if (ball === undefined) continue;
      // Off the rod first, or the loop pins it back to the serve point.
      game.laneBallId = null;
      ball.x = pixelsToQ10(Math.floor((zone.minX + zone.maxX) / 2));
      ball.y = pixelsToQ10(Math.floor((zone.minY + zone.maxY) / 2));
      ball.velocityX = 0;
      ball.velocityY = 0;
      ball.level = where.level;

      // Long enough for the longest of the three scripts to reach its start:
      // L1#9's script 56 runs eleven ops before its `START(10)`.
      const paid: number[] = [];
      for (let tick = 0; tick < 40; tick += 1) {
        const report = runTicks(game, { sample: () => IDLE_SNAPSHOT }, 1)[0];
        for (const award of report?.awards ?? []) paid.push(award.score);
      }
      expect(paid, `zone ${where.level}-${where.index} paid nothing`).toContain(zone.score);
      const mission = runningMission(game);
      expect(mission, `zone ${where.level}-${where.index} started no mission`).not.toBeNull();
      expect(mission?.title.length, `mission from ${where.level}-${where.index} is nameless`)
        .toBeGreaterThan(0);
    }
  });

  it("are reached by blind play often enough to be part of the game", () => {
    // THE RATE HALF, stated as a rate with its budget the way this project
    // states a census. BUDGET: Law 'n Justice, 30 blind players — every ordered
    // pair of bat cadences from {17, 19, 23, 29, 31, 37} except the diagonal —
    // 3 balls each, 20,000 ticks each. MEASURED: HEAD 18 of 30, this tree 15 of
    // 30 — but see the three grids quoted on the test above, which disagree
    // about the sign of that change. This number carries cadence-choice noise,
    // not just physics.
    //
    // What physics it does carry is priced in rather than a defect: round 6
    // halved every coil constant after finding the responder works at twice the
    // ball's velocity scale, and the four filmed slingshot junctions went from
    // 4.23 to 0.25 px/f RMS against the original. Where the machine got harder
    // it got harder because the original IS harder, and census medians moved the
    // same way for the same reason.
    //
    // The floor is two thirds of the measured 15, so it tolerates that noise but
    // catches any further third lost — and it goes to zero the moment one of the
    // three arming shots stops firing, which is the regression it exists to
    // catch.
    const cadences = [17, 19, 23, 29, 31, 37];
    const modeAwards: number[] = [];
    let players = 0;
    let cells = 0;
    const titles = new Set<string>();
    for (const left of cadences) {
      for (const right of cadences) {
        if (left === right) continue;
        cells += 1;
        const game = createGame(mapFor("law-n-justice"), { ballsPerGame: 3 });
        startGame(game);
        let started = false;
        for (let tick = 0; tick < 20_000; tick += 1) {
          const before = game.modeState === null ? -1 : game.modeState.mission;
          const report = runTicks(game, playingInput(tick, left, right), 1)[0];
          if (report === undefined) break;
          for (const award of report.awards) {
            if (award.source === "mode") modeAwards.push(award.score);
          }
          const mission = runningMission(game);
          if (mission !== null && before < 0) {
            started = true;
            if (mission.title.length > 0) titles.add(mission.title);
          }
        }
        if (started) players += 1;
      }
    }
    expect(cells).toBe(30);
    expect(players, `only ${players} of ${cells} blind players reached a mission`)
      .toBeGreaterThanOrEqual(10);
    expect(titles.size, "no mission announced itself to any player").toBeGreaterThan(0);
    // Every value paid is an element score off the disks, checked the same way
    // `scoring-play.test.ts` checks the device layer.
    const permitted = new Set(modesFor("law-n-justice").elements.map((element) => element.score));
    for (const score of modeAwards) expect(permitted.has(score)).toBe(true);
  });

  it("take the mission away with the ball, and start a fresh machine on a new game", () => {
    const game = createGame(mapFor("law-n-justice"), { ballsPerGame: 3 });
    startGame(game);
    const state = game.modeState;
    expect(state).not.toBeNull();
    if (state === null) return;

    startSelectedMission(modesFor("law-n-justice"), state);
    runTicks(game, { sample: () => IDLE_SNAPSHOT }, 5);
    // Force the end of the ball the way a drain does.
    resetModesForNewBall(modesFor("law-n-justice"), state);
    expect(runningMission(game)).toBeNull();

    state.done[0] = 1;
    startGame(game);
    expect(game.modeState?.done[0]).toBe(0);
  });
});

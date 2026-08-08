/**
 * AWARD EFFECT 26 — BabeWatch's casino wheel, and the last award effect in the
 * corpus that had no handler.
 *
 * THE HANDLER, main.seg00 +0x006102, in full:
 *
 *     006102  move.w  $C8AC.l,d0     ; the VBlank frame counter
 *     006108  movea.l $34(a2),a0     ; the element's prize table
 *     00610C  andi.w  #$FF,d0        ; a roll in 0..255
 *     006110  cmp.w   $2(a0),d0
 *     006114  bcs.b   $611C          ; roll BELOW this threshold -> it wins
 *     006116  adda.w  #$8,a0
 *     00611A  bra.b   $6110
 *     00612E  movea.l $4(a0),a0
 *     006132  jsr     $6C10          ; queued, exactly as effect 17 queues
 *
 * IT WAS ALWAYS REACHABLE, and the round that called it unreachable said so
 * with a census that could not read `chainScript` — a field the same HEAD had
 * already shipped. The chain, every link in the shipped document and asserted
 * below: lower lock 16 -> s53 -> `START e65`; e65 is award effect 17 with
 * `chainScript = 153`; upper lock 8 -> s57, which awards e65 if its lamp is lit
 * and otherwise shows "THE CASINO IS CLOSED"; s153 -> `MODE_START 154`; s154
 * says "THE GAME IS ON", waits eight seconds and AWARDs e66; and e66 carries
 * flags 0x02, so it is lit for every player from the first frame. A player has
 * been able to spin this wheel for as long as effect 17 has been shipped, and
 * until now it paid exactly zero.
 */

import { describe, expect, it } from "vitest";
import { createModeState, queueScript, tickModes } from "../src/game/mode-vm.js";
import type { ModeState } from "../src/game/mode-vm.js";
import type { TableModes } from "../src/game/table-modes.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import { modesFor } from "./table-fixtures.js";

/** The one element on the three tables that carries effect 26. */
const WHEEL = 66;
/** s154: MUSIC / MESSAGE "THE GAME IS ON" / WAIT 8 s / AWARD e66 / ... */
const AWARDER = 154;

interface Spin {
  readonly score: number;
  readonly bonus: number;
  readonly extraBallsLit: number;
  readonly holdBonus: boolean;
  readonly prize: number;
}

/**
 * One spin at a given roll, driven the machine's own way: queue s154, which
 * AWARDs the wheel, and let the queued prize script run to the end.
 *
 * `frames` is seeded four short of the wanted roll because `tickModes` bumps it
 * before anything reads it and the queued script reaches its AWARD three ticks
 * later — the same "queue this tick, run next tick" ordering the loop's own
 * comment describes.
 */
function spinAt(modes: TableModes, roll: number): Spin {
  const state: ModeState = createModeState(modes);
  state.frames = roll - 4;
  queueScript(state, AWARDER);
  let score = 0;
  let bonus = 0;
  let extraBallsLit = 0;
  let holdBonus = false;
  let prize = -1;
  for (let tick = 0; tick < 400; tick += 1) {
    const report = tickModes(modes, state);
    for (const award of report.awards) {
      score += award.score;
      bonus += award.bonus;
      if (award.element === WHEEL) {
        const at = state.frames & 0xff;
        prize = modes.elements[WHEEL]!.prizeTable.findIndex((one) => at < one.threshold);
      }
    }
    // Prizes 1 and 7 LIGHT a shot rather than paying it: s160 STARTs e67, the
    // award-effect-1 extra ball, and s166 STARTs e13.
    for (const element of report.elementStarts) {
      if (modes.elements[element]!.effect === 1) extraBallsLit += 1;
    }
    if (report.holdBonus) holdBonus = true;
  }
  return { score, bonus, extraBallsLit, holdBonus, prize };
}

describe("the casino wheel's prize table", () => {
  it("is one element on one table, and the last effect without a handler", () => {
    const carriers: string[] = [];
    for (const tableId of TABLE_IDS) {
      for (const element of modesFor(tableId).elements) {
        if (element.prizeTable.length > 0) carriers.push(`${tableId} e${element.index}`);
        expect(element.prizeTable.length > 0).toBe(element.effect === 26);
      }
    }
    expect(carriers).toEqual(["babewatch e66"]);
  });

  it("is eight entries whose gaps are the odds and whose last threshold is 256", () => {
    const wheel = modesFor("babewatch").elements[WHEEL]!;
    expect(wheel.prizeTable.map((one) => one.threshold)).toEqual([
      25, 60, 105, 111, 146, 186, 231, 256,
    ]);
    expect(wheel.prizeTable.map((one) => one.script)).toEqual([
      159, 160, 161, 162, 163, 164, 165, 166,
    ]);
    // The gaps ARE the weights, and they sum to the roll's own range.
    const gaps = wheel.prizeTable.map((one, at) => one.threshold - (wheel.prizeTable[at - 1]?.threshold ?? 0));
    expect(gaps).toEqual([25, 35, 45, 6, 35, 40, 45, 25]);
    expect(gaps.reduce((sum, gap) => sum + gap, 0)).toBe(256);
    // The award-ONCE bit is clear on every shipped entry, which is why the
    // re-roll at 0x6128 is not reconstructed. See `spinPrizeWheel`.
    expect(wheel.prizeTable.map((one) => one.flags)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("the casino chain a player actually walks", () => {
  const modes = modesFor("babewatch");

  it("runs lock 16 -> s53 -> e65 -> lock 8 -> s57 -> s153 -> s154 -> e66", () => {
    // Both locks are physical roots: a ball in the saucer runs the script.
    expect(modes.scriptForLock(0, 16)).toBe(53);
    expect(modes.scriptForLock(1, 8)).toBe(57);
    // s53 arms e65, whose own display record is the caption this port was
    // silent about until this round.
    expect(modes.scripts[53]!.ops.some((op) => op.op === 1 && op.args[0] === 65)).toBe(true);
    expect(modes.messages[modes.elements[65]!.displayStart]!.lines).toEqual(["THE CASINO IS OPEN"]);
    // s57 is the machine's own two-branch gate: award e65 if its lamp is lit,
    // else say so. Both branches are live in this port.
    const gate = modes.scripts[57]!.ops.map((op) => op.op);
    expect(gate).toContain(23); // JMP_IF_UNLIT
    expect(gate).toContain(5); // AWARD
    expect(gate).toContain(17); // MESSAGE "THE CASINO IS CLOSED"
    // The edge the census could not see.
    expect(modes.elements[65]!.effect).toBe(17);
    expect(modes.elements[65]!.chainScript).toBe(153);
    expect(modes.scripts[153]!.ops.some((op) => op.op === 9 && op.args[0] === AWARDER)).toBe(true);
    expect(modes.scripts[AWARDER]!.ops.some((op) => op.op === 5 && op.args[0] === WHEEL)).toBe(true);
    // And e66 needs no arming at all: flags bit 1 is lit at game start, so
    // $5CA8's `bclr` has something to clear the very first time it is asked.
    expect(modes.elements[WHEEL]!.flags & 0x02).toBe(0x02);
    expect(modes.litAtGameStart).toContain(WHEEL);
    expect(createModeState(modes).armed[WHEEL]).toBe(1);
  });
});

describe("a driven spin", () => {
  const modes = modesFor("babewatch");

  it("pays the prize the roll lands on, and the same prize for the same frame", () => {
    // One roll inside each of the eight gaps, and what it paid. These are the
    // whole payout: prizes 2, 3, 5 and 6 are AWARDs of BabeWatch's four money
    // elements, prize 0 is the bonus-multiplier rung, prize 4 is the corpus's
    // only HOLD BONUS, and 1 and 7 light a shot instead of paying one.
    const cases: [number, Partial<Spin>][] = [
      [10, { prize: 0, score: 0, bonus: 1_000_000 }],
      [40, { prize: 1, score: 0, extraBallsLit: 1 }],
      [80, { prize: 2, score: 10_000_000 }],
      [108, { prize: 3, score: 100_000_000 }],
      [130, { prize: 4, score: 0, holdBonus: true }],
      [160, { prize: 5, score: 25_000_000 }],
      [200, { prize: 6, score: 5_000_000 }],
      [240, { prize: 7, score: 0 }],
    ];
    for (const [roll, expected] of cases) {
      expect({ roll, ...spinAt(modes, roll) }).toMatchObject({ roll, ...expected });
      // DETERMINISTIC, which is the whole reason the roll is a frame counter
      // and not `Math.random()`: the same frame gives the same prize, and the
      // census and the sim-hash pin can both reproduce it.
      expect(spinAt(modes, roll)).toEqual(spinAt(modes, roll));
    }
  });

  it("is worth 8,886,719 a spin over the 256 rolls its counter can take", () => {
    const spins = Array.from({ length: 256 }, (_, roll) => spinAt(modes, roll));
    const total = spins.reduce((sum, one) => sum + one.score, 0);
    // The table's own weights, measured rather than asserted from the odds:
    // 45x10M + 6x100M + 40x25M + 45x5M = 2,275,000,000 over 256 rolls.
    expect(total).toBe(2_275_000_000);
    expect(Math.round(total / 256)).toBe(8_886_719);
    // The two non-score prizes, at their own weights: 35/256 each.
    expect(spins.filter((one) => one.holdBonus).length).toBe(35);
    expect(spins.filter((one) => one.extraBallsLit > 0).length).toBe(35);
    // 100,000,000 on 6 rolls of 256, which is the smallest slice on the wheel
    // and BabeWatch's only hundred-million award.
    expect(spins.filter((one) => one.score === 100_000_000).length).toBe(6);
    // Every prize on the table is reached; no roll falls through the walk.
    expect(new Set(spins.map((one) => one.prize))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(spins.filter((one) => one.prize < 0).length).toBe(0);
  });

  it("reports nothing unimplemented, which it used to for every spin", () => {
    const state = createModeState(modes);
    state.frames = 100;
    queueScript(state, AWARDER);
    let unimplemented = 0;
    for (let tick = 0; tick < 40; tick += 1) unimplemented += tickModes(modes, state).unimplemented;
    expect(unimplemented).toBe(0);
  });
});

describe("the frame counter the roll comes off", () => {
  it("counts one per tick and survives a ball, exactly as $C8AC does", () => {
    const modes = modesFor("babewatch");
    const state = createModeState(modes);
    expect(state.frames).toBe(0);
    for (let tick = 0; tick < 137; tick += 1) tickModes(modes, state);
    expect(state.frames).toBe(137);
  });
});

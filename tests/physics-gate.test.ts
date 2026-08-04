/**
 * THE PHYSICS GATE, inside the suite: the shipped `stepBalls` measured against
 * the ORIGINAL MACHINE'S OWN per-frame RAM record.
 *
 * WHAT THIS FILE IS FOR, and how it differs from its neighbour. There are two
 * tests about the arch round's decode and they ask different questions:
 *
 *   `arch-normal.test.ts`  pins BEHAVIOUR. Does the frame have eight substeps
 *                          and four passes; does the staircase answer 10.79 and
 *                          14.13 either side of a computed boundary; does the
 *                          decode's own unobserved 17.24 forecast come out at
 *                          17.25. It needs no research tree and it would still
 *                          be meaningful if every trace on earth were lost.
 *
 *   THIS FILE             measures ERROR AGAINST THE MACHINE. Over 576 traced
 *                          frames carrying 218 contacts, how far is this port's
 *                          answer from what the original's RAM actually held?
 *                          That is a single number — 1790 units of 1/256 px per
 *                          frame — and it is the number a physics round has to
 *                          move in the right direction or leave alone.
 *
 * A round could satisfy the first and wreck the second (get the staircase right
 * at one site and the slip wrong everywhere), or satisfy the second and wreck
 * the first (score well on average and lose the phase response). Neither
 * subsumes the other, and neither is the film gate, which pins RENDERING and
 * cannot move on a trajectory change at all — see
 * `research/physics-gate/README.md` for the table of which gate proves what.
 *
 * The corpus lives in the operator's research tree beside this repo and is not
 * part of the build, so this file skips — loudly — where that tree is absent,
 * the same way `intro-pixels.test.ts` does for the intro reference frames. On
 * the machine a physics round runs on, it runs, and it is the cheapest way to
 * discover that an integrator change moved the port away from the original.
 *
 * The operator's copy of the same measurement, with the per-frame CSV and a
 * non-zero exit code, is
 * `& "…\research\physics-gate\run.cmd" <label>`. Both call the one scorer in
 * `physics-corpus.ts`, so they cannot disagree.
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PHYSICS_GATE_BASELINE,
  PHYSICS_GATE_CONTROL,
  corpusPresent,
  findProjectRoot,
  formatGateReport,
  judgePhysicsGate,
  runPhysicsGate,
} from "./physics-corpus.js";

const ROOT = findProjectRoot(fileURLToPath(new URL(".", import.meta.url)));
const present = corpusPresent(ROOT);

/** Scored once and shared: the map decode is the expensive part, not the ticks. */
let cached: ReturnType<typeof runPhysicsGate> | null = null;
function scored(): ReturnType<typeof runPhysicsGate> {
  // `corpusPresent` is the type guard that makes ROOT a string; `skipIf` cannot
  // narrow it for the compiler, so the guard is re-run here.
  if (!corpusPresent(ROOT)) throw new Error("the RAM corpus is not on this machine");
  cached ??= runPhysicsGate(ROOT);
  return cached;
}

describe.skipIf(!present)("the shipped physics against the machine's own RAM", () => {
  it("reproduces the pinned score exactly, on all 576 traced frames", () => {
    const report = scored();
    const judgement = judgePhysicsGate(report.all);

    // The verdict first, with the whole report attached: a failure here should
    // tell a future round what moved without making it re-run anything.
    expect(
      judgement.verdict,
      `\n${formatGateReport(report)}\n\n` +
        judgement.deltas
          .map(
            (delta) =>
              `  ${delta.field} ${delta.baseline} -> ${delta.measured} ` +
              `(${delta.worse ? "WORSE" : "better"})`,
          )
          .join("\n") +
        "\n\nA move here is a statement about the physics, not a flaky number: the " +
        "score is a deterministic function of this tree. If the move is intended, " +
        "re-pin PHYSICS_GATE_BASELINE in tests/physics-corpus.ts AND the baseline " +
        "table in research/physics-gate/README.md, in the same commit, with the reason.\n",
    ).toBe("pass");

    // And field by field, so a diff of the failure output names the figure.
    expect(report.all).toEqual(PHYSICS_GATE_BASELINE);
  });

  it("is enormously better than the swept path it replaced", () => {
    // Not a tolerance — a sanity rail on the RECORD. If someone ever re-pins the
    // baseline to something near the pre-fix control, that is a revert wearing a
    // re-pin's clothes and it should not pass quietly.
    expect(PHYSICS_GATE_BASELINE.errorSum * 10).toBeLessThan(PHYSICS_GATE_CONTROL.errorSum);
    expect(PHYSICS_GATE_BASELINE.posExact).toBeGreaterThan(PHYSICS_GATE_CONTROL.posExact + 400);
    expect(PHYSICS_GATE_CONTROL.posExact).toBe(0);
  });

  it("scores every trace, and the error is concentrated on contact frames", () => {
    const report = scored();
    expect(report.perTrace.map((trace) => trace.trace)).toEqual([
      "coldA",
      "coldB",
      "coldD",
      "warm-ball1",
    ]);
    expect(report.perTrace.reduce((sum, trace) => sum + trace.frames, 0)).toBe(576);
    // Every unit of the error sits on a contact frame: the 358 free-flight
    // frames are bit-exact, which is what the integrator half of the arch fix
    // bought and the strongest single statement this corpus makes.
    expect(report.contactOnly.errorSum).toBe(report.all.errorSum);
    expect(report.all.frames - report.all.contacts).toBe(358);
  });
});

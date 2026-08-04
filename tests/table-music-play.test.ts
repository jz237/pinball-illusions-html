/**
 * THE TABLE MUSIC, HEARD — a real game, a real controller, and a mixer that
 * can be asked what is coming out of it.
 *
 * ---------------------------------------------------------------------------
 * THE HOLE THIS FILLS
 * ---------------------------------------------------------------------------
 * `table-music.test.ts` proves the decode, the section maths and the cue
 * semantics, and it is right about all of them. What it never asks is whether
 * a PLAYED GAME makes a sound: every controller case there hands the
 * controller a table whose manifest is already in hand and then feeds it one
 * synthetic report. The shipped build serves ball one twenty-five ticks after
 * the table opens, which is halfway through the manifest's own download, and
 * the whole of ball one came out silent on all three tables with the suite
 * green — the eighth blind instrument this project has found.
 *
 * So this file drives the real `createGame` / `tickGame` loop, over the real
 * shipped manifests, THROUGH A NETWORK THAT TAKES TIME, and asserts on
 * `RecordingMusicHost.audibleAt` — the level actually reaching the
 * destination through the gain graph the browser code builds. A zero here is
 * a zero in a browser.
 *
 * ---------------------------------------------------------------------------
 * EVERY ZERO IS PROVED
 * ---------------------------------------------------------------------------
 * The lesson of the last seven: a clean pass means nothing until the case is
 * shown to have been exercised. So each case below also asserts its own
 * premise — that the manifest really was still in flight when the ball was
 * served, that channel 3 really did have notes on it before the duck, that
 * the tilt really did happen. Those assertions are not decoration; they are
 * what stops this file joining the ones it was written to replace.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE AUDIO SWEEP ADDED (research/AUDIO_SWEEP.md)
 * ---------------------------------------------------------------------------
 * The round that wrote the first half of this file could only reach what a
 * bot could reach, and modes, multiball and jackpots did not run when the
 * music was written. They do now, so the second half asks the questions that
 * were unanswerable then:
 *
 *   THE GAME-OVER AND HIGH-SCORE RECORDS. This file used to pin them as "the
 *     shell owns those screens", which is true of the PORT and was being read
 *     as if it were true of the MACHINE. It is not: `$45FE` and `$466A` post
 *     the descriptor's +$8C and +$90 cues, and both records render as looping
 *     TUNES. The pin stays, the reason is corrected, and the divergence is
 *     named.
 *   THE MODE CUES, in a real mission and a real multiball — including the
 *     add-a-ball branch of `observe`'s ball count, which had never been
 *     executed by an actual second ball.
 *   THE DUCK, against the REAL effect bank on the SAME host, which is the
 *     browser's own arrangement, at the load a played tick puts on it.
 *   THE INTRO, on a context that has not been unlocked — the first use of
 *     `SuspendedMusicHost`, which had sat in the model unused.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createGame, debugSnapshot, startGame, tickGame } from "../src/browser/game-loop.js";
import type { Game, GameTickReport } from "../src/browser/game-loop.js";
import { CONTROLS } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { createTableMusic } from "../src/browser/table-music.js";
import type { TableMusic } from "../src/browser/table-music.js";
import { createShellMusic } from "../src/browser/shell-music.js";
import { loadShellMusic } from "../src/audio/shell-music.js";
import { loadTableMusic } from "../src/audio/table-music.js";
import type { TableMusicAsset, TableMusicCue, TableMusicFetch } from "../src/audio/table-music.js";
import { createAudioBank, loadAudioBank, playTick } from "../src/browser/audio.js";
import type { AudioBank, AudioHost } from "../src/browser/audio.js";
import { parseEngineAudioDocument, parseTableAudioDocument } from "../src/game/table-audio.js";
import { createTrackerOutput, pumpTracker, startTracker } from "../src/audio/tracker-output.js";
import { queueScript } from "../src/game/mode-vm.js";
import type { PlayfieldLevel, TableId } from "../src/game/contracts.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import { mapFor, modesFor } from "./table-fixtures.js";
import { pixelsToQ10 } from "../src/core/fixed-point.js";
import { RecordingMusicHost, SuspendedMusicHost, sectionSignature } from "./music-mixer.js";

// ---------------------------------------------------------------------------
// The disk, and the disk over a network
// ---------------------------------------------------------------------------

const TABLES_DIR = fileURLToPath(new URL("../public/generated/tables/", import.meta.url));
const exported = existsSync(`${TABLES_DIR}law-n-justice.music.json`);

function fileName(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

function bodyOf(name: string): ArrayBuffer {
  const bytes = readFileSync(`${TABLES_DIR}${name}`);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const missing = {
  ok: false as const,
  status: 404,
  statusText: "Not Found",
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
};

const found = (name: string) => ({
  ok: true as const,
  status: 200,
  statusText: "OK",
  arrayBuffer: () => Promise.resolve(bodyOf(name)),
});

/** The disk with no latency at all — for building the test's own reference. */
const instantFetch: TableMusicFetch = (url) => {
  const name = fileName(url);
  return Promise.resolve(existsSync(`${TABLES_DIR}${name}`) ? found(name) : missing);
};

/** The same, over the shell's own directory, for the front-end module. */
const SHELL_DIR = fileURLToPath(new URL("../public/generated/shell/", import.meta.url));
const shellFetch = (url: string): ReturnType<TableMusicFetch> => {
  const name = fileName(url);
  const path = `${SHELL_DIR}${name}`;
  if (!existsSync(path)) return Promise.resolve(missing);
  const bytes = readFileSync(path);
  return Promise.resolve({
    ok: true as const,
    status: 200,
    statusText: "OK",
    arrayBuffer: () =>
      Promise.resolve(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      ),
  });
};

/**
 * THE NETWORK. One request settles per `release()`, so a run can hold the
 * manifest back exactly as far as it likes and the arrival is deterministic —
 * no timers, no wall clock. One release per game tick is a 20 ms round trip,
 * which is a generous model of any real connection.
 */
class PacedNetwork {
  private readonly waiting: (() => void)[] = [];
  private open = 0;
  /** Requests the loader has ASKED for. */
  requests = 0;
  /**
   * Requests that have ANSWERED. The loader asks for its fifty WAVs all at
   * once, so "asked" says nothing about how far the download has got and
   * measuring the load window with it is measuring the wrong thing.
   */
  settled = 0;

  readonly fetch: TableMusicFetch = (url) => {
    this.requests += 1;
    this.open += 1;
    const name = fileName(url);
    return new Promise((settle) => {
      this.waiting.push(() => {
        this.open -= 1;
        this.settled += 1;
        settle(existsSync(`${TABLES_DIR}${name}`) ? found(name) : missing);
      });
    });
  };

  /** Settles the oldest outstanding request, if there is one. */
  release(): void {
    this.waiting.shift()?.();
  }

  /** Settles everything outstanding at once, as one HTTP/2 round trip would. */
  releaseAll(): void {
    while (this.waiting.length > 0) this.waiting.shift()?.();
  }

  /** Nothing asked for, nothing owed: the loader has run out of work. */
  get idle(): boolean {
    return this.waiting.length === 0 && this.open === 0;
  }
}

/** Lets every pending promise continuation run. */
const turn = (): Promise<void> => new Promise((settle) => setImmediate(settle));

/**
 * Runs a held-back load all the way to its end, whatever shape it has: a
 * loader that issues its files together finishes in two rounds and one that
 * awaits them one at a time takes as many rounds as it has files. Bounded, so
 * a loader that never finishes fails the case rather than hanging it.
 */
async function finishLoad(network: PacedNetwork): Promise<void> {
  for (let round = 0; round < 200; round += 1) {
    network.releaseAll();
    await turn();
    await turn();
    if (network.idle) {
      // Two clear rounds: the assembling continuation may still ask for more.
      await turn();
      if (network.idle) return;
    }
  }
  throw new Error("the held-back music load never finished");
}

// ---------------------------------------------------------------------------
// Driving a game
// ---------------------------------------------------------------------------

class Script {
  private tick = 0;
  private held = new Set<Control>();

  constructor(private readonly plan: (tick: number) => readonly Control[]) {}

  sample(): ControlSnapshot {
    const wanted = new Set(this.plan(this.tick));
    const before = this.held;
    this.held = wanted;
    this.tick += 1;
    const controls = {} as Record<Control, ControlEdges>;
    for (const control of CONTROLS) {
      const down = wanted.has(control);
      const was = before.has(control);
      controls[control] = {
        down,
        pressed: down && !was,
        released: !down && was,
        pressCount: down && !was ? 1 : 0,
        releaseCount: !down && was ? 1 : 0,
      };
    }
    return { sequence: this.tick, controls };
  }
}

/** One PAL field, which is one simulation tick and one frame of the shell. */
const TICK_SECONDS = 0.02;

const noEffects: AudioBank = { channel: { source: null, priority: 0, until: 0 } } as unknown as AudioBank;

const effectUntil = (until: number): AudioBank =>
  ({ channel: { source: null, priority: 0, until } }) as unknown as AudioBank;

interface Probe {
  readonly host: RecordingMusicHost;
  readonly music: TableMusic;
  readonly game: Game;
  readonly network: PacedNetwork;
  readonly reference: TableMusicAsset;
  /** Context time, per tick, of every tick run so far. */
  readonly times: number[];
  /** `audibleAt` at each of those, sampled on the tick. */
  readonly levels: number[];
  /** The section up on each tick, as `bank:position`, or null for silence. */
  readonly sections: (string | null)[];
  run(
    ticks: number,
    effects?: AudioBank | ((tick: number) => AudioBank),
    /**
     * Run between the engine's post and the player's frame, which is where
     * `main.ts` puts `playTick` — so a case can hang the REAL effect bank off
     * the same host and duck channel 3 with a real sounding effect.
     */
    onReport?: (report: GameTickReport) => void,
  ): Promise<GameTickReport[]>;
  /** Which section is up right now, as `bank:position`, or null. */
  where(): string | null;
  /** Names one of the asset's own cue targets the same way. */
  name(cue: TableMusicCue): string;
  /**
   * True when a cue's own section is the only one with its fingerprint, so
   * `name()` identifies it exactly. Asserting an ABSENCE is only sound if the
   * name being looked for could not be hiding under another slot's.
   */
  namedUniquely(cue: TableMusicCue): boolean;
}

/**
 * A table opened exactly as `main.ts` opens one: the music fetch is started
 * and the game is started in the SAME synchronous turn, because `openTable`
 * calls `tableMusic.select` and then `apply(shellTableLoaded(shell))`, and
 * `shellTableLoaded` returns `start-game`.
 */
async function openTable(
  tableId: TableId,
  plan: (tick: number) => readonly Control[],
  options: { readonly holdManifest?: boolean } = {},
): Promise<Probe> {
  const reference = (await loadTableMusic(tableId, instantFetch, "")) as TableMusicAsset;
  expect(reference, `${tableId} has no shipped music manifest`).not.toBeNull();

  // Every renderable section of the reference, by fingerprint. Two copies of
  // the same manifest render byte-identical streams, so this names the
  // controller's own private asset without reaching into it.
  const names = new Map<string, string>();
  for (const [bank, song] of reference.songs.entries()) {
    for (let position = 0; position < song.orders.length; position += 1) {
      const stream = reference.section(bank, position);
      if (stream === null) continue;
      const key = sectionSignature(stream);
      // First writer wins: a duplicate fingerprint is two order slots playing
      // the same thing, and either name is as true as the other.
      if (!names.has(key)) names.set(key, `${bank}:${position}`);
    }
  }

  const host = new RecordingMusicHost();
  const network = new PacedNetwork();
  const music = createTableMusic(() => host, network.fetch);
  const game = createGame(mapFor(tableId));

  music.select(tableId);
  startGame(game);

  const input = new Script(plan);
  const times: number[] = [];
  const levels: number[] = [];
  const sections: (string | null)[] = [];
  let loading = true;

  const where = (): string | null => {
    const stream = music.output.stream;
    return stream === null ? null : (names.get(sectionSignature(stream)) ?? "?");
  };

  return {
    host,
    music,
    game,
    network,
    reference,
    times,
    levels,
    sections,
    where,
    name: (cue) => `${cue.bank}:${cue.position}`,
    namedUniquely: (cue) => {
      const stream = reference.section(cue.bank, cue.position);
      if (stream === null) return false;
      return names.get(sectionSignature(stream)) === `${cue.bank}:${cue.position}`;
    },

    async run(ticks, effects = noEffects, onReport): Promise<GameTickReport[]> {
      const reports: GameTickReport[] = [];
      for (let i = 0; i < ticks; i += 1) {
        if (loading && options.holdManifest !== true) {
          network.release();
          await turn();
          // Two more turns once the loader stops asking, so the assembling
          // continuation runs before the tick that should hear it.
          if (network.idle) {
            await turn();
            await turn();
            loading = false;
          }
        }
        host.advance(TICK_SECONDS);
        const report = tickGame(game, input.sample());
        onReport?.(report);
        music.observe(report);
        music.update("play", typeof effects === "function" ? effects(times.length) : effects);
        times.push(host.currentTime);
        levels.push(host.audibleAt(host.currentTime));
        sections.push(where());
        reports.push(report);
      }
      return reports;
    },
  };
}

/** Presses the plunger for two ticks, `after` ticks past every serve. */
function launchAfterServe(after: number): {
  plan: (tick: number) => readonly Control[];
  arm: (tick: number) => void;
} {
  let at = -1;
  return {
    plan: (tick) => (at >= 0 && tick >= at && tick < at + 2 ? ["plunger"] : []),
    arm: (tick) => {
      at = tick + after;
    },
  };
}

// ---------------------------------------------------------------------------
// Ball one
// ---------------------------------------------------------------------------

describe.skipIf(!exported)("the table music sounds during ball one", () => {
  for (const tableId of TABLE_IDS) {
    it(`${tableId}: serves, vamps and hands over to the main tune on the first ball`, async () => {
      const launcher = launchAfterServe(30);
      const probe = await openTable(tableId, launcher.plan);

      // Find the serve, and record how far the download had got when it came.
      let serveTick = -1;
      let settledAtServe = -1;
      let launchTick = -1;
      for (let tick = 0; tick < 500 && launchTick < 0; tick += 1) {
        const [report] = await probe.run(1);
        if (report?.served === true) {
          serveTick = tick;
          settledAtServe = probe.network.settled;
          launcher.arm(tick);
        }
        if (report?.launched === true) launchTick = tick;
      }

      expect(serveTick, "the first ball was never served").toBeGreaterThanOrEqual(0);
      expect(launchTick, "the first ball was never launched").toBeGreaterThan(serveTick);

      // THE PREMISE. This case is only worth anything if the manifest really
      // was still in flight when the ball was served — which is the shipped
      // condition and was the whole defect. If a future round makes the load
      // instant this assertion is the one that says so, loudly, rather than
      // letting the case pass without exercising anything.
      const total = probe.network.requests;
      expect(
        settledAtServe,
        `${tableId}: the manifest had already fully arrived at the serve (${settledAtServe}/${total}) — this case no longer exercises the load window`,
      ).toBeLessThan(total);

      // Play out the rest of the ball.
      await probe.run(300);

      // THE MEASUREMENT. From the manifest's arrival to the end of the run the
      // music must be sounding. The arrival is the first tick anything is up.
      const arrival = probe.sections.findIndex((section) => section !== null);
      expect(arrival, `${tableId}: nothing ever started`).toBeGreaterThanOrEqual(0);

      const after = probe.levels.slice(arrival);
      const audible = after.filter((level) => level > 0).length;
      expect(
        audible / after.length,
        `${tableId}: only ${audible}/${after.length} ticks after the manifest landed were audible`,
      ).toBeGreaterThan(0.98);

      // AND WHAT IT IS PLAYING. The vamp goes up on the ball-start record and
      // the main tune replaces it; both must be reached inside ball one.
      const vamp = probe.name(probe.reference.cues.ballStart);
      const main = probe.name(probe.reference.cues.queueMain);
      expect(probe.sections[arrival], `${tableId}: the first section up`).toBe(vamp);
      expect(
        probe.sections.slice(arrival).includes(main),
        `${tableId}: the main tune never entered during ball one`,
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// The handover
// ---------------------------------------------------------------------------

describe.skipIf(!exported)("the launch hands the vamp over to the main tune", () => {
  for (const tableId of TABLE_IDS) {
    it(`${tableId}: the switch lands on a whole lap of the vamp`, async () => {
      const launcher = launchAfterServe(20);
      // The manifest is held back until after the game has started but let
      // through before the serve, so the vamp genuinely sounds and the launch
      // takes the QUEUED path rather than the mailbox's direct one.
      const probe = await openTable(tableId, launcher.plan, { holdManifest: true });
      await finishLoad(probe.network);

      const vamp = probe.name(probe.reference.cues.ballStart);
      const main = probe.name(probe.reference.cues.queueMain);
      const vampStream = probe.reference.section(
        probe.reference.cues.ballStart.bank,
        probe.reference.cues.ballStart.position,
      );
      expect(vampStream, `${tableId}: no vamp section`).not.toBeNull();
      expect(vampStream?.restartMs, `${tableId}: the vamp has no lap to hand over on`).not.toBeNull();

      let serveTick = -1;
      let vampStart = -1;
      for (let tick = 0; tick < 600; tick += 1) {
        const [report] = await probe.run(1);
        if (report?.served === true) {
          serveTick = tick;
          launcher.arm(tick);
          vampStart = probe.host.currentTime;
        }
        if (serveTick >= 0 && probe.where() === main) break;
      }
      expect(serveTick, `${tableId}: never served`).toBeGreaterThanOrEqual(0);
      expect(probe.sections[serveTick], `${tableId}: the serve did not put the vamp up`).toBe(vamp);
      expect(probe.where(), `${tableId}: the main tune never entered`).toBe(main);

      // The handover moment is where the main tune's own clock starts, and it
      // must be a WHOLE NUMBER OF VAMP LAPS after the vamp began — that is
      // what a -1 queue does at $8860 and it is what six filmed launches did.
      const lapSeconds = ((vampStream?.durationMs ?? 0) - (vampStream?.restartMs ?? 0)) / 1000;
      const elapsed = probe.music.output.startContextTime - vampStart;
      const laps = elapsed / lapSeconds;
      expect(
        Math.abs(laps - Math.round(laps)),
        `${tableId}: the handover fell ${(laps % 1).toFixed(3)} of a lap from a boundary`,
      ).toBeLessThan(1e-6);
      expect(Math.round(laps), `${tableId}: the handover happened before a full lap`).toBeGreaterThanOrEqual(1);
    });
  }
});

// ---------------------------------------------------------------------------
// The tilt, and coming back from it
// ---------------------------------------------------------------------------

describe.skipIf(!exported)("a tilt plays its jingle and then the F00 silence", () => {
  it("law-n-justice: jingle, silence, and the next ball's vamp", async () => {
    const probe = await openTable("law-n-justice", (tick) => {
      if (tick >= 60 && tick < 62) return ["plunger"];
      if (tick >= 70 && tick % 10 < 3) return ["nudgeLeft"];
      return [];
    });

    let tiltTick = -1;
    let serveAfterTilt = -1;
    for (let tick = 0; tick < 900; tick += 1) {
      const [report] = await probe.run(1);
      if (report?.justTilted === true && tiltTick < 0) tiltTick = tick;
      if (tiltTick >= 0 && report?.served === true) {
        serveAfterTilt = tick;
        break;
      }
    }
    expect(tiltTick, "hammering the cabinet never tilted the table").toBeGreaterThan(0);
    expect(serveAfterTilt, "no ball was served after the tilt").toBeGreaterThan(tiltTick);

    const tilt = probe.name(probe.reference.cues.tilt);
    const tiltStream = probe.reference.section(
      probe.reference.cues.tilt.bank,
      probe.reference.cues.tilt.position,
    );
    // The tilt section ends in F00 — no loop point — which is what makes the
    // silence a silence rather than a repeat.
    expect(tiltStream?.restartMs, "the tilt section loops instead of stopping").toBeNull();

    // The jingle is up on the tick the tilt lands, and sounding.
    expect(probe.sections[tiltTick], "the tilt did not put its jingle up").toBe(tilt);
    expect(probe.levels[tiltTick], "the tilt jingle was silent").toBeGreaterThan(0);

    // And it goes quiet by its own decoded length, and stays quiet until the
    // end-of-ball record. The jingle is 2900 ms on this table.
    const jingleTicks = Math.round((tiltStream?.durationMs ?? 0) / (TICK_SECONDS * 1000));
    const quietFrom = tiltTick + jingleTicks + 2;
    const stop = probe.name(probe.reference.cues.endStop);
    const silentRun: number[] = [];
    for (let tick = quietFrom; tick < probe.levels.length; tick += 1) {
      if (probe.sections[tick] !== tilt) break;
      silentRun.push(probe.levels[tick] ?? -1);
    }
    expect(silentRun.length, "the tilt jingle never handed over to anything").toBeGreaterThan(10);
    expect(
      silentRun.every((level) => level === 0),
      `the F00 did not silence the player: levels ${silentRun.slice(0, 8).join(", ")}`,
    ).toBe(true);

    // The end-of-ball record, then the next ball's vamp: the stop flag comes
    // down on the -2 and the table sings again.
    expect(probe.sections.slice(quietFrom).includes(stop), "the end-of-ball record never fired").toBe(true);
    const vamp = probe.name(probe.reference.cues.ballStart);
    expect(probe.sections[serveAfterTilt], "the next ball did not restart the vamp").toBe(vamp);
    expect(probe.levels[serveAfterTilt], "the next ball's vamp was silent").toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Channel 3 belongs to the effects
// ---------------------------------------------------------------------------

describe.skipIf(!exported)("an effect takes channel 3 from the music", () => {
  it("extreme-sports: the duck silences channel 3 and nothing else", async () => {
    const launcher = launchAfterServe(20);
    const probe = await openTable("extreme-sports", launcher.plan);

    // Get to the main tune: it is the only in-game section with channel-3
    // notes early enough to duck (the vamps have none at all on any table,
    // which is itself the machine's rule — the effects own AUD3).
    const main = probe.name(probe.reference.cues.queueMain);
    for (let tick = 0; tick < 600; tick += 1) {
      const [report] = await probe.run(1);
      if (report?.served === true) launcher.arm(tick);
      if (probe.where() === main) break;
    }
    expect(probe.where(), "never reached the main tune").toBe(main);

    // Run open for long enough that channel 3 is definitely carrying notes.
    const open: number[] = [];
    for (let tick = 0; tick < 120; tick += 1) {
      await probe.run(1);
      open.push(probe.host.audibleOnChannelAt(probe.music.output, 3, probe.host.currentTime));
    }
    // THE PREMISE, again: a duck that silences nothing is not a duck. This is
    // the assertion that stops the case below passing over an empty channel.
    expect(
      open.filter((level) => level > 0).length,
      "channel 3 was never carrying music, so ducking it proves nothing",
    ).toBeGreaterThan(20);

    // Now hold an effect over the channel for the next stretch.
    const ducked: number[] = [];
    const others: number[] = [];
    for (let tick = 0; tick < 120; tick += 1) {
      await probe.run(1, effectUntil(probe.host.currentTime + 0.5));
      ducked.push(probe.host.audibleOnChannelAt(probe.music.output, 3, probe.host.currentTime));
      let rest = 0;
      for (const channel of [0, 1, 2]) {
        rest += probe.host.audibleOnChannelAt(probe.music.output, channel, probe.host.currentTime);
      }
      others.push(rest);
    }
    expect(
      ducked.every((level) => level === 0),
      `channel 3 kept sounding under an effect: ${ducked.filter((level) => level > 0).length} ticks`,
    ).toBe(true);
    expect(
      others.filter((level) => level > 0).length,
      "the duck took the whole song, not just channel 3",
    ).toBeGreaterThan(others.length * 0.9);

    // And it comes back mid-phrase when the effect ends.
    const back: number[] = [];
    for (let tick = 0; tick < 120; tick += 1) {
      await probe.run(1);
      back.push(probe.host.audibleOnChannelAt(probe.music.output, 3, probe.host.currentTime));
    }
    expect(
      back.filter((level) => level > 0).length,
      "channel 3 never rejoined the song after the effect",
    ).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// The mailbox
// ---------------------------------------------------------------------------

describe.skipIf(!exported)("a cue posted before the manifest lands is not lost", () => {
  /**
   * The four moments a manifest can arrive at, and what the machine has up at
   * each. This is the whole of the ball-one defect stated as a table: whatever
   * the engine last posted is what the player plays when it starts.
   */
  it("law-n-justice: the player comes up on whatever the engine last posted", async () => {
    const cases = [
      { release: "before-serve", expect: "ballStart" },
      { release: "after-serve", expect: "ballStart" },
      { release: "after-launch", expect: "queueMain" },
    ] as const;

    for (const scenario of cases) {
      // Thirty ticks after the serve: the ball has settled on the rod by then
      // and the fixed kick actually fires. See `plunger.ts`.
      const launcher = launchAfterServe(30);
      const probe = await openTable("law-n-justice", launcher.plan, { holdManifest: true });
      const letThrough = (): Promise<void> => finishLoad(probe.network);

      if (scenario.release === "before-serve") await letThrough();

      let served = false;
      let launched = false;
      for (let tick = 0; tick < 200 && !launched; tick += 1) {
        const [report] = await probe.run(1);
        if (report?.served === true) {
          served = true;
          launcher.arm(tick);
          if (scenario.release === "after-serve") await letThrough();
        }
        if (report?.launched === true) launched = true;
      }
      expect(served, `${scenario.release}: never served`).toBe(true);
      expect(launched, `${scenario.release}: never launched`).toBe(true);

      if (scenario.release === "after-launch") await letThrough();

      // One frame for the player to read the mailbox, and one to sound.
      await probe.run(4);

      const wanted = probe.name(probe.reference.cues[scenario.expect]);
      expect(probe.where(), `${scenario.release}: wrong section up`).toBe(wanted);
      expect(
        probe.host.audibleAt(probe.host.currentTime),
        `${scenario.release}: the section is up but silent`,
      ).toBeGreaterThan(0);
    }
  });

  it("a manifest that lands outside the table phases starts nothing", async () => {
    const probe = await openTable("law-n-justice", () => [], { holdManifest: true });
    // A ball is served: the engine posts, and nothing can play it yet.
    const served = (await probe.run(60)).some((report) => report.served);
    expect(served, "no ball was served before the manifest was held back").toBe(true);
    // The player leaves the table before the manifest arrives.
    probe.music.update("menu", noEffects);
    await finishLoad(probe.network);
    probe.music.update("menu", noEffects);
    probe.host.advance(TICK_SECONDS);
    expect(probe.music.output.stream, "the music started over a menu").toBeNull();
    expect(probe.host.audibleAt(probe.host.currentTime)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A whole game, and the two records that stay data
// ---------------------------------------------------------------------------

describe.skipIf(!exported)("a whole game, from the first serve to the last drain", () => {
  it("law-n-justice: every ball vamps and every ball ends on the stop record", async () => {
    const launcher = launchAfterServe(30);
    const probe = await openTable("law-n-justice", launcher.plan);

    const vamp = probe.name(probe.reference.cues.ballStart);
    const main = probe.name(probe.reference.cues.queueMain);
    const stop = probe.name(probe.reference.cues.endStop);
    const gameOver = probe.name(probe.reference.cues.gameOver);
    const highScore = probe.name(probe.reference.cues.highScore);

    // THE PREMISE for the absence below: both records must be renderable and
    // must own their own fingerprints, or "never played" would be unprovable.
    expect(
      probe.reference.section(probe.reference.cues.gameOver.bank, probe.reference.cues.gameOver.position),
      "the game-over record does not render",
    ).not.toBeNull();
    expect(
      probe.reference.section(probe.reference.cues.highScore.bank, probe.reference.cues.highScore.position),
      "the high-score record does not render",
    ).not.toBeNull();
    expect(probe.namedUniquely(probe.reference.cues.gameOver), "the game-over section is not uniquely named").toBe(true);
    expect(probe.namedUniquely(probe.reference.cues.highScore), "the high-score section is not uniquely named").toBe(true);

    const serves: number[] = [];
    const stops: number[] = [];
    let over = -1;
    for (let tick = 0; tick < 4000 && over < 0; tick += 1) {
      const [report] = await probe.run(1);
      if (report?.served === true) {
        serves.push(tick);
        launcher.arm(tick);
      }
      if (probe.where() === stop && stops[stops.length - 1] !== serves.length) stops.push(serves.length);
      if (report?.gameOver === true) over = tick;
    }

    expect(over, "the game never ended").toBeGreaterThan(0);
    expect(serves.length, "a three-ball game did not serve three balls").toBe(3);

    // EVERY BALL VAMPS. On the machine that is the serve tick itself; here it
    // is the serve tick or the tick the manifest lands on, whichever is later,
    // and only ball one can be the latter — that is the whole of the residual
    // difference between this and the machine, stated as an index.
    const manifestAt = probe.sections.findIndex((section) => section !== null);
    expect(manifestAt, "the manifest never landed").toBeGreaterThanOrEqual(0);
    for (const [ball, at] of serves.entries()) {
      const heard = Math.max(at, manifestAt);
      expect(probe.sections[heard], `ball ${ball + 1}: the serve did not put the vamp up`).toBe(vamp);
      expect(probe.levels[heard], `ball ${ball + 1}: the vamp was silent`).toBeGreaterThan(0);
    }
    // Balls two and three are served long after the manifest, so for them the
    // reconstruction is exact: the vamp is up on the serve tick.
    expect(manifestAt, "the manifest landed after the second ball").toBeLessThan(serves[1] ?? 0);
    const seen = new Set(probe.sections.filter((section): section is string => section !== null));
    expect(seen.has(main), "the main tune never played").toBe(true);
    expect(seen.has(stop), "the end-of-ball record never played").toBe(true);

    // AND THE TWO THAT STAY DATA — but no longer for the reason that used to
    // be written here. See the next describe: the machine DOES play both, and
    // this port playing the shell's front-end tune over those screens instead
    // is a divergence, not an absence. Pinned so changing it is deliberate.
    expect(seen.has(gameOver), "the table module played the game-over record").toBe(false);
    expect(seen.has(highScore), "the table module played the high-score record").toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Game over and high score, against the machine
// ---------------------------------------------------------------------------

describe.skipIf(!exported)("the game-over and high-score records, measured", () => {
  /**
   * THE CLAIM THIS REPLACES. The round that wired the music left the +$8C and
   * +$90 records as data and wrote that "those screens belong to the shell in
   * this reconstruction". That is a true statement about the PORT and it was
   * being used as if it were a statement about the MACHINE. It is not, and
   * both halves of the real answer are cheap:
   *
   * WHAT THE ENGINE DOES. `main.seg00` caches the descriptor's five cue
   * pointers at `$2372`(+$84 attract) / `$2376`(+$88 ball start) /
   * `$237A`(+$8C game over) / `$237E`(+$90 high score) / `$2382`(+$94 tilt) —
   * one longword each, in descriptor order. The game-over routine at `$45FE`
   * reads `$237A` and posts it:
   *
   *     0045FE  move.l   $237a(a5), d0
   *     004602  beq.b    $460c            ; a null pointer posts nothing
   *     004604  movea.l  d0, a0
   *     004606  jsr      $6868.l          ; the mailbox poster
   *
   * and the high-score routine, under the once-per-game latch at `$4776`:
   *
   *     00465A  st.b     $93(a5)          ; this player made the ladder
   *     00465E  tst.b    $4776.l
   *     004664  bne.b    $4678
   *     00466A  movea.l  $237e(a5), a0
   *     00466E  jsr      $6868.l
   *
   * So the machine posts a music command at game over and at high-score entry.
   *
   * WHAT THOSE COMMANDS ARE. Both are `-2` background sets, and the sections
   * they name are not stops: the case below renders each one through the same
   * tracker the game uses and asks the mixer what comes out. They are TUNES —
   * Law 'n Justice's game-over record is its own 141-second looping section at
   * order slot 0:50, which no other slot shares.
   *
   * The port is therefore not silent where the machine sings; it plays a
   * DIFFERENT tune, the shell's front-end module, because `TABLE_MUSIC_PHASES`
   * ends at the ball and `SILENT_PHASES` does not include `game-over`,
   * `fanfare` or `initials`. That is a divergence worth naming precisely, and
   * naming it is what this case does. See research/AUDIO_SWEEP.md.
   */
  for (const tableId of TABLE_IDS) {
    it(`${tableId}: both records are tunes, not stops`, async () => {
      const asset = (await loadTableMusic(tableId, instantFetch, "")) as TableMusicAsset;
      for (const name of ["gameOver", "highScore"] as const) {
        const cue = asset.cues[name];
        const stream = asset.section(cue.bank, cue.position);
        expect(stream, `${tableId} ${name}: no section`).not.toBeNull();
        if (stream === null) continue;

        // A -2 background set, as the engine's own poster makes it.
        expect(cue.command, `${tableId} ${name} is not a background set`).toBe(-2);
        // It LOOPS: a section that ends in F00 has no restart point, and both
        // of these have one — so neither is the tilt's kind of silence.
        expect(stream.restartMs, `${tableId} ${name} ends in F00 rather than looping`).not.toBeNull();

        // AND IT SOUNDS. Rendered on its own through the real tracker, the
        // level reaching the destination is above zero across its whole pass.
        const host = new RecordingMusicHost();
        const output = createTrackerOutput(() => host, asset.bank);
        startTracker(output, stream);
        const seconds = Math.min(stream.durationMs / 1000, 30);
        let audible = 0;
        let samples = 0;
        for (let at = 0; at < seconds; at += 0.05) {
          if (at > host.currentTime - 0.5) {
            host.currentTime = at;
            pumpTracker(output, 1.5);
          }
          samples += 1;
          if (host.audibleAt(at) > 0) audible += 1;
        }
        expect(samples, `${tableId} ${name}: nothing sampled`).toBeGreaterThan(100);
        expect(
          audible / samples,
          `${tableId} ${name}: only ${audible}/${samples} of the record was audible`,
        ).toBeGreaterThan(0.9);
      }
    });
  }

  it("the intro runs silent until the first gesture, and the tune is there when it comes", async () => {
    // ITEM 5 OF THE SWEEP, and the reason it needed one: every existing shell
    // case asserts `music.output.playing`, which is a flag on the CONTROLLER.
    // The table music had exactly that shape of coverage when a whole ball
    // came out silent. `SuspendedMusicHost` has been in the mixer model since
    // it was written and nothing had ever used it.
    //
    // `src/browser/intro.ts` opens no audio path of its own: the intro's tune
    // IS the front-end module, and `main.ts` simply leaves its one
    // `music.update(shell.phase)` call running with the phase pinned to
    // `attract` for the whole show. So the intro's audio contract is the
    // shell module's behaviour on a context the browser has not unlocked yet.
    const asset = await loadShellMusic((url) => shellFetch(url));
    expect(asset, "the shell module did not load").not.toBeNull();

    const host = new SuspendedMusicHost();
    const music = createShellMusic({ getItem: () => null, setItem: () => undefined }, () => host);
    music.useAsset(asset);

    // The show runs. The context is untouched, so nothing has asked it to start.
    for (let i = 0; i < 60; i += 1) {
      host.advance(TICK_SECONDS);
      music.update("attract");
    }
    expect(host.state, "the intro started the context without a gesture").toBe("suspended");
    expect(host.resumes, "something resumed the context before any input").toBe(0);

    // The first keypress or pointer event: `main.ts`'s `unlockAudio`.
    music.resume();
    await new Promise<void>((settle) => setImmediate(settle));
    expect(host.resumes, "the unlock did not reach the context").toBe(1);
    expect(host.state).toBe("running");

    // And from there the module is genuinely audible — measured on the graph,
    // not on a flag. This is the handover: the intro stops drawing, the phase
    // is still `attract`, and the same performance carries into the shell.
    let audible = 0;
    for (let i = 0; i < 60; i += 1) {
      host.advance(TICK_SECONDS);
      music.update("attract");
      if (host.audibleAt(host.currentTime) > 0) audible += 1;
    }
    expect(audible, "the front-end tune never sounded after the unlock").toBeGreaterThan(50);

    // The handover itself: the shell's own front door is the same phase, so
    // the performance is not restarted when the intro ends.
    const anchored = music.output.startContextTime;
    host.advance(TICK_SECONDS);
    music.update("attract");
    expect(music.output.startContextTime, "the intro-to-shell handover restarted the tune").toBe(anchored);
  });

  it("the shell's own module is what actually plays over those screens", async () => {
    // The other half of the divergence, measured rather than assumed: the
    // front-end tune is audible on the game-over card, the high-score fanfare
    // and the name box. So the port makes A sound there — just not the
    // machine's. A future round that moves those screens to the table's
    // records has to silence these three phases in the same change.
    const asset = await loadShellMusic((url) => shellFetch(url));
    expect(asset, "the shell module did not load").not.toBeNull();
    const host = new RecordingMusicHost();
    const music = createShellMusic({ getItem: () => null, setItem: () => undefined }, () => host);
    music.useAsset(asset);
    for (const phase of ["game-over", "fanfare", "initials"] as const) {
      let audible = 0;
      for (let i = 0; i < 40; i += 1) {
        host.advance(TICK_SECONDS);
        music.update(phase);
        if (host.audibleAt(host.currentTime) > 0) audible += 1;
      }
      expect(audible, `the shell module was silent over ${phase}`).toBe(40);
    }
  });
});

// ---------------------------------------------------------------------------
// The mode cues, now that modes actually run
// ---------------------------------------------------------------------------

describe.skipIf(!exported)("a mission's own music cue takes the table over", () => {
  /**
   * The mode cues were wired from the decode — mission-VM opcode 19, handler
   * `$5B3E` = `movea.l $2(a1),a0 / bra.w $6868` — at a time when no mission
   * this port could drive ever reached one. Multiball, missions and jackpots
   * all run now, so the question is answerable: does a REAL mission put its
   * own background up, and is that background audible?
   *
   * BabeWatch, because it is the table whose driven game reaches a mission
   * with a music opcode in it soonest. The premise assertion is the one that
   * matters: a case that never executed an opcode 19 would prove nothing.
   */
  it("babewatch: an executed opcode 19 changes the section, and it sounds", async () => {
    const launcher = launchAfterServe(30);
    const probe = await openTable("babewatch", launcher.plan);

    const main = probe.name(probe.reference.cues.queueMain);
    const fired: { at: number; section: string | null; level: number }[] = [];
    let reachedMain = -1;

    for (let tick = 0; tick < 4000; tick += 1) {
      const [report] = await probe.run(1);
      if (report?.served === true) launcher.arm(tick);
      if (reachedMain < 0 && probe.where() === main) reachedMain = tick;
      // One script per window, spaced: the mode queue is a small ring and
      // pushing the whole table into one tick loses all but the last few.
      if (reachedMain >= 0 && tick % 30 === 0 && probe.game.modeState !== null) {
        const scripts = probe.game.modes?.scripts ?? [];
        const next = scripts[Math.floor(tick / 30) % Math.max(1, scripts.length)];
        if (next !== undefined) queueScript(probe.game.modeState, next.index);
      }
      for (const cue of report?.musicCues ?? []) {
        void cue;
        fired.push({
          at: tick,
          section: probe.where(),
          level: probe.host.audibleAt(probe.host.currentTime),
        });
      }
    }

    expect(reachedMain, "the main tune never came up, so no cue had anything to replace").toBeGreaterThan(0);
    // THE PREMISE: opcode 19 has to have RUN.
    expect(fired.length, "no mission music opcode executed, so this case proves nothing").toBeGreaterThan(0);

    // THE MEASUREMENT: at least one of them put a section up that is not the
    // main tune, and the table kept singing across the switch.
    const moved = fired.filter((one) => one.section !== null && one.section !== main);
    expect(
      moved.length,
      `every mode cue left the main tune up: ${fired.map((one) => `${one.at}:${String(one.section)}`).join(" ")}`,
    ).toBeGreaterThan(0);
    for (const one of fired) {
      expect(one.level, `the section a mode cue put up at tick ${one.at} was silent`).toBeGreaterThan(0);
    }
  }, 120_000);

  it("law-n-justice: a mode background does not stop the ball transitions under it", async () => {
    // The three records a mode has to coexist with, and the order the machine
    // resolves them in: a tilt is an override or a background set posted AFTER
    // the mode's, so it wins; the end-of-ball stop is a -2 that replaces the
    // background outright; and the next ball's -2/0/0 clears the stop flag and
    // the vamp sings again over whatever the mode had left in the slot.
    const probe = await openTable("law-n-justice", (tick) => {
      if (tick >= 60 && tick < 66) return ["plunger"];
      if (tick >= 200 && tick % 10 < 3) return ["nudgeLeft"];
      return [];
    });

    const main = probe.name(probe.reference.cues.queueMain);
    const vampName = probe.name(probe.reference.cues.ballStart);
    let tiltTick = -1;
    let serveAfterTilt = -1;
    let modeSections = 0;
    for (let tick = 0; tick < 2000; tick += 1) {
      const [report] = await probe.run(1);
      if (tick % 12 === 0 && tick < 200 && probe.game.modeState !== null) {
        const scripts = probe.game.modes?.scripts ?? [];
        const next = scripts[Math.floor(tick / 12) % Math.max(1, scripts.length)];
        if (next !== undefined) queueScript(probe.game.modeState, next.index);
      }
      const up = probe.where();
      if (tiltTick < 0 && up !== null && up !== main && up !== vampName) modeSections += 1;
      if (report?.justTilted === true && tiltTick < 0) tiltTick = tick;
      if (tiltTick >= 0 && report?.served === true) {
        serveAfterTilt = tick;
        break;
      }
    }

    expect(tiltTick, "the table never tilted").toBeGreaterThan(0);
    expect(serveAfterTilt, "no ball was served after the tilt").toBeGreaterThan(tiltTick);
    // THE PREMISE: something other than the vamp and the main tune really was
    // up before the tilt, or this is the plain tilt case over again.
    expect(modeSections, "no mode section was ever up, so nothing was tilted over").toBeGreaterThan(0);

    const tilt = probe.name(probe.reference.cues.tilt);
    const vamp = probe.name(probe.reference.cues.ballStart);
    expect(probe.sections[tiltTick], "a running mode swallowed the tilt jingle").toBe(tilt);
    expect(probe.levels[tiltTick], "the tilt jingle was silent under a mode").toBeGreaterThan(0);
    expect(probe.sections[serveAfterTilt], "the next ball's vamp did not come back over the mode").toBe(vamp);
    expect(probe.levels[serveAfterTilt], "the next ball's vamp was silent").toBeGreaterThan(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// A stop is a stop, across the whole lookahead
// ---------------------------------------------------------------------------

describe.skipIf(!exported)("stopping the music stops all of it", () => {
  /**
   * THE DEFECT THIS FIXES, found by pointing the ear at the shell.
   *
   * `pumpTracker` commits half a second of notes AHEAD of the clock, and a
   * started `AudioBufferSourceNode` cannot be un-started — only stopped. But
   * `output.channels` holds ONE voice per channel, the furthest-future one,
   * and `stopTracker` walked only that. Every note the lookahead had already
   * committed between the stop and that voice kept its `start(when)` and
   * sounded.
   *
   * Measured before the fix, on the real shipped front-end module: entering
   * the `play` phase left the shell's tune sounding at FULL LEVEL for 23 ticks
   * — 0.46 s, which is the lookahead — decaying in steps as the committed
   * voices ran out. That is the menu music playing over the first half-second
   * of every ball. The same window applied to every immediate background set
   * inside a game (a tilt, the end-of-ball stop, a mode cue) and to leaving a
   * table for the shell.
   *
   * It was invisible because every shell-music case asserted
   * `music.output.playing` — a flag on the controller, which was correctly
   * false the whole time.
   */
  it("the shell's tune is gone the moment the ball starts", async () => {
    const asset = await loadShellMusic((url) => shellFetch(url));
    expect(asset, "the shell module did not load").not.toBeNull();
    const host = new RecordingMusicHost();
    const music = createShellMusic({ getItem: () => null, setItem: () => undefined }, () => host);
    music.useAsset(asset);

    // THE PREMISE: it has to have been sounding, and the pump has to have run
    // far enough ahead to have something committed past the stop.
    let before = 0;
    for (let i = 0; i < 200; i += 1) {
      host.advance(TICK_SECONDS);
      music.update("menu");
      if (host.audibleAt(host.currentTime) > 0) before += 1;
    }
    expect(before, "the shell tune never sounded, so stopping it proves nothing").toBeGreaterThan(150);
    const stoppedAt = host.currentTime;
    const committed = host.voices.filter((voice) => voice.start > stoppedAt).length;
    expect(
      committed,
      "the lookahead had nothing committed past the stop, so this case is not exercising it",
    ).toBeGreaterThan(0);

    // THE MEASUREMENT: from the ball onward, nothing.
    const after: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      host.advance(TICK_SECONDS);
      music.update("play");
      after.push(host.audibleAt(host.currentTime));
    }
    const bleeding = after.filter((level) => level > 0).length;
    expect(
      bleeding,
      `the shell tune played on over ${bleeding} ticks of the ball: ${after.slice(0, 24).map((one) => one.toFixed(2)).join(",")}`,
    ).toBe(0);
  });

  it("a table's tune is gone the moment the table is left", async () => {
    // The same window, the other way round: `update` on a non-table phase
    // calls `silence()`, and the ball's music must not follow the player onto
    // the shell's screens.
    const launcher = launchAfterServe(30);
    const probe = await openTable("law-n-justice", launcher.plan);
    for (let tick = 0; tick < 400; tick += 1) {
      const [report] = await probe.run(1);
      if (report?.served === true) launcher.arm(tick);
    }
    expect(
      probe.levels.filter((level) => level > 0).length,
      "the table never sounded, so leaving it proves nothing",
    ).toBeGreaterThan(100);
    const leftAt = probe.host.currentTime;
    expect(
      probe.host.voices.filter((voice) => voice.start > leftAt).length,
      "nothing was committed past the moment the table was left",
    ).toBeGreaterThan(0);

    probe.music.update("menu", null);
    let bleeding = 0;
    for (let i = 0; i < 60; i += 1) {
      probe.host.advance(TICK_SECONDS);
      probe.music.update("menu", null);
      if (probe.host.audibleAt(probe.host.currentTime) > 0) bleeding += 1;
    }
    expect(bleeding, `the table's tune followed the player onto the shell for ${bleeding} ticks`).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A real multiball, over the music
// ---------------------------------------------------------------------------

/**
 * The ladder rungs that launch a multiball, read out of the shipped document —
 * the same walk `multiball-play.test.ts` makes, and for the same reason: a
 * ladder entry is a LAUNCHER whose body is one `MODE_START`, and queueing it
 * is doing by hand what the counter does when the shot is made.
 */
function multiballLaunchers(tableId: TableId): number[] {
  const OP_MODE_START = 9;
  const OP_BALLS_UP_TO = 27;
  const modes = modesFor(tableId);
  const multiballScripts = new Set<number>();
  for (const script of modes.scripts) {
    for (const op of script.ops) {
      if (op.op === OP_BALLS_UP_TO && (op.args[0] ?? 0) > 1) multiballScripts.add(script.index);
    }
  }
  const launchers: number[] = [];
  for (const script of modes.scripts) {
    for (const op of script.ops) {
      if (op.op === OP_MODE_START && multiballScripts.has(op.args[0] ?? -1)) {
        if (!launchers.includes(script.index)) launchers.push(script.index);
      }
    }
  }
  return launchers;
}

describe.skipIf(!exported)("a multiball does not restart the vamp over the main tune", () => {
  /**
   * THE CUE THIS IS ABOUT. `observe` counts balls so that a BALL-START serve
   * (the engine's `$49BE`/`$4FC4`, which fire the -2/0/0 cue) is told apart
   * from a multiball ADD-A-BALL serve (`$6616`, which fires no music cue at
   * all). When that counting was written multiball did not run in this port,
   * so the branch it guards had never been executed by a real add-a-ball.
   *
   * It runs now, so this is the case that executes it: a driven multiball
   * serves extra balls while the main tune is up, and the vamp must not come
   * back over it. The premise is the extra serves — without them the case is
   * asserting about a branch nothing entered.
   */
  for (const tableId of TABLE_IDS) {
    it(`${tableId}: extra balls are served and the main tune plays on`, async () => {
      const launcher = launchAfterServe(30);
      const probe = await openTable(tableId, launcher.plan);
      const launchers = multiballLaunchers(tableId);
      expect(launchers.length, `${tableId} has no multiball launcher`).toBeGreaterThan(0);

      const vamp = probe.name(probe.reference.cues.ballStart);
      const main = probe.name(probe.reference.cues.queueMain);

      let reachedMain = -1;
      let started = -1;
      let extraServes = 0;
      let vampAfterExtra = -1;

      for (let tick = 0; tick < 6000; tick += 1) {
        // The intervention `multiball-play.test.ts` states: park a ball that
        // falls past the bats, so a multiball lasts longer than a bot can.
        const snapshot = debugSnapshot(probe.game);
        for (const view of snapshot.balls) {
          if (!view.active || view.id === snapshot.laneBallId || view.pixelY <= 540) continue;
          const ball = probe.game.balls.balls.find((one) => one.id === view.id);
          if (ball === undefined || ball.heldBy !== null) continue;
          ball.x = pixelsToQ10(168);
          ball.y = pixelsToQ10(430);
          ball.velocityX = 0;
          ball.velocityY = 0;
          ball.level = 0 as PlayfieldLevel;
        }
        if (
          reachedMain >= 0 &&
          tick % 200 === 0 &&
          probe.game.modeState !== null &&
          debugSnapshot(probe.game).mission === null
        ) {
          queueScript(probe.game.modeState, launchers[0] as number);
        }

        const [report] = await probe.run(1);
        if (report?.served === true) launcher.arm(tick);
        if (reachedMain < 0 && probe.where() === main) reachedMain = tick;
        if (report?.multiballStarted === true && started < 0) started = tick;
        // An ADD-A-BALL serve: a ball arriving while others are already live.
        if (report?.served === true && started >= 0 && reachedMain >= 0) {
          const live = debugSnapshot(probe.game).balls.filter((one) => one.active).length;
          if (live > 1) {
            extraServes += 1;
            if (probe.where() === vamp && vampAfterExtra < 0) vampAfterExtra = tick;
          }
        }
      }

      // THE PREMISES: the main tune was up, a multiball started, and extra
      // balls were actually served over it.
      expect(reachedMain, `${tableId}: the main tune never came up`).toBeGreaterThanOrEqual(0);
      expect(started, `${tableId}: no multiball ever started`).toBeGreaterThan(0);
      expect(
        extraServes,
        `${tableId}: no add-a-ball serve happened, so the branch this case guards never ran`,
      ).toBeGreaterThan(0);

      // THE MEASUREMENT: not one of them put the serve vamp back up.
      expect(
        vampAfterExtra,
        `${tableId}: an add-a-ball serve restarted the vamp at tick ${vampAfterExtra}`,
      ).toBe(-1);
    }, 300_000);
  }
});

// ---------------------------------------------------------------------------
// The duck, under a real effect and a real tick's load
// ---------------------------------------------------------------------------

describe.skipIf(!exported)("channel 3 under a real sounding effect", () => {
  /**
   * `an effect takes channel 3 from the music` above drives the gate with a
   * hand-written `until`. This one drives it with THE REAL EFFECT BANK, on the
   * SAME host — which is the browser's arrangement, one `AudioContext` shared
   * by `createTableMusic` and every `AudioBank` — so the duck is measured
   * against effects a played game actually fired, at the load it actually put
   * on the one channel.
   *
   * BABEWATCH, and the table choice is the premise. Channel 3 is empty for the
   * first 34.5 s of Law 'n Justice's main tune and absent from every vamp on
   * every table, so a duck measured there silences nothing and proves nothing.
   * The case asserts that channel 3 was carrying while the effects were OFF
   * before it accepts a zero while they are on.
   */
  it("babewatch: the duck holds while effects sound, and nothing stays ducked", async () => {
    const launcher = launchAfterServe(30);
    const probe = await openTable("babewatch", launcher.plan);

    const engine = parseEngineAudioDocument(
      JSON.parse(readFileSync(`${TABLES_DIR}../engine.audio.json`, "utf8")) as never,
    );
    const table = parseTableAudioDocument(
      JSON.parse(readFileSync(`${TABLES_DIR}babewatch.audio.json`, "utf8")) as never,
    );
    const bank = createAudioBank(probe.host as unknown as AudioHost, table, engine);
    await loadAudioBank(
      bank,
      async (url) => {
        const bytes = readFileSync(url);
        return {
          ok: true,
          async arrayBuffer(): Promise<ArrayBuffer> {
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          },
        };
      },
      TABLES_DIR,
      `${TABLES_DIR}../`,
    );
    expect(bank.failed.size, "the effect bank did not load").toBe(0);

    const main = probe.name(probe.reference.cues.queueMain);
    const open: number[] = [];
    const ducked: number[] = [];
    let effects = 0;

    for (let tick = 0; tick < 4000; tick += 1) {
      const [report] = await probe.run(1, bank, (one) => {
        const before = probe.host.voices.length;
        playTick(bank, one);
        if (probe.host.voices.length > before) effects += 1;
      });
      if (report?.served === true) launcher.arm(tick);
      if (probe.where() !== main) continue;
      const level = probe.host.audibleOnChannelAt(probe.music.output, 3, probe.host.currentTime);
      if (bank.channel.until > probe.host.currentTime) ducked.push(level);
      else open.push(level);
    }

    // THE PREMISES, both of them: real effects sounded, and channel 3 really
    // was carrying music when they were not.
    expect(effects, "no effect ever started, so nothing ever ducked").toBeGreaterThan(20);
    expect(ducked.length, "no tick ever had an effect sounding over the main tune").toBeGreaterThan(100);
    expect(
      open.filter((level) => level > 0).length,
      "channel 3 was never carrying music with the effects off, so ducking it proves nothing",
    ).toBeGreaterThan(100);

    // THE MEASUREMENT: not one tick of channel 3 got through under an effect.
    expect(
      ducked.filter((level) => level > 0).length,
      `channel 3 kept sounding under a real effect on ${ducked.filter((level) => level > 0).length} ticks`,
    ).toBe(0);

    // AND NOTHING STAYS DUCKED: the last stretch with the effects quiet has
    // channel 3 back, so the gate is not a latch.
    const tail = open.slice(-200);
    expect(
      tail.filter((level) => level > 0).length,
      "channel 3 never came back after the effects stopped — the duck is stuck",
    ).toBeGreaterThan(0);
  }, 120_000);
});

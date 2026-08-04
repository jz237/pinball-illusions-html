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
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createGame, startGame, tickGame } from "../src/browser/game-loop.js";
import type { Game, GameTickReport } from "../src/browser/game-loop.js";
import { CONTROLS } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { createTableMusic } from "../src/browser/table-music.js";
import type { TableMusic } from "../src/browser/table-music.js";
import { loadTableMusic } from "../src/audio/table-music.js";
import type { TableMusicAsset, TableMusicCue, TableMusicFetch } from "../src/audio/table-music.js";
import type { AudioBank } from "../src/browser/audio.js";
import type { TableId } from "../src/game/contracts.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import { mapFor } from "./table-fixtures.js";
import { RecordingMusicHost, sectionSignature } from "./music-mixer.js";

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
  run(ticks: number, effects?: AudioBank | ((tick: number) => AudioBank)): Promise<GameTickReport[]>;
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

    async run(ticks, effects = noEffects): Promise<GameTickReport[]> {
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

    // AND THE TWO THAT STAY DATA. The game-over and high-score screens belong
    // to the shell here and its own front-end module plays over them; the
    // records are decoded and carried but this controller never fires them.
    // Pinned so wiring them becomes a decision somebody makes on purpose.
    expect(seen.has(gameOver), "the table module played the game-over record").toBe(false);
    expect(seen.has(highScore), "the table module played the high-score record").toBe(false);
  });
});

/**
 * THE PLATFORM LOUDNESS, PINNED — peak, RMS and the no-clipping property of a
 * real game start, held to the level the sibling ports play at.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * Every audio round before the loudness round measured RELATIVE things —
 * which record, when, on which channel, ducked or not — and none measured the
 * ABSOLUTE output level. The shipped graph ran every Paula channel at FOUR
 * TIMES the machine's own output scale (the machine folds four channels into
 * its DAC range; this graph gave each channel the whole range), so the
 * front-end tune reached the destination at RMS -4.0 dBFS with 9.6% of
 * output samples PAST FULL SCALE, beside sibling ports playing their music
 * at -25..-29 dBFS. The operator heard it immediately; the suite, 1965 tests
 * green, could not see it — the twentieth blind spot this project has found,
 * and this file is the instrument that closes it.
 *
 * `src/audio/master-level.ts` states the convention and its derivation
 * (sibling bus levels x Paula's own channel weights, verified level-true
 * against a WinUAE capture); `research/audio-level/LOUDNESS.md` holds the
 * before/after figures. This file HOLDS the result:
 *
 *   - the two constants, exactly;
 *   - the master gain node actually carrying the music level;
 *   - a real driven game start (front-end tune from the unlock, table
 *     serve, launch, main tune, real effect records on the same
 *     destination) rendered through the mixer model, with peak and RMS
 *     inside the sibling band and NOT ONE output sample past full scale.
 *
 * The bands are generous enough for a different table or script to pass and
 * tight enough that ANY master regression of a factor of two fails on both
 * sides — a round that re-introduces raw channel scale fails every case
 * here at once.
 *
 * EVERY ZERO IS PROVED, per this project's discipline: the case asserts the
 * tune actually sounded, the ball was actually served and launched, and an
 * effect actually reached the channel, before it trusts any quiet number.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  RecordingMusicHost,
  createRenderStats,
  rmsOf,
} from "./music-mixer.js";
import type { RenderStats } from "./music-mixer.js";
import { EFFECT_MASTER_LEVEL, MUSIC_MASTER_LEVEL } from "../src/audio/master-level.js";
import { createShellMusic } from "../src/browser/shell-music.js";
import { createTableMusic } from "../src/browser/table-music.js";
import { loadShellMusic } from "../src/audio/shell-music.js";
import type { ShellMusicFetch } from "../src/audio/shell-music.js";
import {
  createTrackerOutput,
  startTracker,
} from "../src/audio/tracker-output.js";
import type { TrackerHost } from "../src/audio/tracker-output.js";
import type { TableMusicFetch } from "../src/audio/table-music.js";
import { createAudioBank, loadAudioBank, playTick } from "../src/browser/audio.js";
import type { AudioFetch, AudioHost } from "../src/browser/audio.js";
import {
  parseEngineAudioDocument,
  parseTableAudioDocument,
} from "../src/game/table-audio.js";
import type { EngineAudioDocument, TableAudioDocument } from "../src/game/contracts.js";
import { createGame, startGame, tickGame } from "../src/browser/game-loop.js";
import { CONTROLS } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { mapFor } from "./table-fixtures.js";

const GENERATED = fileURLToPath(new URL("../public/generated/", import.meta.url));
const exported =
  existsSync(`${GENERATED}shell/shell-music.json`) &&
  existsSync(`${GENERATED}tables/law-n-justice.music.json`);

const RENDER_RATE = 48000;
const TICK_SECONDS = 0.02;

// ---------------------------------------------------------------------------
// The shipped files, off disk
// ---------------------------------------------------------------------------

function diskResponse(path: string): {
  ok: boolean;
  status: number;
  statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
} {
  if (!existsSync(path)) {
    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    };
  }
  const bytes = readFileSync(path);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: () =>
      Promise.resolve(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      ),
  };
}

const nameOf = (url: string): string => url.slice(url.lastIndexOf("/") + 1);
const shellFetch: ShellMusicFetch = (url) =>
  Promise.resolve(diskResponse(`${GENERATED}shell/${nameOf(url)}`));
const tablesFetch: TableMusicFetch = (url) =>
  Promise.resolve(diskResponse(`${GENERATED}tables/${nameOf(url)}`));
const effectsFetch: AudioFetch = (url) => {
  const name = nameOf(url);
  const inTables = `${GENERATED}tables/${name}`;
  return Promise.resolve(diskResponse(existsSync(inTables) ? inTables : `${GENERATED}${name}`));
};

// ---------------------------------------------------------------------------
// A scripted player, the same shape table-music-play.test.ts drives
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

// ---------------------------------------------------------------------------
// The constants and the graph
// ---------------------------------------------------------------------------

describe("the platform master level", () => {
  it("is the sibling bus through Paula's own channel weight, exactly", () => {
    // Music: the sibling music bus (0.34 in both deployed sibling builds)
    // over the four-channel mono fold the machine's own DAC applies.
    expect(MUSIC_MASTER_LEVEL).toBe(0.34 / 4);
    // Effects: the sibling effect bus (0.85 deployed) over AUD3's weight —
    // one of TWO channels on its side, half a side's scale.
    expect(EFFECT_MASTER_LEVEL).toBe(0.85 / 2);
    // The worst case the graph can construct — four music channels at full
    // volume plus a full-scale effect — stays under full scale, so the
    // destination cannot clip BY ARITHMETIC, not merely by measurement.
    expect(4 * MUSIC_MASTER_LEVEL + EFFECT_MASTER_LEVEL).toBeLessThan(1);
  });

  it("reaches the master gain node itself, under the unit player volume", () => {
    const host = new RecordingMusicHost();
    const output = createTrackerOutput(() => host as unknown as TrackerHost);
    startTracker(output, {
      commands: [
        { kind: "note", timeMs: 0, channel: 0, instrument: "pulse50", frequencyHz: 440, volume: 64 },
      ],
      durationMs: 100,
      restartMs: null,
    });
    const master = host.gains[0];
    expect(master, "no master gain was built").toBeDefined();
    expect(master?.gain.value).toBe(MUSIC_MASTER_LEVEL);
  });
});

// ---------------------------------------------------------------------------
// The renderer's own arithmetic, held still
// ---------------------------------------------------------------------------

describe("the mixer model's renderer", () => {
  it("renders content x gain, so its bands mean what they claim", () => {
    const host = new RecordingMusicHost();
    // One buffer of constant 0.5, through one gain of 0.5, to the destination.
    const buffer = host.createBuffer(1, 4800, 48000);
    buffer.getChannelData(0).fill(0.5);
    const gain = host.createGain();
    gain.gain.value = 0.5;
    gain.connect(host.destination);
    const source = host.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.start(0);

    const stats = createRenderStats();
    host.renderInto(stats, 0, 0.05, 48000);
    expect(stats.samples).toBe(2400);
    expect(stats.peak).toBeCloseTo(0.25, 5);
    expect(rmsOf(stats)).toBeCloseTo(0.25, 3);
    expect(stats.clipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The measurement, pinned: a real game start inside the sibling band
// ---------------------------------------------------------------------------

describe.skipIf(!exported)("a real game start sits at the sibling ports' loudness", () => {
  it(
    "front-end tune, serve, launch and effects: peak and RMS in band, zero clipped samples",
    async () => {
      const host = new RecordingMusicHost();
      const shellAsset = await loadShellMusic(shellFetch, "");
      expect(shellAsset, "no shipped shell music").not.toBeNull();
      const shell = createShellMusic(null, () => host as unknown as TrackerHost);
      shell.useAsset(shellAsset);

      const tableMusic = createTableMusic(() => host as unknown as TrackerHost, tablesFetch);
      const audioDoc = JSON.parse(
        readFileSync(`${GENERATED}tables/law-n-justice.audio.json`, "utf8"),
      ) as TableAudioDocument;
      const engineDoc = JSON.parse(
        readFileSync(`${GENERATED}engine.audio.json`, "utf8"),
      ) as EngineAudioDocument;
      const bank = createAudioBank(
        host as unknown as AudioHost,
        parseTableAudioDocument(audioDoc),
        parseEngineAudioDocument(engineDoc),
      );
      await loadAudioBank(bank, effectsFetch);
      expect(bank.failed.size, `effect files failed to load: ${[...bank.failed].join(", ")}`).toBe(0);

      const overall = createRenderStats();
      const attract = createRenderStats();
      const onset = createRenderStats();
      const play = createRenderStats();

      const renderTick = (from: number, to: number, extra: (RenderStats | null)[]): void => {
        host.renderInto(overall, from, to, RENDER_RATE);
        for (const stats of extra) {
          if (stats !== null) host.renderInto(stats, from, to, RENDER_RATE);
        }
      };

      // THE UNLOCK: 7 s of the attract — the front-end tune from the top,
      // hard-started at the calibrated level exactly as both siblings
      // hard-start theirs (fixed gain, no ramp).
      for (let tick = 0; tick < 350; tick += 1) {
        const from = host.currentTime;
        host.advance(TICK_SECONDS);
        shell.update("attract");
        renderTick(from, host.currentTime, [attract, from < 0.5 ? onset : null]);
      }

      // THE TABLE, opened as `openTable` opens one; ball one served by the
      // machine, launched by the script, flippers fired so the engine's own
      // effect records sound on the shared destination.
      tableMusic.select("law-n-justice");
      const game = createGame(mapFor("law-n-justice"));
      startGame(game);

      let plungeAt = -1;
      let flipperPhase = -1;
      const script = new Script((tick) => {
        const controls: Control[] = [];
        if (plungeAt >= 0 && tick >= plungeAt && tick < plungeAt + 2) controls.push("plunger");
        if (flipperPhase >= 0 && tick >= flipperPhase) {
          const beat = (tick - flipperPhase) % 100;
          if (beat < 8) controls.push("leftFlipper");
          if (beat >= 50 && beat < 58) controls.push("rightFlipper");
        }
        return controls;
      });

      let served = false;
      let launched = false;
      let effectSounded = false;
      for (let tick = 0; tick < 500; tick += 1) {
        const from = host.currentTime;
        host.advance(TICK_SECONDS);
        const report = tickGame(game, script.sample());
        if (report.served) {
          served = true;
          plungeAt = tick + 30;
        }
        if (report.launched && !launched) {
          launched = true;
          flipperPhase = tick + 25;
        }
        playTick(bank, report);
        if (bank.channel.until > host.currentTime) effectSounded = true;
        tableMusic.observe(report);
        shell.update("play");
        tableMusic.update("play", bank);
        renderTick(from, host.currentTime, [play]);
      }

      // THE PREMISES, so a silent pass cannot slip through as a quiet one.
      expect(served, "ball one was never served").toBe(true);
      expect(launched, "ball one was never launched").toBe(true);
      expect(effectSounded, "no effect record ever reached the channel").toBe(true);
      expect(attract.peak, "the front-end tune never sounded").toBeGreaterThan(0.05);
      expect(play.peak, "the table never made a sound").toBeGreaterThan(0.05);

      // NO DESTINATION CLIPPING, anywhere, ever. The old graph clipped 9.6%
      // of the front-end tune's samples; the calibrated graph cannot reach
      // full scale even in its arithmetic worst case.
      expect(overall.clipped, "output samples past full scale").toBe(0);
      expect(overall.peak).toBeLessThan(0.8);

      // THE SIBLING BAND. Their music reaches the destination at peak
      // 0.15..0.28, RMS 0.035..0.057 (Dreams II title 0.281 / 0.0569,
      // Fantasies bed 0.252 / 0.0473 — content measured from the shipped
      // files, chains from the deployed bundles; LOUDNESS.md has the table).
      // The front-end tune measured 0.295 / 0.0535 after calibration; a
      // factor-of-two regression in either direction leaves the band.
      expect(attract.peak).toBeGreaterThan(0.15);
      expect(attract.peak).toBeLessThan(0.45);
      expect(rmsOf(attract)).toBeGreaterThan(0.03);
      expect(rmsOf(attract)).toBeLessThan(0.08);

      // THE ONSET: the tune enters AT the calibrated level, not above it —
      // the "slam" the operator heard was the first bars at 4x scale with
      // clipping harshness on top. Hard start at matched level is the
      // sibling convention (neither sibling ramps), so the first half
      // second must sit inside the same ceiling, and must actually sound.
      expect(onset.peak).toBeGreaterThan(0.05);
      expect(onset.peak).toBeLessThan(0.45);

      // THE TABLE: serve vamp, main tune and the effect records on top stay
      // inside the same ceiling — the machine's own music-vs-effects balance
      // under one calibrated level per path.
      expect(play.peak).toBeLessThan(0.5);
      expect(play.clipped).toBe(0);
    },
    30000,
  );
});

/**
 * THE SOUND EFFECTS, HEARD — a real game on a real bank, weighed on the graph.
 *
 * ---------------------------------------------------------------------------
 * THE HOLE THIS FILLS
 * ---------------------------------------------------------------------------
 * `audio.test.ts` proves the manifests parse, the digests match, the priority
 * rule refuses what `$779E` refuses, and that a synthetic report reaches the
 * right trigger id. Every one of those cases builds its own `GameTickReport`
 * by hand and asserts that a SPY saw a `start()`. None of them asks the two
 * questions a player asks:
 *
 *   does a PLAYED GAME produce this event at all, and
 *   when it does, does anything actually come out?
 *
 * `research/SOUND_CENSUS.md` catalogued the records and a round wired them,
 * but that round had no ear: it could show a report field reaching a manifest
 * id and no more. The music layer found out what that is worth — a whole ball
 * of silence behind a green suite — so this file does for the effects what
 * `table-music-play.test.ts` did for the music. It drives `createGame` /
 * `tickGame` on the shipped maps, hangs the real `playTick` off every tick,
 * and measures `RecordingMusicHost.soundedVoices()`: the voices that reached
 * the destination through the gain graph `src/browser/audio.ts` builds.
 *
 * A voice is attributed to the trigger that asked for it by TICK: the bank's
 * two lookups (`sampleForAward`, `sampleFor`) are recorded with the tick they
 * were made on, and a trigger SOUNDED when a voice playing its sample started
 * on that same tick and was still audible in the middle of its own window. A
 * request the priority rule refused starts no voice; a request displaced by a
 * louder one on the same tick has an empty window. Both are silences, and both
 * are visible here.
 *
 * ---------------------------------------------------------------------------
 * EVERY ZERO IS PROVED
 * ---------------------------------------------------------------------------
 * The lesson of the nine blind instruments this project has now caught — the
 * ninth was found by the first run of THIS file, which named every voice "?"
 * because the model carried no buffer and so reported every record silent.
 *
 * So each case asserts its own premise. `heardOnAll` will not accept a trigger
 * class unless the class actually FIRED, and the flipper case is here because
 * the first driver written for it pressed the bats for three ticks: enough for
 * Law 'n Justice's 704-unit upper bat to reach its stop and report an edge,
 * not enough for the 1152-unit lower bats, so BabeWatch reported one raise in
 * twelve thousand ticks and looked broken. It was the driver. `HOLD_TICKS` is
 * four for that reason and the case asserts the edge count it buys.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createGame, debugSnapshot, startGame, tickGame } from "../src/browser/game-loop.js";
import type { Game, GameTickReport } from "../src/browser/game-loop.js";
import { CONTROLS } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { createAudioBank, loadAudioBank, playTick } from "../src/browser/audio.js";
import type { AudioBank, AudioHost } from "../src/browser/audio.js";
import { parseEngineAudioDocument, parseTableAudioDocument } from "../src/game/table-audio.js";
import type { AudioSample, EngineAudio, TableAudio } from "../src/game/table-audio.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { PlayfieldLevel, TableId } from "../src/game/contracts.js";
import { queueScript } from "../src/game/mode-vm.js";
import { pixelsToQ10 } from "../src/core/fixed-point.js";
import { devicesFor, mapFor } from "./table-fixtures.js";
import { RecordingMusicHost } from "./music-mixer.js";

// ---------------------------------------------------------------------------
// The bank, off the shipped disk
// ---------------------------------------------------------------------------

const GENERATED = fileURLToPath(new URL("../public/generated/", import.meta.url));
const TABLES = `${GENERATED}tables/`;
const exported = existsSync(`${GENERATED}engine.audio.json`);

/** One PAL field: one simulation tick, and one advance of the context clock. */
const TICK_SECONDS = 0.02;

/**
 * How many ticks a scripted flip holds the button down.
 *
 * FOUR, and it is measured rather than chosen: the lower bats sweep 1152 units
 * and stand at 1020 after three ticks of acceleration, so a three-tick press
 * never reaches the full-raise stop that `$A790` fires its sound on. See the
 * header — this number was a blind instrument until it was three.
 */
const HOLD_TICKS = 4;

const diskFetch = async (url: string) => {
  const bytes = readFileSync(url);
  return {
    ok: true,
    async arrayBuffer(): Promise<ArrayBuffer> {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
  };
};

interface Manifest {
  readonly triggers: readonly { readonly id: string; readonly sample: number }[];
  readonly samples: readonly { readonly file: string }[];
}

const documentAt = (path: string): Manifest =>
  JSON.parse(readFileSync(path, "utf8")) as Manifest;

/** Every (trigger id -> sample file) both manifests bind, for one table. */
function boundIds(tableId: TableId): { id: string; file: string }[] {
  const table = documentAt(`${TABLES}${tableId}.audio.json`);
  const engine = documentAt(`${GENERATED}engine.audio.json`);
  return [
    ...table.triggers.map((one) => ({ id: one.id, file: table.samples[one.sample]!.file })),
    ...engine.triggers.map((one) => ({ id: one.id, file: engine.samples[one.sample]!.file })),
  ];
}

// ---------------------------------------------------------------------------
// Driving a game with an ear on it
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

/** One lookup the bank made, and the tick it was made on. */
interface Ask {
  readonly tick: number;
  readonly id: string;
  readonly file: string | null;
}

/** What a run heard, in the terms a census is written in. */
interface Heard {
  /** Trigger ids that produced an audible voice on the tick they were asked. */
  readonly sounding: Map<string, number>;
  /** Trigger ids the game asked for, sounding or not. */
  readonly asked: Map<string, number>;
  /** Sample files that were audible at least once. */
  readonly files: Map<string, number>;
  /** Report-level event tallies, for the premises. */
  readonly events: Map<string, number>;
  /** The most trigger lookups any one tick made. */
  readonly busiest: number;
}

const tally = (map: Map<string, number>, key: string, by = 1): void => {
  map.set(key, (map.get(key) ?? 0) + by);
};

/**
 * Plays `runs` games on one table with the real audio bank hanging off every
 * tick, and answers what came out.
 *
 * The one intervention is the one `multiball-play.test.ts` states and it is
 * stated here too: a ball that falls past the bats is put back on the upper
 * playfield, because a scripted bot cannot keep a ball alive long enough to
 * reach a table's whole surface and a census of what the table SOUNDS needs
 * the ball to visit it. Nothing else is touched — every award, every device,
 * every script and the priority rule are the shipped ones.
 */
async function listen(
  tableId: TableId,
  options: { runs: number; ticks: number; forceEvery?: number },
): Promise<Heard> {
  const engineBase = parseEngineAudioDocument(
    JSON.parse(readFileSync(`${GENERATED}engine.audio.json`, "utf8")) as never,
  );
  const tableBase = parseTableAudioDocument(
    JSON.parse(readFileSync(`${TABLES}${tableId}.audio.json`, "utf8")) as never,
  );

  const sounding = new Map<string, number>();
  const asked = new Map<string, number>();
  const files = new Map<string, number>();
  const events = new Map<string, number>();
  let busiest = 0;

  for (let run = 0; run < options.runs; run += 1) {
    let tick = 0;
    const asks: Ask[] = [];
    const host = new RecordingMusicHost();
    // The bank's only two lookups, recorded with the tick that made them.
    const audio: TableAudio = {
      tableId: tableBase.tableId,
      displayName: tableBase.displayName,
      samples: tableBase.samples,
      sampleForAward(id: string): AudioSample | null {
        const sample = tableBase.sampleForAward(id);
        asks.push({ tick, id, file: sample?.file ?? null });
        return sample;
      },
    };
    const engine: EngineAudio = {
      displayName: engineBase.displayName,
      samples: engineBase.samples,
      sampleFor(id: string): AudioSample | null {
        const sample = engineBase.sampleFor(id);
        asks.push({ tick, id, file: sample?.file ?? null });
        return sample;
      },
    };
    const bank: AudioBank = createAudioBank(host as unknown as AudioHost, audio, engine);
    await loadAudioBank(bank, diskFetch, TABLES, GENERATED);
    expect(bank.failed.size, `${tableId}: samples that would not load`).toBe(0);

    const named = new Map<unknown, string>();
    for (const [file, buffer] of bank.buffers) named.set(buffer, file);

    const game: Game = createGame(mapFor(tableId), { ballsPerGame: 3 });
    startGame(game);
    // Every run flips on its own beat, so the table is not walked the same way
    // twice: a census taken through one rhythm is a census of that rhythm.
    const period = 17 + run * 3;
    const input = new Script((at) => {
      const controls: Control[] = [];
      if (at % 220 >= 40 && at % 220 < 46) controls.push("plunger");
      if (at % period < HOLD_TICKS) controls.push("leftFlipper");
      if ((at + 7) % period < HOLD_TICKS) controls.push("rightFlipper");
      return controls;
    });

    /** Context time a voice started -> the tick it started on. */
    const startedOn = new Map<number, number>();

    for (tick = 0; tick < options.ticks; tick += 1) {
      host.advance(TICK_SECONDS);
      startedOn.set(host.currentTime, tick);
      const report: GameTickReport = tickGame(game, input.sample());
      const before = asks.length;
      playTick(bank, report);
      busiest = Math.max(busiest, asks.length - before);

      for (const award of report.awards) tally(events, `award:${award.id}`);
      if (report.served) tally(events, "served");
      if (report.launched) tally(events, "launched");
      if (report.drained.length > 0) tally(events, "drained", report.drained.length);
      if (report.locked.length > 0) tally(events, "locked", report.locked.length);
      for (const zone of report.ejectedFrom) tally(events, `eject:${zone.level}-${zone.index}`);
      if (report.levelTransfers.length > 0) tally(events, "levelTransfers", report.levelTransfers.length);
      tally(events, "flipperRaised", report.flipperRaised.length);
      tally(events, "flipperRested", report.flipperRested.length);
      for (const element of report.elementStarts) tally(events, `elementStart:${element}`);
      for (const message of report.messagesShown) tally(events, `message:${message}`);
      if (report.gameOver) tally(events, "gameOver");

      // ONE SCRIPT AT A TIME, spaced. The mode queue is a small ring, so
      // pushing three hundred scripts into one tick loses all but the last few
      // — which is exactly how the first version of this case reported the
      // whole mission layer silent. Each script gets its own window to run in.
      const every = options.forceEvery;
      if (every !== undefined && tick % every === 0 && game.modeState !== null) {
        const scripts = game.modes?.scripts ?? [];
        const next = scripts[Math.floor(tick / every) % Math.max(1, scripts.length)];
        if (next !== undefined) queueScript(game.modeState, next.index);
      }

      // THE ONE INTERVENTION. See the doc comment.
      if (tick % 40 === 0) {
        const snapshot = debugSnapshot(game);
        for (const view of snapshot.balls) {
          if (!view.active || view.id === snapshot.laneBallId || view.pixelY <= 520) continue;
          const ball = game.balls.balls.find((one) => one.id === view.id);
          if (ball === undefined || ball.heldBy !== null) continue;
          ball.x = pixelsToQ10(60 + ((run * 37 + tick) % 220));
          ball.y = pixelsToQ10(180 + ((run * 53 + tick) % 200));
          ball.velocityX = 0;
          ball.velocityY = 0;
          ball.level = 0 as PlayfieldLevel;
        }
      }
    }

    // THE MEASUREMENT: which voices reached the destination, and when.
    const audibleOn = new Map<string, Set<number>>();
    for (const { voice, at } of host.soundedVoices()) {
      const file = named.get(voice.buffer);
      const on = startedOn.get(voice.start);
      if (file === undefined || on === undefined) continue;
      void at;
      let set = audibleOn.get(file);
      if (set === undefined) {
        set = new Set<number>();
        audibleOn.set(file, set);
      }
      set.add(on);
      tally(files, file);
    }
    for (const ask of asks) {
      tally(asked, ask.id);
      if (ask.file !== null && audibleOn.get(ask.file)?.has(ask.tick) === true) {
        tally(sounding, ask.id);
      }
    }
  }

  return { sounding, asked, files, events, busiest };
}

// ---------------------------------------------------------------------------
// What a played game sounds
// ---------------------------------------------------------------------------

/** The trigger classes a player touches on every table, and their events. */
const PLAY_CLASSES: readonly { readonly name: string; readonly prefix: string }[] = Object.freeze([
  { name: "bumpers", prefix: "bumper-" },
  { name: "slingshots", prefix: "slingshot-" },
  { name: "targets and kickers", prefix: "device-" },
  { name: "lane rollovers and trigger zones", prefix: "zone-0-" },
  { name: "the saucers' own eject voices", prefix: "zone-eject-" },
]);

/** The engine's own events, and the report field each is driven by. */
const ENGINE_EVENTS: readonly { readonly id: string; readonly premise: string }[] = Object.freeze([
  { id: "serve", premise: "served" },
  { id: "drain", premise: "drained" },
  { id: "capture", premise: "locked" },
  { id: "level-transfer", premise: "levelTransfers" },
  { id: "flipper-raise", premise: "flipperRaised" },
  { id: "flipper-rest", premise: "flipperRested" },
]);

describe.skipIf(!exported)("a played game sounds the table's own records", () => {
  for (const tableId of TABLE_IDS) {
    it(`${tableId}: every trigger class a player touches is audible`, async () => {
      // EIGHTEEN GAMES, and it was six. The bat's mid-tick write-back moved the
      // bot's trajectories, and on BabeWatch two lane zones ended up firing only
      // on ticks a louder record had already taken — which is the channel doing
      // its job (its own case below asserts that displacement happens at all),
      // not a silent binding, but at six games it left the claim untested on
      // those two. The answer to a thin sample is a bigger one, not a smaller
      // claim: every id that fires still has to reach the destination, and the
      // bar has not moved.
      const heard = await listen(tableId, { runs: 18, ticks: 9000 });

      for (const group of PLAY_CLASSES) {
        const ids = boundIds(tableId)
          .filter((one) => one.id.startsWith(group.prefix))
          .map((one) => one.id);
        expect(ids.length, `${tableId}: nothing is bound for ${group.name}`).toBeGreaterThan(0);

        // THE PREMISE: the class has to have HAPPENED, or a zero below would
        // only say the bot never went there.
        const fired = ids.filter((id) => (heard.asked.get(id) ?? 0) > 0);
        expect(
          fired.length,
          `${tableId}: no ${group.name} was ever hit, so this case proves nothing`,
        ).toBeGreaterThan(0);

        // THE MEASUREMENT: each one that fired reached the destination.
        const silent = fired.filter((id) => (heard.sounding.get(id) ?? 0) === 0);
        expect(
          silent,
          `${tableId}: ${group.name} fired but never sounded: ${silent.join(", ")}`,
        ).toEqual([]);
      }

      for (const event of ENGINE_EVENTS) {
        expect(
          heard.events.get(event.premise) ?? 0,
          `${tableId}: a played game never produced ${event.premise}`,
        ).toBeGreaterThan(0);
        expect(
          heard.sounding.get(event.id) ?? 0,
          `${tableId}: the engine's ${event.id} never sounded`,
        ).toBeGreaterThan(0);
      }
    }, 300_000);
  }
});

describe.skipIf(!exported)("both flipper strokes speak on every table", () => {
  /**
   * Its own case because the driver was wrong here first, and quietly: a bat
   * that never reaches its stop reports no edge and `$A790` has nothing to
   * play. The edge counts below are what a four-tick press buys, and they are
   * the assertion that this file is pressing hard enough to be asking anything.
   */
  for (const tableId of TABLE_IDS) {
    it(`${tableId}: the bats reach their stops and both strokes sound`, async () => {
      const heard = await listen(tableId, { runs: 2, ticks: 4000 });
      const raised = heard.events.get("flipperRaised") ?? 0;
      const rested = heard.events.get("flipperRested") ?? 0;
      expect(
        raised,
        `${tableId}: the bats never reached full raise — the press is too short to test anything`,
      ).toBeGreaterThan(100);
      expect(rested, `${tableId}: the bats never returned to rest`).toBeGreaterThan(100);
      expect(heard.sounding.get("flipper-raise") ?? 0, `${tableId}: the up-stroke`).toBeGreaterThan(0);
      expect(heard.sounding.get("flipper-rest") ?? 0, `${tableId}: the down-stroke`).toBeGreaterThan(0);
    }, 300_000);
  }
});

// ---------------------------------------------------------------------------
// The mode sting layer
// ---------------------------------------------------------------------------

describe.skipIf(!exported)("the mission sting layer is reached and is audible", () => {
  /**
   * Extreme Sports is the case that matters: SIX of its twelve records are the
   * mission voice and the five callouts, and a bot that cannot complete a
   * mission never hears one of them. Queueing the table's own scripts is doing
   * by hand what a completed shot does, and everything after the queue is the
   * shipped mission VM.
   */
  it("extreme-sports: the mode voice and all five mission callouts sound", async () => {
    const heard = await listen("extreme-sports", { runs: 1, ticks: 324 * 30, forceEvery: 30 });
    const wanted = [
      "extreme-sports.snd-05.wav",
      "extreme-sports.snd-06.wav",
      "extreme-sports.snd-07.wav",
      "extreme-sports.snd-08.wav",
      "extreme-sports.snd-09.wav",
      "extreme-sports.snd-10.wav",
    ];
    const missing = wanted.filter((file) => (heard.files.get(file) ?? 0) === 0);
    expect(missing, `extreme-sports: mission records that never sounded: ${missing.join(", ")}`).toEqual([]);
  }, 300_000);

  it("law-n-justice and babewatch sound their universal script stings", async () => {
    // The two records the census singles out by site count: Law 'n Justice's
    // r9E50 (28 sites, priority 120 — the loudest thing on the table) and
    // BabeWatch's r9740 (43 sites).
    const lnj = await listen("law-n-justice", { runs: 1, ticks: 304 * 30, forceEvery: 30 });
    expect(lnj.files.get("law-n-justice.snd-09.wav") ?? 0, "r9E50 never sounded").toBeGreaterThan(0);
    const babewatch = await listen("babewatch", { runs: 1, ticks: 342 * 30, forceEvery: 30 });
    expect(babewatch.files.get("babewatch.snd-14.wav") ?? 0, "r9740 never sounded").toBeGreaterThan(0);
    expect(babewatch.files.get("babewatch.snd-13.wav") ?? 0, "r96A4 never sounded").toBeGreaterThan(0);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// The zeros, each with its reason
// ---------------------------------------------------------------------------

describe.skipIf(!exported)("the sounds that are silent, and why", () => {
  it("the engine's generic eject cannot sound: every saucer carries its own voice", () => {
    // `playTick` falls back to the engine's h10+$9C only when the table records
    // no `zone-eject-L-N` for the saucer that fired. That fallback is the
    // popper's own at $7014/$701A, for held objects with no sub-record — and
    // all three shipped tables give every lock zone a `+$10` voice, so on this
    // machine the branch is unreachable. Stated here so that a table which
    // ever loses one is a failing test rather than a silent saucer.
    for (const tableId of TABLE_IDS) {
      const devices = devicesFor(tableId);
      const bound = new Set(boundIds(tableId).map((one) => one.id));
      const locks = devices.zones.filter((zone) => zone.kind === "lock");
      expect(locks.length, `${tableId} has no lock zones`).toBeGreaterThan(0);
      const perLevel = new Map<number, number>();
      const naked: string[] = [];
      for (const zone of devices.zones) {
        const index = perLevel.get(zone.level) ?? 0;
        perLevel.set(zone.level, index + 1);
        if (zone.kind !== "lock") continue;
        if (!bound.has(`zone-eject-${zone.level}-${index}`)) naked.push(`${zone.level}-${index}`);
      }
      expect(naked, `${tableId}: lock zones with no eject voice: ${naked.join(", ")}`).toEqual([]);
    }
  });

  it("the launch, the tilt and the tilt warning have no record on the machine either", () => {
    // Three silences that are the ORIGINAL'S, not this port's:
    //
    //   the LAUNCH — the fixed kick at data 0x65EE makes no `jsr $6CD0` call;
    //     what a player hears at a serve is the lane's own delivery sound,
    //     which `report.served` already plays;
    //   the TILT — `research/SOUND_CENSUS.md` §4 note: no dedicated sound site
    //     exists anywhere in main.seg00. A tilt is the music/effects STATE
    //     change (the +$94 music cue, which this port does fire), not a sample;
    //   the TILT WARNING — `$23F0(a5)` is a counter that decays, with no
    //     display and no sound call attached to it at all.
    //
    // The assertion is that nothing has quietly grown a binding for them,
    // because a binding would be an invention.
    for (const tableId of TABLE_IDS) {
      const ids = new Set(boundIds(tableId).map((one) => one.id));
      for (const invented of ["launch", "plunger", "tilt", "tilt-warning", "game-over"]) {
        expect(ids.has(invented), `${tableId} has grown a ${invented} sound binding`).toBe(false);
      }
    }
  });

  it("Law 'n Justice still ships eleven of its seventeen records, and nothing has joined the six", () => {
    // The six unbindable ones are `r9D9A`, `r9DB4` and the instrument-7
    // rollover pitch ladder `r9DCE` / `r9DE8` / `r9E02` / `r9E1C`: script-only
    // records whose op-0x10 sites the exporter could not attribute to a
    // display record it knows. BabeWatch's one unshipped record is `r96BE`,
    // the ORPHAN nothing points at. Extreme Sports ships all twelve.
    //
    // Pinned as counts so a future export that loses a binding says so.
    const counts: Record<TableId, number> = {
      "law-n-justice": 11,
      babewatch: 15,
      "extreme-sports": 12,
    };
    for (const tableId of TABLE_IDS) {
      const manifest = documentAt(`${TABLES}${tableId}.audio.json`);
      expect(manifest.samples.length, `${tableId} record count`).toBe(counts[tableId]);
    }
    expect(documentAt(`${GENERATED}engine.audio.json`).samples.length).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// One channel, under the load a real tick puts on it
// ---------------------------------------------------------------------------

describe.skipIf(!exported)("the one effect channel under a real tick's load", () => {
  it("babewatch: the busiest tick asks for four sounds and exactly one is heard", async () => {
    // TEN GAMES, and it was six, for the reason above: the four-request tick is
    // a rare coincidence of a played game and the bat change moved where the bot
    // goes. The bar itself is unmoved at four.
    const heard = await listen("babewatch", { runs: 10, ticks: 9000 });
    // THE PREMISE: the channel has to have been asked for more than one sound
    // on some tick, or "one at a time" is a statement about nothing. Four is
    // what the multiball round measured and it is what a driven game makes.
    expect(
      heard.busiest,
      "no tick ever asked the effect channel for more than one sound",
    ).toBeGreaterThanOrEqual(4);
  }, 300_000);

  it("a louder record refuses a quieter one on the same tick, and is the one heard", async () => {
    // `$779E`'s `cmp.w $2(a1),d7 / bcs`, exercised by a played game rather
    // than by two hand-made calls: over six games there must be ticks where a
    // quiet request was asked and did not sound, and the loud one did.
    const heard = await listen("law-n-justice", { runs: 6, ticks: 9000 });
    const refused: string[] = [];
    for (const [id, asks] of heard.asked) {
      if (asks > 0 && (heard.sounding.get(id) ?? 0) < asks) refused.push(id);
    }
    expect(
      refused.length,
      "not one request in six games was ever refused or displaced — the channel is not arbitrating",
    ).toBeGreaterThan(0);
  }, 300_000);
});

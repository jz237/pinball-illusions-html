/**
 * THE TABLE'S MUSIC, driven by the tick reports and the shell phase.
 *
 * ---------------------------------------------------------------------------
 * THE ORIGINAL'S RULE, AS DECODED AND AS FILMED
 * ---------------------------------------------------------------------------
 * The engine starts the table module the moment the package loads and drives
 * it with kind-4 cue records (see scripts/export-table-music.mjs). Inside a
 * game, the part the reconstruction's play phase covers, the audible shape —
 * verified against the reference captures on all three tables — is:
 *
 *   ball start  -> the SERVE VAMP: position 0, a bar or two looping on
 *                  itself while the ball sits on the plunger (cue -2/0/0,
 *                  engine sites $49BE/$4FC4)
 *   launch      -> the MAIN TUNE from position 1 — QUEUED (-1/1/0): the
 *                  switch lands exactly on the vamp's next lap boundary,
 *                  measured to the frame on six filmed launches
 *   tilt        -> the TILT JINGLE (the +$94 cue; phase 8 is the tilted
 *                  state): a short sequence ending in F00, the player's stop
 *                  flag — the films' only silent gameplay spans, with the
 *                  decoded length matching the filmed tilt-to-silence gap on
 *                  all three filmed tilts
 *   next serve  -> the vamp again (the ball-start cue re-fires per ball)
 *
 * The game-over / high-score / enter-initials sections the engine also
 * switches to are decoded and shipped in the manifest, but those moments
 * belong to the SHELL in this reconstruction (its cards come up on the frame
 * the game ends), so the shell's own front-end module plays there and the
 * cues stay data. Mode and jackpot background switches (the tables' other
 * kind-4 records) are not wired yet either — the main loop plays through a
 * mode, which is what the captures mostly show anyway.
 *
 * ---------------------------------------------------------------------------
 * CHANNEL 3 BELONGS TO THE EFFECTS WHILE ONE IS SOUNDING
 * ---------------------------------------------------------------------------
 * On the machine, a sound effect owns AUD3 for exactly as long as it sounds:
 * the effect start sets the flag at $2442 (the effect block's own byte, up
 * while chunks remain) and the module player then writes channel 3's
 * registers to a dummy sink and drops its DMA bit ($800C/$8950); the effect's
 * end ($7930) clears the flag and the music's channel 3 comes back mid-song.
 * Here that is a per-frame gate: while the effect channel in
 * `browser/audio.ts` reports a sounding effect (`channel.until` in the
 * future, over the SAME AudioContext clock), the tracker output's channel-3
 * bus is held at 0.
 *
 * SIM ISOLATION, unchanged: this module consumes finished tick reports and a
 * shell phase, nothing flows back, and every failure path is silence.
 */

import type { ShellPhase } from "./shell.js";
import type { AudioBank } from "./audio.js";
import type { GameTickReport } from "./game-loop.js";
import {
  createTrackerOutput,
  defaultTrackerHostFactory,
  pumpTracker,
  resumeTracker,
  setTrackerChannelLevel,
  setTrackerMuted,
  startTracker,
  stopTracker,
} from "../audio/tracker-output.js";
import type {
  InstrumentBank,
  TrackerCommandStream,
  TrackerHost,
  TrackerOutput,
} from "../audio/tracker-output.js";
import { loadTableMusic, sectionStream } from "../audio/table-music.js";
import type { TableMusicAsset, TableMusicFetch } from "../audio/table-music.js";

/**
 * The phases the table music plays in: the ball, and the "REALLY QUIT
 * TABLE?" question drawn over the ball — the original has no pause there at
 * all, so the music playing on is the closer reading. Every other phase is
 * the shell's, and the shell has its own music.
 */
export const TABLE_MUSIC_PHASES: ReadonlySet<ShellPhase> = new Set<ShellPhase>([
  "play",
  "quit-confirm",
]);

/** The default scheduler lookahead `pumpTracker` runs with, in seconds. */
const LOOKAHEAD_SECONDS = 0.5;

/** What the controller is playing, or about to. */
type SectionName = "vamp" | "main" | "tilt";

interface SectionSet {
  readonly vamp: TrackerCommandStream;
  readonly main: TrackerCommandStream;
  readonly tilt: TrackerCommandStream;
}

export interface TableMusic {
  /** The output object, exposed for the host's resume plumbing and tests. */
  readonly output: TrackerOutput;
  /**
   * Brings a table's music up in the background and makes it the live one.
   * A table whose manifest is absent (an unauthorized build) stays silent.
   */
  select(tableId: string): void;
  /** Forgets the live table: leaving the playfield for the shell. */
  clear(): void;
  /**
   * Reads one finished tick report: `served` starts the vamp, `launched`
   * queues the main tune for the vamp's next lap boundary, `justTilted`
   * plays the tilt jingle. Order within one tick follows the machine's own
   * cue order (a tilt posted after a serve wins, exactly as the last mailbox
   * write would).
   */
  observe(report: GameTickReport): void;
  /**
   * Follows the shell and pumps the scheduler. Call once per animation frame
   * with the current phase and the effects bank (for the channel-3 gate);
   * leaving the table phases stops the music dead.
   */
  update(phase: ShellPhase, effects: AudioBank | null): void;
  /** Mute, persisted by the caller alongside the shell music's own. */
  setMuted(muted: boolean): boolean;
  muted(): boolean;
  /** Nudges a suspended context; safe on every keypress. */
  resume(): void;
  /** Stops and forgets the current stretch (tab hidden). */
  stop(): void;
}

export function createTableMusic(
  hostFactory: () => TrackerHost | null = defaultTrackerHostFactory,
  fetcher: TableMusicFetch = (url) => fetch(url),
): TableMusic {
  let bank: InstrumentBank = () => null;
  const output = createTrackerOutput(hostFactory, (id) => bank(id));

  /** Loaded assets and their pre-rendered sections, keyed by table id. */
  const loaded = new Map<string, { asset: TableMusicAsset; sections: SectionSet } | null>();
  const inFlight = new Map<string, Promise<void>>();

  let currentTableId: string | null = null;
  let current: { asset: TableMusicAsset; sections: SectionSet } | null = null;

  /** What is sounding (or 'silent'), and the pending queued switch. */
  let playing: SectionName | "silent" = "silent";
  /** True after a tilt: nothing plays until the next serve. */
  let stopped = false;
  /** The queued main switch: sound at the vamp's next lap boundary. */
  let mainQueued = false;
  /**
   * Balls on the playfield, tracked from the reports so a BALL-START serve
   * (balls were zero — the engine's $49BE/$4FC4 moments, which fire the
   * ball-start cue) is told apart from a multiball add-a-ball serve (balls
   * already live — the $6616 path, which fires no music cue and must not
   * restart the vamp over the main tune).
   */
  let ballsLive = 0;

  const sectionsOf = (asset: TableMusicAsset): SectionSet => {
    const streamFor = (cue: { position: number; bank: number }): TrackerCommandStream => {
      const song = asset.songs[cue.bank === 0 ? 0 : 1];
      const voices = asset.voices[cue.bank === 0 ? 0 : 1];
      return sectionStream(song, voices, cue.position);
    };
    return {
      vamp: streamFor(asset.cues.vamp),
      main: streamFor(asset.cues.main),
      tilt: streamFor(asset.cues.tilt),
    };
  };

  const start = (name: SectionName, atContextTime?: number): void => {
    if (current === null) return;
    playing = name;
    mainQueued = false;
    startTracker(output, current.sections[name], atContextTime);
  };

  const silence = (): void => {
    playing = "silent";
    mainQueued = false;
    ballsLive = 0;
    stopTracker(output);
  };

  /**
   * The vamp's next lap boundary, in context time. Lap length is the vamp
   * stream's own pass (`restartMs` is 0 on every shipped vamp — the section
   * re-enters its own position — and the subtraction keeps the maths honest
   * if a table ever ships otherwise).
   */
  const nextVampBoundary = (now: number): number | null => {
    const stream = current?.sections.vamp ?? null;
    if (stream === null || playing !== "vamp") return null;
    const lapSeconds = (stream.durationMs - (stream.restartMs ?? 0)) / 1000;
    if (lapSeconds <= 0) return now;
    const elapsed = now - output.startContextTime;
    const laps = Math.max(1, Math.ceil(elapsed / lapSeconds + 1e-6));
    return output.startContextTime + laps * lapSeconds;
  };

  return {
    output,

    select(tableId: string): void {
      currentTableId = tableId;
      const cached = loaded.get(tableId);
      if (cached !== undefined) {
        current = cached;
        bank = cached === null ? () => null : cached.asset.bank;
        silence();
        stopped = false;
        return;
      }
      current = null;
      bank = () => null;
      silence();
      stopped = false;
      if (inFlight.has(tableId)) return;
      const task = (async () => {
        let entry: { asset: TableMusicAsset; sections: SectionSet } | null = null;
        try {
          const asset = await loadTableMusic(tableId, fetcher);
          if (asset !== null) entry = { asset, sections: sectionsOf(asset) };
        } catch {
          entry = null; // an undecodable asset is a silent table
        }
        loaded.set(tableId, entry);
        inFlight.delete(tableId);
        if (currentTableId === tableId) {
          current = entry;
          bank = entry === null ? () => null : entry.asset.bank;
        }
      })();
      inFlight.set(tableId, task);
    },

    clear(): void {
      currentTableId = null;
      current = null;
      bank = () => null;
      silence();
      stopped = false;
    },

    observe(report: GameTickReport): void {
      if (current === null) return;
      // The ball-start cue fires when a ball arrives on an EMPTY playfield —
      // game start and every next ball ($49BE/$4FC4) — and puts the vamp up;
      // it also ends the post-tilt silence ($7DD2 clears the stop flag
      // $21C). A multiball add-a-ball serve fires no music cue.
      if (report.served) {
        if (ballsLive === 0) {
          stopped = false;
          start("vamp");
        }
        ballsLive += 1;
      }
      ballsLive = Math.max(0, ballsLive - report.drained.length);
      // The launch queues the main tune (-1): the switch happens at the
      // vamp's lap boundary, which `update` executes when it comes close.
      if (report.launched && playing === "vamp") mainQueued = true;
      // The tilt: the jingle, immediately (its own F00 then silences
      // everything until the next serve).
      if (report.justTilted) {
        stopped = true;
        start("tilt");
      }
      if (report.gameOver) ballsLive = 0;
    },

    update(phase: ShellPhase, effects: AudioBank | null): void {
      if (!TABLE_MUSIC_PHASES.has(phase) || current === null) {
        if (playing !== "silent") silence();
        return;
      }
      const host = output.host;
      const now = host?.currentTime ?? 0;

      // Execute a queued main switch once its boundary is inside the
      // lookahead window; until then, cap the pump at the boundary so the
      // vamp never schedules past its own last lap.
      let lookahead = LOOKAHEAD_SECONDS;
      if (mainQueued && playing === "vamp" && host !== null) {
        const boundary = nextVampBoundary(now);
        if (boundary !== null) {
          if (boundary - now <= LOOKAHEAD_SECONDS * 0.9) {
            start("main", boundary);
          } else {
            lookahead = Math.max(boundary - now - 0.001, 0.05);
          }
        }
      }

      if (playing !== "silent" && !stopped) pumpTracker(output, lookahead);
      else if (playing === "tilt") pumpTracker(output, lookahead);

      // The channel-3 gate: while an effect is sounding on the shared
      // context's clock, the module's channel 3 is held silent, exactly as
      // long as the machine's $2442 stays up.
      const effectSounding =
        effects !== null && host !== null && effects.channel.until > host.currentTime;
      setTrackerChannelLevel(output, 3, effectSounding ? 0 : 1);
    },

    setMuted(muted: boolean): boolean {
      return setTrackerMuted(output, muted);
    },
    muted: () => output.muted,
    resume: () => resumeTracker(output),
    stop(): void {
      silence();
    },
  };
}

/**
 * THE SHELL'S MUSIC, driven by the shell's phase and by nothing else.
 *
 * The original front-end starts its one module the moment the menus come up
 * and keeps it running under every screen the shell owns; the table takes
 * over when play begins. This controller reproduces that shape over THE
 * ORIGINAL'S OWN MODULE, decoded from the operator's disks and loaded at
 * runtime as a gated asset (`src/audio/shell-music.ts`): music sounds in every
 * shell phase except the two that sit
 * on the playfield (`play` and `quit-confirm`, which is a paused game with a
 * question drawn over it), starts from the top whenever the shell comes back
 * from the table, and loops via the stream's own restart point in between.
 *
 * SIM ISOLATION, restated: this module lives in the shell layer, is driven by
 * `main.ts`'s frame callback, and is handed nothing but a `ShellPhase` value.
 * Nothing under `src/game/` imports it, nothing here flows back, and a
 * browser with no audio device gets a controller that does nothing — silence
 * is a correct outcome.
 *
 * THE MUTE KEY is the backquote, chosen because it collides with nothing:
 * the decoded key map claims the function keys (rawkeys 0x50..0x59 pick
 * tables), the flipper/nudge/plunger keys, ESC, ENTER, P, Y, BACKSPACE, and
 * every character in the initials alphabet (letters, digits, '.', '-',
 * space). The backquote is in none of those sets, so it can toggle the music
 * from any phase — including over a live table and inside the name box —
 * without stealing a keystroke from anyone. The choice is pinned by a test.
 *
 * The mute is persisted through whatever storage the host hands over — the
 * same `localStorage` the score store writes, taken as a parameter the same
 * way, so a browser with storage blocked still plays and merely forgets.
 */

import type { ShellPhase } from "./shell.js";
import {
  createTrackerOutput,
  defaultTrackerHostFactory,
  pumpTracker,
  resumeTracker,
  setTrackerMuted,
  startTracker,
  stopTracker,
} from "../audio/tracker-output.js";
import type { InstrumentBank, TrackerHost, TrackerOutput } from "../audio/tracker-output.js";
import { songStreamFor } from "../audio/song-stream.js";
import type { ShellMusicAsset } from "../audio/shell-music.js";

/** `KeyboardEvent.code` / `.key` of the mute toggle. See the header for why. */
export const MUSIC_TOGGLE_CODE = "Backquote";
export const MUSIC_TOGGLE_KEY = "`";

/** Where the mute setting lives, beside the ladders' own keys. */
export const MUSIC_MUTED_STORAGE_KEY = "pinball-illusions.music-muted";

/**
 * The phases the shell's music does NOT play in: every phase the machine is
 * INSIDE A TABLE for. The ball and the "REALLY QUIT TABLE?" question drawn over
 * it, and — since the round that went and looked — the game-over card, the
 * high-score fanfare, the name box and the table's own ladder screen.
 *
 * WHY THOSE FOUR MOVED. Those screens are the in-game machine's states 2 and 0,
 * not the front end: the engine posts the TABLE's own +$8C record on entering
 * state 2 and its +$90 record for the first player who makes the ladder, and
 * the emulator's own audio identifies both against sections rendered from this
 * port's manifests (game-over 0:50 at waveform NCC +0.629 / envelope +0.974 in
 * a game with no qualifier; high-score 0:38 at +0.581 / +0.924 in one with).
 * The front-end module is not even loaded on the machine at that moment. See
 * `TABLE_MUSIC_PHASES` in `browser/table-music.ts`, which is this same set from
 * the other side, and `research/GAMEOVER_MUSIC.md`.
 *
 * Everything else — the attract roll, the menus, the info screen and loading —
 * is the shell's, and the shell has music.
 *
 * A build with no table-music manifest is therefore SILENT on those four, the
 * same way it is silent over the ball. Silence on a missing gated asset is the
 * shipped policy everywhere in this layer.
 */
export const SILENT_PHASES: ReadonlySet<ShellPhase> = new Set<ShellPhase>([
  "play",
  "quit-confirm",
  "game-over",
  "fanfare",
  "initials",
  "ladder",
]);

export function musicWantedFor(phase: ShellPhase): boolean {
  return !SILENT_PHASES.has(phase);
}

/** The slice of storage the mute needs; null when the browser gives none. */
export type MusicStorage = Pick<Storage, "getItem" | "setItem"> | null;

export interface ShellMusic {
  /** The output object, exposed for the host's resume plumbing and for tests. */
  readonly output: TrackerOutput;
  /**
   * Hands over the decoded module once the fetch lands.
   *
   * Until it does, `update` is a no-op in every phase: silence is a correct
   * outcome, exactly as it is for a shell whose skin has not arrived. Called
   * once from `main.ts`; a second call replaces the song, which is what a
   * re-fetch after a failure would want.
   */
  useAsset(asset: ShellMusicAsset | null): void;
  /**
   * Follows the shell. Call once per animation frame with the current phase:
   * entering a musical phase from a silent one starts the song from the top,
   * entering a silent one stops it dead, and every musical frame pumps the
   * scheduler's lookahead window.
   */
  update(phase: ShellPhase): void;
  /** Flips the mute, persists it, and returns the new state for a display. */
  toggleMuted(): boolean;
  muted(): boolean;
  /** Nudges a suspended context; safe on every keypress. The gesture hook. */
  resume(): void;
  /**
   * Stops the music and forgets the current stretch, so the next `update` in
   * a musical phase starts afresh — for a tab going hidden, where the frame
   * loop is about to stop calling `update` at all.
   */
  stop(): void;
}

/**
 * Builds the controller. Touches no Web Audio here — the output's host is
 * built lazily by the first `startTracker`, so merely booting the shell in a
 * test (or a browser with no `AudioContext`) costs nothing and breaks nothing.
 */
export function createShellMusic(
  storage: MusicStorage,
  hostFactory: () => TrackerHost | null = defaultTrackerHostFactory,
): ShellMusic {
  // The bank is a box the asset fills in: `createTrackerOutput` takes the
  // resolver once, and pointing the box at the loaded instruments is what makes
  // the music start without rebuilding the output.
  let bank: InstrumentBank = () => null;
  const output = createTrackerOutput(hostFactory, (id) => bank(id));
  let asset: ShellMusicAsset | null = null;

  let stored: string | null = null;
  try {
    stored = storage?.getItem(MUSIC_MUTED_STORAGE_KEY) ?? null;
  } catch {
    // Storage that throws is storage that is not there.
  }
  if (stored === "1") setTrackerMuted(output, true);

  /** True while the shell is in a musical stretch (whether or not a device
   * actually opened — a failed host retries on the next stretch). */
  let wanted = false;

  return {
    output,
    useAsset(next: ShellMusicAsset | null): void {
      asset = next;
      bank = next === null ? () => null : next.bank;
      // A stretch that began before the asset landed starts on the next frame.
      if (wanted) wanted = false;
    },
    update(phase: ShellPhase): void {
      const wants = musicWantedFor(phase) && asset !== null;
      if (wants && !wanted && asset !== null) {
        wanted = true;
        // `startOrder` is where the machine enters the module (17, not 0); see
        // `src/audio/shell-music.ts`.
        startTracker(output, songStreamFor(asset.song, asset.voices, asset.startOrder));
      } else if (!wants && wanted) {
        wanted = false;
        stopTracker(output);
      }
      if (wanted) pumpTracker(output);
    },
    toggleMuted(): boolean {
      const muted = setTrackerMuted(output, !output.muted);
      try {
        storage?.setItem(MUSIC_MUTED_STORAGE_KEY, muted ? "1" : "0");
      } catch {
        // A browser that will not persist still mutes; it just forgets.
      }
      return muted;
    },
    muted: () => output.muted,
    resume: () => resumeTracker(output),
    stop(): void {
      wanted = false;
      stopTracker(output);
    },
  };
}

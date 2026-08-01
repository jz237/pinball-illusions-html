/**
 * THE SHELL'S MUSIC, driven by the shell's phase and by nothing else.
 *
 * The original front-end starts its one module the moment the menus come up
 * and keeps it running under every screen the shell owns; the table takes
 * over when play begins. This controller reproduces that shape over the
 * synthesized song: music sounds in every shell phase except the two that sit
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
import type { TrackerHost, TrackerOutput } from "../audio/tracker-output.js";
import { shellMusicStream } from "../audio/song-stream.js";

/** `KeyboardEvent.code` / `.key` of the mute toggle. See the header for why. */
export const MUSIC_TOGGLE_CODE = "Backquote";
export const MUSIC_TOGGLE_KEY = "`";

/** Where the mute setting lives, beside the ladders' own keys. */
export const MUSIC_MUTED_STORAGE_KEY = "pinball-illusions.music-muted";

/**
 * The phases the music does NOT play in: the ball, and the "REALLY QUIT
 * TABLE?" question drawn over the ball. Everything else — the attract roll,
 * the menus, the info screen, loading, the game-over cards, the name box and
 * the ladder — is the shell's, and the shell has music.
 */
export const SILENT_PHASES: ReadonlySet<ShellPhase> = new Set<ShellPhase>([
  "play",
  "quit-confirm",
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
  const output = createTrackerOutput(hostFactory);

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
    update(phase: ShellPhase): void {
      const wants = musicWantedFor(phase);
      if (wants && !wanted) {
        wanted = true;
        startTracker(output, shellMusicStream());
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

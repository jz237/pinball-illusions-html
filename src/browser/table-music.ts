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
 *   a mission   -> its own MODE BACKGROUND, and back to the main tune when it
 *                  ends: the mission bytecode's opcode 19 (see below)
 *   tilt        -> the TILT JINGLE (the +$94 cue; phase 8 is the tilted
 *                  state): a short sequence ending in F00, the player's stop
 *                  flag — the films' only silent gameplay spans, with the
 *                  decoded length matching the filmed tilt-to-silence gap on
 *                  all three filmed tilts
 *   ball end    -> the END-STOP record, a -2 into another F00 section: the
 *                  music plays a short outro and stops for the bonus count.
 *                  Film-verified: on BabeWatch the rendered section identifies
 *                  at waveform NCC +0.775 / +0.816 / +0.814 across the three
 *                  captures, each starting 0.20-0.44 s after a filmed centre
 *                  drain, against a cross-table ceiling of +0.14
 *   next serve  -> the vamp again (the ball-start cue re-fires per ball and
 *                  clears the stop flag, $7DD2). On take 1 the 0.62 s between
 *                  the outro's F00 and that vamp sits at RMS 0.021 against the
 *                  music's 0.128 — the silence the F00 asks for
 *
 * The MODE BACKGROUNDS are decoded but NOT film-verified: slid over all seven
 * captures they peak at +0.02..+0.17, inside the cross-table control band. No
 * mission starts in any capture. They ship on the decode, which is not
 * ambiguous — opcode 19 goes straight to the mailbox poster, so its operand
 * can only be a music record — but the honest statement is that no ear has
 * checked them against the machine.
 *
 * ---------------------------------------------------------------------------
 * THE THREE COMMANDS A CUE CARRIES ($6868 posts, $7D66.. executes)
 * ---------------------------------------------------------------------------
 * Every kind-4 record is {command, order position, bank}. The player keeps a
 * CURRENT song (state +$108..) and a SAVED song (+$000..) and a mailbox at
 * $2412/$2416/$2418, and the command decides which of three things happens:
 *
 *   cmd -2  SET BACKGROUND ($7DD2). `$81B0` writes the saved slot with a CLEAN
 *           channel state; if no override is sounding, `$81F8` promotes it to
 *           current straight away. If one IS sounding, only the slot changes —
 *           i.e. the override's return target is retargeted, and the switch
 *           happens when the override ends. This is the mode background.
 *
 *   cmd -1  QUEUE ($7E0C). Same slot write, but the switch waits for the
 *           CURRENT section's own Bxx: the loop-jump handler at $8860 tests
 *           the queued flag $219 FIRST and, if it is up, activates the queued
 *           song there. That is the launch's lap-boundary entry, measured to
 *           the frame on film, and it is what a mission's closing `-1 pos 1`
 *           uses too.
 *
 *   cmd >0  OVERRIDE ($7D88 -> $815E). Saves the whole current song AND its
 *           channel state (132 words), then starts (bank, position) now. At
 *           the override's own Bxx, $8860 falls to `jsr $821C`, which copies
 *           those 132 words back — the background resumes EXACTLY where it was
 *           interrupted. A nested override does not re-save ($815E's `tst.b
 *           $21a / bne` skips the copy), so the innermost sting still returns
 *           to the background and not to the sting it interrupted. An override
 *           whose section ends in F00 never reaches a Bxx and so never
 *           returns: F00 sets the stop flag at $883A and the player halts.
 *           That is the tilt jingle on BabeWatch and Extreme Sports, whose
 *           tilt cues are overrides rather than background sets.
 *
 * The reconstruction implements those three and nothing else. Resuming a
 * background "exactly where it was" is done by song TIME, not by restoring
 * per-channel Paula registers: the note that was sounding at the interruption
 * is not re-triggered, which is the one place this deviates from the 132-word
 * copy. Labelled here rather than hidden.
 *
 * ---------------------------------------------------------------------------
 * THE MAILBOX IS A MAILBOX, AND THE ASSET ARRIVES OVER A NETWORK
 * ---------------------------------------------------------------------------
 * On the machine the module is in RAM before the first ball is served, so the
 * engine's post at $6868 and the player's read at $7D66 are a frame apart and
 * nobody has to think about the gap. Here the table's music is a 200 KB
 * manifest and fifty WAVs, and the FIRST BALL IS SERVED 25 TICKS AFTER THE
 * TABLE OPENS — `openTable` starts the fetch and calls `shellTableLoaded` in
 * the same synchronous turn, and that returns `start-game`. Measured on a
 * model of one request per frame, ball one's serve lands at request 27 of 51.
 *
 * This module used to answer that with `if (asset === null) return`, which
 * threw the post away. Nothing re-armed when the asset landed, so the vamp
 * never started, the launch's queue was never even posted, and the first thing
 * a player heard was the END-OF-BALL STOP at the drain — the whole of ball one
 * silent, the music arriving with ball two. That is the defect this note is
 * attached to, and it was invisible to every existing test because every one
 * of them awaited the asset before observing a single report.
 *
 * The fix is the machine's own structure. $6868 does not play anything: it
 * writes {command, position, bank} to $2412/$2416/$2418 and returns, and the
 * player executes whatever the mailbox holds when it next runs. So the ENGINE
 * side — `observe`, driven by the tick reports — always posts, and the PLAYER
 * side executes on the frame it can. What is held is the cue SITE rather than
 * the record, because the record lives in the asset; last write wins, because
 * the mailbox is three words and not a queue.
 *
 * WHAT DIVERGES, precisely: on the machine every frame's post is executed, so
 * a ball-start followed by a launch plays the vamp and then hands over at its
 * lap boundary. Here, if BOTH land before the asset does, only the launch's
 * post survives and the main tune enters at once — the section the machine is
 * on at that moment, entered without the lap it would have waited out, because
 * the lap is a property of a vamp that never sounded. From the asset onward
 * the two agree.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE MODE SWITCHES COME FROM, AND WHAT IS NOT WIRED
 * ---------------------------------------------------------------------------
 * Each table carries 38-43 distinct kind-4 records reached by 81-88 relocated
 * pointers, and `scripts/export-table-music.mjs` classifies every one of them.
 * Four paths reach this controller:
 *
 *   the five descriptor cues (ball start, tilt, game over, high score,
 *   attract), the BONUS ROUTINE's end-stop record, the MISSION VM's opcode 19
 *   (32 / 27 / 32 sites — the mode backgrounds and the returns to the main
 *   tune), and an ELEMENT's +$0C / +$10 sound slot where the record is kind 4
 *   (one site, BabeWatch's).
 *
 * TWO PATHS ARE DELIBERATELY NOT WIRED, and the reasons are structural:
 *
 *   DISPLAY/ANIM-VM OPCODE $10 (51 / 45 / 44 sites, nearly all of the bank-1
 *   award and jackpot stings). Those records live inside display programs run
 *   by the VM at $6700, and a display program only runs if $6C2C's PRIORITY
 *   ARBITRATION admits it: `cmp.b $23b2(a5),d0 / bcs` DROPS a record whose
 *   priority pair is below what is on the ring, `bhi` FLUSHES the ring for a
 *   higher one, and only an equal-major/higher-minor pair appends. This port
 *   reconstructs which display records a mission shows, not the ring, its
 *   priorities or the per-frame VM, so `report.messagesShown` is a SUPERSET of
 *   what the machine runs.
 *
 *   `src/browser/audio.ts` already accepts that superset for the kind-2/5
 *   stings in the very same display records, and the difference is the cost of
 *   being wrong: a spurious EFFECT is 300 ms on a channel the music yields
 *   anyway, guarded by $779E's own priority test, while a spurious music
 *   OVERRIDE takes the whole tune away for one to seven seconds and gives it
 *   back at a Bxx. With no film evidence either way — no capture contains a
 *   mode entry at all — that is not a trade this round makes. The sites are
 *   counted in the manifest's `census` so the next round starts from the
 *   number, and the fix is the display ring, not another id namespace.
 *
 *   THE TABLE'S OWN 68k (6 sites, BabeWatch only). Its routine at h4+0x85EC
 *   copies a 12-word record over the ball-start record at h4+0x982E, choosing
 *   between {-2 pos 0, -2 pos 16, -2 pos 29} from the table at h4+0x872E —
 *   the JUKEBOX. Per-table 68k is not emulated at all here (mode VM opcode 20,
 *   NATIVE, is a counted no-op), so the selector's state does not exist.
 *
 * The GAME-OVER and HIGH-SCORE cues stay data as well: those screens belong to
 * the shell in this reconstruction and its own front-end module plays on them.
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
import {
  MUSIC_COMMAND_BACKGROUND,
  MUSIC_COMMAND_QUEUE,
  isMusicOverride,
  loadTableMusic,
  modeCueKey,
} from "../audio/table-music.js";
import type {
  ElementCueField,
  TableMusicAsset,
  TableMusicCue,
  TableMusicFetch,
} from "../audio/table-music.js";

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

/** One (bank, order position) the controller can play. */
interface SectionRef {
  readonly bank: number;
  readonly position: number;
}

/** What is sounding: the background suite, or an override on top of it. */
interface Sounding extends SectionRef {
  readonly stream: TrackerCommandStream;
  /** True while this is an override; false for the background. */
  readonly override: boolean;
}

/**
 * The cue records this controller drives by name: the descriptor's ball-start
 * and tilt, the launch's queue-main, and the bonus routine's end stop. The
 * game-over and high-score records are decoded but not driven — those screens
 * belong to the shell here and its own front-end module plays on them.
 */
type NamedCue = "ballStart" | "queueMain" | "tilt" | "endStop";

/**
 * ONE POST TO THE MAILBOX — a cue SITE, not a cue record.
 *
 * The record a site carries lives in the asset, and the asset arrives over the
 * network after the ball has been served (see the header). What the tick
 * report gives us is the site, and a site is enough: it resolves the instant
 * the manifest is in hand.
 */
type CuePost =
  | { readonly kind: "named"; readonly name: NamedCue }
  /** A mission-VM opcode 19, keyed as the modes document keys it. */
  | { readonly kind: "mode"; readonly script: number; readonly pc: number }
  /** An element's +$0C / +$10 slot holding a music command. */
  | { readonly kind: "element"; readonly field: ElementCueField; readonly element: number };

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
   * Reads one finished tick report and fires the cues it implies, in the
   * machine's own order: the mode VM's music opcodes first (they ran inside
   * the tick), then the ball transitions the loop reports around them. Order
   * within one tick follows the machine's own cue order — the last mailbox
   * write wins, so a tilt posted after a serve wins.
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

  /** Loaded assets, keyed by table id; null is a table with no manifest. */
  const loaded = new Map<string, TableMusicAsset | null>();
  const inFlight = new Map<string, Promise<void>>();

  let currentTableId: string | null = null;
  let current: TableMusicAsset | null = null;

  /** What is sounding right now, or null for silence. */
  let sounding: Sounding | null = null;
  /**
   * The BACKGROUND SLOT — the player's saved song ($0(a2)): what a -2 writes,
   * what an override returns to, what a queued switch becomes.
   */
  let background: SectionRef | null = null;
  /**
   * Where the interrupted background was when an override started, in song
   * milliseconds, and which section it was. Null when nothing is overriding.
   * This is the 132-word save at $815E, kept as a time rather than a register
   * file; see the header.
   */
  let saved: { readonly section: SectionRef; readonly offsetMs: number } | null = null;
  /** The pending queued switch (-1): lands at the current section's Bxx. */
  let queued: SectionRef | null = null;
  /**
   * The player's STOP FLAG $21C, as the context time it goes up: a section
   * ending in F00 raises it on that row ($883A), and from then on the player
   * is halted until a cue clears it. Null while the sounding section loops.
   */
  let stopsAt: number | null = null;
  /**
   * Balls on the playfield, tracked from the reports so a BALL-START serve
   * (balls were zero — the engine's $49BE/$4FC4 moments, which fire the
   * ball-start cue) is told apart from a multiball add-a-ball serve (balls
   * already live — the $6616 path, which fires no music cue and must not
   * restart the vamp over the main tune).
   */
  let ballsLive = 0;
  /**
   * THE MAILBOX ($2412/$2416/$2418), holding a post the player has not read
   * yet. Only ever occupied while the asset is in flight: with a manifest in
   * hand the player runs every frame and executes on the spot. See the header.
   */
  let mailbox: CuePost | null = null;

  const streamFor = (ref: SectionRef): TrackerCommandStream | null =>
    current === null ? null : current.section(ref.bank, ref.position);

  /** Song milliseconds elapsed in whatever is sounding, at `now`. */
  const elapsedMs = (now: number): number => {
    if (sounding === null) return 0;
    const passed = Math.max(0, now - output.startContextTime) * 1000;
    const lap = sounding.stream.durationMs - (sounding.stream.restartMs ?? 0);
    if (sounding.stream.restartMs === null || lap <= 0) return passed;
    if (passed <= sounding.stream.durationMs) return passed;
    return sounding.stream.restartMs + ((passed - sounding.stream.restartMs) % lap);
  };

  /**
   * Starts a section now (or at `atContextTime`), optionally `fromMs` into its
   * own pass — the override's return. Answers whether anything sounds.
   */
  const play = (
    ref: SectionRef,
    override: boolean,
    atContextTime?: number,
    fromMs = 0,
  ): boolean => {
    const stream = streamFor(ref);
    if (stream === null) return false;
    sounding = { ...ref, stream, override };
    queued = null;
    startTracker(output, stream, atContextTime, fromMs);
    // A section with no loop point ends in F00, and its last row is where the
    // machine's stop flag goes up.
    stopsAt =
      stream.restartMs === null
        ? output.startContextTime + stream.durationMs / 1000
        : null;
    return true;
  };

  /** True once the sounding section's F00 has raised the stop flag. */
  const halted = (now: number): boolean =>
    sounding === null || (stopsAt !== null && now >= stopsAt);

  const silence = (): void => {
    sounding = null;
    background = null;
    saved = null;
    queued = null;
    ballsLive = 0;
    stopsAt = null;
    mailbox = null;
    stopTracker(output);
  };

  /**
   * One decoded cue record, executed the way $7D66.. executes it.
   *
   * The stop flag is cleared by a BACKGROUND set exactly where the machine
   * clears it ($7DD2's `tst.b $21c / clr.b $21a / clr.b $21c`), which is why
   * the next ball's -2/0/0 ends the post-tilt and post-bonus silence.
   */
  const fire = (cue: TableMusicCue): void => {
    if (current === null) return;
    const ref = { bank: cue.bank, position: cue.position };
    const host = output.host;
    const now = host?.currentTime ?? 0;

    if (isMusicOverride(cue.command)) {
      // $7D88: the stop flag comes down ($21C), the current song is saved with
      // its whole state ($815E — skipped if an override is already sounding,
      // so the innermost sting still returns to the background), and the
      // override starts now.
      if (saved === null && sounding !== null && !sounding.override && !halted(now)) {
        saved = {
          section: { bank: sounding.bank, position: sounding.position },
          offsetMs: elapsedMs(now),
        };
      }
      play(ref, true);
      return;
    }

    if (cue.command === MUSIC_COMMAND_BACKGROUND) {
      // $7DD2: clear the stop, write the background slot ($81B0), and promote
      // it now unless an override is sounding — in which case only the slot
      // moves and the override's Bxx will land on it, from a CLEAN state
      // ($81B0 wipes the saved channel block, hence offset 0).
      background = ref;
      if (sounding !== null && sounding.override && !halted(now)) {
        saved = { section: ref, offsetMs: 0 };
        return;
      }
      // $81F8 promotes the slot AND clears the override flag: nothing is
      // waiting to come back any more.
      saved = null;
      play(ref, false);
      return;
    }

    if (cue.command === MUSIC_COMMAND_QUEUE) {
      // $7E0C: the slot is written and the switch waits for the current
      // section's Bxx. A queue arriving while the player is HALTED takes the
      // machine's own branch into the background path instead ($7E14/$7E1E
      // `tst.b $21c / bne -> $7DD2`), so it sounds at once.
      background = ref;
      if (halted(now)) {
        saved = null;
        play(ref, false);
        return;
      }
      queued = ref;
    }
  };

  /** The record a post names, or null when this table's manifest has none. */
  const resolve = (asset: TableMusicAsset, entry: CuePost): TableMusicCue | null => {
    switch (entry.kind) {
      case "named":
        return asset.cues[entry.name];
      case "mode":
        return asset.modeCues.get(modeCueKey(entry.script, entry.pc)) ?? null;
      case "element":
        return asset.elementCues[entry.field].get(entry.element) ?? null;
    }
  };

  /**
   * $6868: the engine posts, and the player executes it when it next runs.
   * With the manifest in hand that is the same frame, which is what every
   * previous round of this module did directly. Without it the post waits in
   * the mailbox — last write wins, three words, not a queue.
   *
   * A MODE OR ELEMENT SITE MADE BEFORE THE MANIFEST IS DROPPED rather than
   * held. On the machine the poster is only reached when the site's record is
   * KIND 4, and which records are kind 4 is exactly what the manifest says —
   * so a site we cannot look up is a site we cannot know posts at all, and
   * letting it into the mailbox would let a bumper that carries an EFFECT
   * silently wipe the ball transition that certainly did post. The named cues
   * are the descriptor's and the bonus routine's, and every table has them.
   */
  const post = (entry: CuePost): void => {
    const asset = current;
    if (asset === null) {
      if (entry.kind === "named") mailbox = entry;
      return;
    }
    const cue = resolve(asset, entry);
    if (cue !== null) fire(cue);
  };

  /** $7D66's read, on the first frame the player is able to run. */
  const readMailbox = (): void => {
    const asset = current;
    const entry = mailbox;
    if (asset === null || entry === null) return;
    mailbox = null;
    const cue = resolve(asset, entry);
    if (cue !== null) fire(cue);
  };

  /**
   * Is the SERVE SECTION what the player is on? With a manifest that is a
   * question about what is sounding. Without one it is a question about what
   * the mailbox will make sound, which is the same question one frame earlier
   * — and it is what decides whether a launch queues the main tune.
   */
  const serveSectionUp = (): boolean => {
    const asset = current;
    if (asset === null) return mailbox?.kind === "named" && mailbox.name === "ballStart";
    return (
      sounding !== null &&
      sounding.bank === asset.cues.ballStart.bank &&
      sounding.position === asset.cues.ballStart.position
    );
  };

  /**
   * The next Bxx of whatever is sounding, in context time — the boundary a
   * queued switch lands on, and the moment an override returns. A section that
   * ends in F00 has no Bxx and answers null.
   */
  const nextBoundary = (now: number): number | null => {
    if (sounding === null) return null;
    const stream = sounding.stream;
    if (stream.restartMs === null) return null;
    const lapSeconds = (stream.durationMs - stream.restartMs) / 1000;
    const firstEnd = output.startContextTime + stream.durationMs / 1000;
    if (lapSeconds <= 0) return firstEnd;
    if (now < firstEnd) return firstEnd;
    const laps = Math.ceil((now - firstEnd) / lapSeconds + 1e-6);
    return firstEnd + laps * lapSeconds;
  };

  return {
    output,

    select(tableId: string): void {
      currentTableId = tableId;
      const cached = loaded.get(tableId);
      if (cached !== undefined) {
        current = cached;
        bank = cached === null ? () => null : cached.bank;
        silence();
        return;
      }
      current = null;
      bank = () => null;
      silence();
      if (inFlight.has(tableId)) return;
      const task = (async () => {
        let asset: TableMusicAsset | null = null;
        try {
          asset = await loadTableMusic(tableId, fetcher);
        } catch {
          asset = null; // an undecodable asset is a silent table
        }
        loaded.set(tableId, asset);
        inFlight.delete(tableId);
        if (currentTableId === tableId) {
          current = asset;
          bank = asset === null ? () => null : asset.bank;
        }
      })();
      inFlight.set(tableId, task);
    },

    clear(): void {
      currentTableId = null;
      current = null;
      bank = () => null;
      silence();
    },

    observe(report: GameTickReport): void {
      // THE ENGINE SIDE, and it runs whether or not the manifest has arrived:
      // $6868 posts to the mailbox from the game code, and the player reads it
      // when it can. An asset still in flight used to make this whole method a
      // no-op, which lost ball one's serve and its launch outright — and lost
      // the ball count with them, so the next add-a-ball serve would have
      // restarted the vamp over the main tune. See the header.

      // The mission VM's own music opcodes, in the order it executed them.
      for (const site of report.musicCues) {
        post({ kind: "mode", script: site.script, pc: site.pc });
      }
      // An element's START / AWARD sound slot holding a music command.
      for (const element of report.elementStarts) {
        post({ kind: "element", field: "start", element });
      }
      for (const element of report.elementAwards) {
        post({ kind: "element", field: "award", element });
      }

      // The ball-start cue fires when a ball arrives on an EMPTY playfield —
      // game start and every next ball ($49BE/$4FC4) — and puts the vamp up;
      // it also ends the post-tilt and post-bonus silence ($7DD2 clears the
      // stop flag $21C). A multiball add-a-ball serve fires no music cue.
      if (report.served) {
        if (ballsLive === 0) post({ kind: "named", name: "ballStart" });
        ballsLive += 1;
      }
      // A ball ending runs the table's end-of-ball bonus routine ($51BE), and
      // that routine's first instruction fires its end-stop record: a -2 into
      // a section that ends in F00, so the music stops for the bonus count. A
      // multiball drain that leaves balls in play is not a ball end.
      //
      // THE SILENCE NOW HAS SOMETHING IN IT. When this cue was wired the bonus
      // count did not exist and the stop was a stop into an immediate re-serve;
      // `bonus.ts` reconstructs the routine those frames belong to, so the gap
      // between this record and the next ball-start cue is the length of the
      // panels the machine is showing — which is what the record was firing for.
      // The site is unchanged: it is still the drain, because the routine fires
      // the record on its FIRST instruction and the phase starts on the same tick.
      const ended = report.drained.length;
      if (ended > 0) {
        ballsLive = Math.max(0, ballsLive - ended);
        if (ballsLive === 0) post({ kind: "named", name: "endStop" });
      }
      // The launch queues the main tune (-1): the switch happens at the vamp's
      // lap boundary, which `update` executes when it comes close.
      //
      // RECONSTRUCTION, and unchanged from the round that measured it. The
      // queue-main record's only decoded sites are mission-VM opcode 19 inside
      // scripts nothing statically points at (they hang off the `$23DC` PUSH
      // stack, RULES_SPEC §12.4), so no ENGINE site for it is decoded — but
      // six filmed launches enter the main tune exactly on the vamp's next lap
      // boundary, which is what a queue does and nothing else does. It is
      // fired only while the SERVE SECTION is up, so a mission background that
      // is running when a ball is launched keeps playing, as the machine's own
      // background slot would.
      if (report.launched && serveSectionUp()) post({ kind: "named", name: "queueMain" });
      // The tilt: its own cue, an override on two tables and a background set
      // on the third, and on all three a section ending in F00.
      if (report.justTilted) post({ kind: "named", name: "tilt" });
      if (report.gameOver) ballsLive = 0;
    },

    update(phase: ShellPhase, effects: AudioBank | null): void {
      if (!TABLE_MUSIC_PHASES.has(phase) || current === null) {
        // A post the player never got to read belongs to the ball that made
        // it: leaving the table throws it away with everything else, so a
        // manifest that lands on the game-over card does not start a tune
        // over a screen the shell's own module owns.
        if (!TABLE_MUSIC_PHASES.has(phase)) mailbox = null;
        if (sounding !== null) silence();
        return;
      }
      // $7D66's read, first thing: the player is running now, so whatever the
      // engine posted while the manifest was in flight sounds from here. This
      // is where ball one's music comes from on a cold table. It happens
      // BEFORE the host is read because starting a section is what builds the
      // context, and the channel-3 gate below wants it on this frame, not the
      // next one.
      readMailbox();

      const host = output.host;
      const now = host?.currentTime ?? 0;

      // The Bxx: a queued switch lands there ($8860's $219 path), and failing
      // that an override returns to the background there ($821C). Until the
      // boundary is inside the lookahead the pump is capped at it, so the
      // current section never schedules past its own last lap.
      let lookahead = LOOKAHEAD_SECONDS;
      if (host !== null && sounding !== null && (queued !== null || sounding.override)) {
        const boundary = nextBoundary(now);
        if (boundary !== null) {
          if (boundary - now <= LOOKAHEAD_SECONDS * 0.9) {
            const back = saved;
            if (queued !== null) {
              const target = queued;
              background = target;
              saved = null;
              play(target, false, boundary);
            } else if (back !== null) {
              saved = null;
              play(back.section, false, boundary, back.offsetMs);
            } else if (background !== null) {
              play(background, false, boundary);
            }
          } else {
            lookahead = Math.max(boundary - now - 0.001, 0.05);
          }
        }
      }

      if (sounding !== null) pumpTracker(output, lookahead);

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

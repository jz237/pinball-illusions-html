/**
 * "SILVER MIRAGE" — the shell's attract-mode music. A NEW composition.
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE, STATED PLAINLY
 * ---------------------------------------------------------------------------
 * The original front-end module (music001.bin) is the publisher's musical
 * work. Its note data, order list and samples were NOT read, transcribed or
 * approximated to make this file. What was used is decoded FORMAT knowledge
 * only — 4 channels, 64-row patterns, the 36-note period table, ProTracker
 * effect semantics — via the engine contract in `tracker.ts`. Every note
 * below was composed for this reconstruction, and every instrument it names
 * is synthesized in code by `instruments.ts`. Nothing here is disk-derived.
 *
 * ---------------------------------------------------------------------------
 * THE PIECE
 * ---------------------------------------------------------------------------
 * A minor, speed 6 at 125 BPM — 20 ms a tick, 120 ms a row, 7.68 s a
 * pattern. Five patterns, ten order slots: 76.8 s to the first loop, 69.1 s
 * a lap thereafter (the intro is played once; the restart skips it).
 *
 *   order:  0      1     2     1     2     3      4      1     2     3
 *          intro  A     B     A     B    bridge break   A     B    bridge
 *                                                        ^ restart = 1
 *
 * The channel plan is the period front-end layout:
 *   ch 0  bass       driving octave eighths on the chord roots
 *   ch 1  arpeggio   effect-0 triads sustained across each bar — THE chip
 *                    sound; 0x37 spells a minor triad, 0x47 a major one
 *   ch 2  lead       pulse melody; the triangle takes it for pads and echoes
 *   ch 3  percussion the noise burst at three pitches: low = kick-ish thump,
 *                    mid = snare, high = hat, levels set per hit with Cxx
 *
 * Harmony: A section Am-F-C-G, answered Am-F-Dm-E; the bridge climbs
 * F-G-Em-Am; the breakdown thins to Am-Am-F-E and builds back. The E major
 * bars carry the G# that pulls each phrase home to A minor.
 */

import type { TrackerCell, TrackerPattern, TrackerSong } from "./tracker.js";
import { EMPTY_CELL, cell } from "./tracker.js";
import type { InstrumentId } from "./instruments.js";

// ---------------------------------------------------------------------------
// Vocabulary: notes, instruments, and cell shorthands
// ---------------------------------------------------------------------------

// Note numbers are 1-based indices into the 36-entry period table, C-1..B-3.
const D1 = 3, E1 = 5, F1 = 6, G1 = 8, A1 = 10;
const C2 = 13, D2 = 15, E2 = 17, F2 = 18, G2 = 20, Gs2 = 21, A2 = 22, B2 = 24;
const C3 = 25, D3 = 27, E3 = 29, F3 = 30, G3 = 32, A3 = 34, B3 = 36;

// Song-local instrument numbers; `SHELL_SONG_VOICES` maps them to synths.
const BASS = 1, ARP = 2, LEAD = 3, DRUM = 4, PAD = 5;

// Arpeggio params: base / +x / +y semitones.
const MIN3 = 0x37; // minor triad: root, minor third, fifth
const MAJ3 = 0x47; // major triad: root, major third, fifth

const __ = EMPTY_CELL;
const b = (note: number): TrackerCell => cell(note, BASS, 0x0, 0);
const chord = (note: number, triad: number): TrackerCell => cell(note, ARP, 0x0, triad);
const arp = (triad: number): TrackerCell => cell(0, 0, 0x0, triad);
const ld = (note: number): TrackerCell => cell(note, LEAD, 0x0, 0);
const ldv = (note: number, volume: number): TrackerCell => cell(note, LEAD, 0xc, volume);
const pad = (note: number): TrackerCell => cell(note, PAD, 0x0, 0);
const padChord = (note: number, triad: number): TrackerCell => cell(note, PAD, 0x0, triad);
const fade = (perTick: number): TrackerCell => cell(0, 0, 0xa, perTick);
const kick = (volume: number): TrackerCell => cell(C2, DRUM, 0xc, volume);
const snare = (volume: number): TrackerCell => cell(A2, DRUM, 0xc, volume);
const hat = (volume: number): TrackerCell => cell(B3, DRUM, 0xc, volume);

// ---------------------------------------------------------------------------
// Pattern 0 — INTRO. The Andalusian descent, Am-G-F-E: bass and arpeggio
// establish the groove, a triangle descant sighs C-B-A-G# overhead, drums
// are barely there until the pickup into the A section.
// ---------------------------------------------------------------------------

const PATTERN_INTRO: TrackerPattern = [
  // bar 1 — Am, descant C-3
  /* 00 */ [b(A1), chord(A2, MIN3), pad(C3), __],
  /* 01 */ [__, __, __, __],
  /* 02 */ [b(A1), arp(MIN3), __, __],
  /* 03 */ [__, __, __, __],
  /* 04 */ [b(A2), arp(MIN3), __, hat(8)],
  /* 05 */ [__, __, __, __],
  /* 06 */ [b(A1), arp(MIN3), __, __],
  /* 07 */ [__, __, __, __],
  /* 08 */ [b(A1), arp(MIN3), fade(1), __],
  /* 09 */ [__, __, __, __],
  /* 10 */ [b(A2), arp(MIN3), fade(1), __],
  /* 11 */ [__, __, __, __],
  /* 12 */ [b(A1), arp(MIN3), fade(1), hat(8)],
  /* 13 */ [__, __, __, __],
  /* 14 */ [b(A1), arp(MIN3), fade(1), __],
  /* 15 */ [__, __, __, __],
  // bar 2 — G, descant B-2
  /* 16 */ [b(G1), chord(G2, MAJ3), pad(B2), __],
  /* 17 */ [__, __, __, __],
  /* 18 */ [b(G1), arp(MAJ3), __, __],
  /* 19 */ [__, __, __, __],
  /* 20 */ [b(G2), arp(MAJ3), __, hat(8)],
  /* 21 */ [__, __, __, __],
  /* 22 */ [b(G1), arp(MAJ3), __, __],
  /* 23 */ [__, __, __, __],
  /* 24 */ [b(G1), arp(MAJ3), fade(1), __],
  /* 25 */ [__, __, __, __],
  /* 26 */ [b(G2), arp(MAJ3), fade(1), __],
  /* 27 */ [__, __, __, __],
  /* 28 */ [b(G1), arp(MAJ3), fade(1), hat(8)],
  /* 29 */ [__, __, __, __],
  /* 30 */ [b(G1), arp(MAJ3), fade(1), __],
  /* 31 */ [__, __, __, __],
  // bar 3 — F, descant A-2
  /* 32 */ [b(F1), chord(F2, MAJ3), pad(A2), __],
  /* 33 */ [__, __, __, __],
  /* 34 */ [b(F1), arp(MAJ3), __, __],
  /* 35 */ [__, __, __, __],
  /* 36 */ [b(F2), arp(MAJ3), __, hat(8)],
  /* 37 */ [__, __, __, __],
  /* 38 */ [b(F1), arp(MAJ3), __, __],
  /* 39 */ [__, __, __, __],
  /* 40 */ [b(F1), arp(MAJ3), fade(1), __],
  /* 41 */ [__, __, __, __],
  /* 42 */ [b(F2), arp(MAJ3), fade(1), __],
  /* 43 */ [__, __, __, __],
  /* 44 */ [b(F1), arp(MAJ3), fade(1), hat(8)],
  /* 45 */ [__, __, __, __],
  /* 46 */ [b(F1), arp(MAJ3), fade(1), __],
  /* 47 */ [__, __, __, __],
  // bar 4 — E major, descant G#-2; the snare wakes up for the pickup
  /* 48 */ [b(E1), chord(E2, MAJ3), pad(Gs2), __],
  /* 49 */ [__, __, __, __],
  /* 50 */ [b(E1), arp(MAJ3), __, __],
  /* 51 */ [__, __, __, __],
  /* 52 */ [b(E2), arp(MAJ3), __, hat(8)],
  /* 53 */ [__, __, __, __],
  /* 54 */ [b(E1), arp(MAJ3), __, __],
  /* 55 */ [__, __, __, __],
  /* 56 */ [b(E1), arp(MAJ3), fade(1), __],
  /* 57 */ [__, __, __, __],
  /* 58 */ [b(E2), arp(MAJ3), fade(1), __],
  /* 59 */ [__, __, __, __],
  /* 60 */ [b(E1), arp(MAJ3), fade(1), snare(24)],
  /* 61 */ [__, __, __, __],
  /* 62 */ [b(E1), arp(MAJ3), fade(1), snare(32)],
  /* 63 */ [__, __, __, __],
];

// ---------------------------------------------------------------------------
// Pattern 1 — MAIN A. Am-F-C-G, the question phrase: the lead opens E-A-G-E-D
// over the full groove, and the G bar lets the line die away on a fade.
// ---------------------------------------------------------------------------

const PATTERN_MAIN_A: TrackerPattern = [
  // bar 1 — Am
  /* 00 */ [b(A1), chord(A2, MIN3), ld(E3), kick(36)],
  /* 01 */ [__, arp(MIN3), __, __],
  /* 02 */ [b(A1), arp(MIN3), __, hat(10)],
  /* 03 */ [__, arp(MIN3), __, __],
  /* 04 */ [b(A2), arp(MIN3), ld(A3), snare(44)],
  /* 05 */ [__, arp(MIN3), __, __],
  /* 06 */ [b(A1), arp(MIN3), __, hat(10)],
  /* 07 */ [__, arp(MIN3), __, __],
  /* 08 */ [b(A1), arp(MIN3), __, kick(32)],
  /* 09 */ [__, arp(MIN3), __, __],
  /* 10 */ [b(A2), arp(MIN3), ld(G3), hat(10)],
  /* 11 */ [__, arp(MIN3), __, __],
  /* 12 */ [b(A1), arp(MIN3), ld(E3), snare(44)],
  /* 13 */ [__, arp(MIN3), __, __],
  /* 14 */ [b(G1), arp(MIN3), ld(D3), hat(12)],
  /* 15 */ [__, arp(MIN3), __, __],
  // bar 2 — F
  /* 16 */ [b(F1), chord(F2, MAJ3), ld(C3), kick(36)],
  /* 17 */ [__, arp(MAJ3), __, __],
  /* 18 */ [b(F1), arp(MAJ3), __, hat(10)],
  /* 19 */ [__, arp(MAJ3), __, __],
  /* 20 */ [b(F2), arp(MAJ3), ld(D3), snare(44)],
  /* 21 */ [__, arp(MAJ3), __, __],
  /* 22 */ [b(F1), arp(MAJ3), __, hat(10)],
  /* 23 */ [__, arp(MAJ3), __, __],
  /* 24 */ [b(F1), arp(MAJ3), ld(E3), kick(32)],
  /* 25 */ [__, arp(MAJ3), __, __],
  /* 26 */ [b(F2), arp(MAJ3), __, hat(10)],
  /* 27 */ [__, arp(MAJ3), __, __],
  /* 28 */ [b(F1), arp(MAJ3), ld(D3), snare(44)],
  /* 29 */ [__, arp(MAJ3), __, __],
  /* 30 */ [b(F1), arp(MAJ3), ld(C3), hat(12)],
  /* 31 */ [__, arp(MAJ3), __, __],
  // bar 3 — C
  /* 32 */ [b(C2), chord(C3, MAJ3), ld(E3), kick(36)],
  /* 33 */ [__, arp(MAJ3), __, __],
  /* 34 */ [b(C2), arp(MAJ3), __, hat(10)],
  /* 35 */ [__, arp(MAJ3), __, __],
  /* 36 */ [b(C3), arp(MAJ3), ld(G3), snare(44)],
  /* 37 */ [__, arp(MAJ3), __, __],
  /* 38 */ [b(C2), arp(MAJ3), __, hat(10)],
  /* 39 */ [__, arp(MAJ3), __, __],
  /* 40 */ [b(C2), arp(MAJ3), ld(E3), kick(32)],
  /* 41 */ [__, arp(MAJ3), __, __],
  /* 42 */ [b(C3), arp(MAJ3), __, hat(10)],
  /* 43 */ [__, arp(MAJ3), __, __],
  /* 44 */ [b(C2), arp(MAJ3), ld(D3), snare(44)],
  /* 45 */ [__, arp(MAJ3), __, __],
  /* 46 */ [b(D2), arp(MAJ3), __, hat(12)],
  /* 47 */ [__, arp(MAJ3), __, __],
  // bar 4 — G; the phrase settles on B and fades under the turnaround
  /* 48 */ [b(G1), chord(G2, MAJ3), ld(B2), kick(36)],
  /* 49 */ [__, arp(MAJ3), __, __],
  /* 50 */ [b(G1), arp(MAJ3), __, hat(10)],
  /* 51 */ [__, arp(MAJ3), __, __],
  /* 52 */ [b(G2), arp(MAJ3), ld(D3), snare(44)],
  /* 53 */ [__, arp(MAJ3), __, __],
  /* 54 */ [b(G1), arp(MAJ3), __, hat(10)],
  /* 55 */ [__, arp(MAJ3), __, __],
  /* 56 */ [b(G1), arp(MAJ3), ld(B2), kick(32)],
  /* 57 */ [__, arp(MAJ3), __, __],
  /* 58 */ [b(G2), arp(MAJ3), fade(2), hat(10)],
  /* 59 */ [__, arp(MAJ3), fade(2), __],
  /* 60 */ [b(G1), arp(MAJ3), fade(2), snare(44)],
  /* 61 */ [__, arp(MAJ3), fade(2), __],
  /* 62 */ [b(G2), arp(MAJ3), fade(2), hat(12)],
  /* 63 */ [__, arp(MAJ3), fade(2), __],
];

// ---------------------------------------------------------------------------
// Pattern 2 — MAIN B. Same opening bar, then the answer: Am-F-Dm-E. The E
// major bar walks B-C-B-A down to G#, the leading tone that wants A minor
// back — which is always the next bar in the order list.
// ---------------------------------------------------------------------------

const PATTERN_MAIN_B: TrackerPattern = [
  // bar 1 — Am (as the question phrase)
  /* 00 */ [b(A1), chord(A2, MIN3), ld(E3), kick(36)],
  /* 01 */ [__, arp(MIN3), __, __],
  /* 02 */ [b(A1), arp(MIN3), __, hat(10)],
  /* 03 */ [__, arp(MIN3), __, __],
  /* 04 */ [b(A2), arp(MIN3), ld(A3), snare(44)],
  /* 05 */ [__, arp(MIN3), __, __],
  /* 06 */ [b(A1), arp(MIN3), __, hat(10)],
  /* 07 */ [__, arp(MIN3), __, __],
  /* 08 */ [b(A1), arp(MIN3), __, kick(32)],
  /* 09 */ [__, arp(MIN3), __, __],
  /* 10 */ [b(A2), arp(MIN3), ld(G3), hat(10)],
  /* 11 */ [__, arp(MIN3), __, __],
  /* 12 */ [b(A1), arp(MIN3), ld(E3), snare(44)],
  /* 13 */ [__, arp(MIN3), __, __],
  /* 14 */ [b(G1), arp(MIN3), ld(D3), hat(12)],
  /* 15 */ [__, arp(MIN3), __, __],
  // bar 2 — F; the answer dips low before rising
  /* 16 */ [b(F1), chord(F2, MAJ3), ld(C3), kick(36)],
  /* 17 */ [__, arp(MAJ3), __, __],
  /* 18 */ [b(F1), arp(MAJ3), __, hat(10)],
  /* 19 */ [__, arp(MAJ3), __, __],
  /* 20 */ [b(F2), arp(MAJ3), ld(A2), snare(44)],
  /* 21 */ [__, arp(MAJ3), __, __],
  /* 22 */ [b(F1), arp(MAJ3), __, hat(10)],
  /* 23 */ [__, arp(MAJ3), __, __],
  /* 24 */ [b(F1), arp(MAJ3), ld(C3), kick(32)],
  /* 25 */ [__, arp(MAJ3), __, __],
  /* 26 */ [b(F2), arp(MAJ3), __, hat(10)],
  /* 27 */ [__, arp(MAJ3), __, __],
  /* 28 */ [b(F1), arp(MAJ3), ld(D3), snare(44)],
  /* 29 */ [__, arp(MAJ3), __, __],
  /* 30 */ [b(E1), arp(MAJ3), __, hat(12)],
  /* 31 */ [__, arp(MAJ3), __, __],
  // bar 3 — Dm
  /* 32 */ [b(D1), chord(D2, MIN3), ld(D3), kick(36)],
  /* 33 */ [__, arp(MIN3), __, __],
  /* 34 */ [b(D1), arp(MIN3), __, hat(10)],
  /* 35 */ [__, arp(MIN3), __, __],
  /* 36 */ [b(D2), arp(MIN3), ld(F3), snare(44)],
  /* 37 */ [__, arp(MIN3), __, __],
  /* 38 */ [b(D1), arp(MIN3), __, hat(10)],
  /* 39 */ [__, arp(MIN3), __, __],
  /* 40 */ [b(D1), arp(MIN3), ld(E3), kick(32)],
  /* 41 */ [__, arp(MIN3), __, __],
  /* 42 */ [b(D2), arp(MIN3), __, hat(10)],
  /* 43 */ [__, arp(MIN3), __, __],
  /* 44 */ [b(D1), arp(MIN3), ld(D3), snare(44)],
  /* 45 */ [__, arp(MIN3), __, __],
  /* 46 */ [b(D1), arp(MIN3), __, hat(12)],
  /* 47 */ [__, arp(MIN3), __, __],
  // bar 4 — E major; B-C-B-A down to the leading G#, with a two-hit fill
  /* 48 */ [b(E1), chord(E2, MAJ3), ld(B2), kick(36)],
  /* 49 */ [__, arp(MAJ3), __, __],
  /* 50 */ [b(E1), arp(MAJ3), __, hat(10)],
  /* 51 */ [__, arp(MAJ3), __, __],
  /* 52 */ [b(E2), arp(MAJ3), ld(C3), snare(44)],
  /* 53 */ [__, arp(MAJ3), __, __],
  /* 54 */ [b(E1), arp(MAJ3), ld(B2), hat(10)],
  /* 55 */ [__, arp(MAJ3), __, __],
  /* 56 */ [b(E1), arp(MAJ3), ld(A2), kick(32)],
  /* 57 */ [__, arp(MAJ3), __, __],
  /* 58 */ [b(E2), arp(MAJ3), __, hat(10)],
  /* 59 */ [__, arp(MAJ3), __, __],
  /* 60 */ [b(E1), arp(MAJ3), ld(Gs2), snare(44)],
  /* 61 */ [__, arp(MAJ3), __, __],
  /* 62 */ [b(E1), arp(MAJ3), __, snare(28)],
  /* 63 */ [__, arp(MAJ3), __, snare(40)],
];

// ---------------------------------------------------------------------------
// Pattern 3 — BRIDGE. F-G-Em-Am: the lead climbs out of the melody's range
// up to B-3, then falls onto a long A-3 that fades as the bar empties.
// Always lands on an A minor bar, so anything may follow it.
// ---------------------------------------------------------------------------

const PATTERN_BRIDGE: TrackerPattern = [
  // bar 1 — F
  /* 00 */ [b(F1), chord(F2, MAJ3), ld(F3), kick(36)],
  /* 01 */ [__, arp(MAJ3), __, __],
  /* 02 */ [b(F1), arp(MAJ3), __, hat(10)],
  /* 03 */ [__, arp(MAJ3), __, __],
  /* 04 */ [b(F2), arp(MAJ3), ld(E3), snare(44)],
  /* 05 */ [__, arp(MAJ3), __, __],
  /* 06 */ [b(F1), arp(MAJ3), __, hat(10)],
  /* 07 */ [__, arp(MAJ3), __, __],
  /* 08 */ [b(F1), arp(MAJ3), ld(F3), kick(32)],
  /* 09 */ [__, arp(MAJ3), __, __],
  /* 10 */ [b(F2), arp(MAJ3), __, hat(10)],
  /* 11 */ [__, arp(MAJ3), __, __],
  /* 12 */ [b(F1), arp(MAJ3), ld(G3), snare(44)],
  /* 13 */ [__, arp(MAJ3), __, __],
  /* 14 */ [b(F1), arp(MAJ3), __, hat(12)],
  /* 15 */ [__, arp(MAJ3), __, __],
  // bar 2 — G; the climb
  /* 16 */ [b(G1), chord(G2, MAJ3), ld(G3), kick(36)],
  /* 17 */ [__, arp(MAJ3), __, __],
  /* 18 */ [b(G1), arp(MAJ3), __, hat(10)],
  /* 19 */ [__, arp(MAJ3), __, __],
  /* 20 */ [b(G2), arp(MAJ3), __, snare(44)],
  /* 21 */ [__, arp(MAJ3), __, __],
  /* 22 */ [b(G1), arp(MAJ3), __, hat(10)],
  /* 23 */ [__, arp(MAJ3), __, __],
  /* 24 */ [b(G1), arp(MAJ3), ld(A3), kick(32)],
  /* 25 */ [__, arp(MAJ3), __, __],
  /* 26 */ [b(G2), arp(MAJ3), __, hat(10)],
  /* 27 */ [__, arp(MAJ3), __, __],
  /* 28 */ [b(G1), arp(MAJ3), ld(B3), snare(44)],
  /* 29 */ [__, arp(MAJ3), __, __],
  /* 30 */ [b(G1), arp(MAJ3), __, hat(12)],
  /* 31 */ [__, arp(MAJ3), __, __],
  // bar 3 — Em; the peak, stepping back down
  /* 32 */ [b(E1), chord(E2, MIN3), ld(B3), kick(36)],
  /* 33 */ [__, arp(MIN3), __, __],
  /* 34 */ [b(E1), arp(MIN3), __, hat(10)],
  /* 35 */ [__, arp(MIN3), __, __],
  /* 36 */ [b(E2), arp(MIN3), ld(G3), snare(44)],
  /* 37 */ [__, arp(MIN3), __, __],
  /* 38 */ [b(E1), arp(MIN3), __, hat(10)],
  /* 39 */ [__, arp(MIN3), __, __],
  /* 40 */ [b(E1), arp(MIN3), ld(E3), kick(32)],
  /* 41 */ [__, arp(MIN3), __, __],
  /* 42 */ [b(E2), arp(MIN3), __, hat(10)],
  /* 43 */ [__, arp(MIN3), __, __],
  /* 44 */ [b(E1), arp(MIN3), ld(G3), snare(44)],
  /* 45 */ [__, arp(MIN3), __, __],
  /* 46 */ [b(E1), arp(MIN3), __, hat(12)],
  /* 47 */ [__, arp(MIN3), __, __],
  // bar 4 — Am; a long A-3 dies away, drums fill into the loop
  /* 48 */ [b(A1), chord(A2, MIN3), ld(A3), kick(36)],
  /* 49 */ [__, arp(MIN3), __, __],
  /* 50 */ [b(A1), arp(MIN3), __, hat(10)],
  /* 51 */ [__, arp(MIN3), __, __],
  /* 52 */ [b(A2), arp(MIN3), __, snare(44)],
  /* 53 */ [__, arp(MIN3), __, __],
  /* 54 */ [b(A1), arp(MIN3), __, hat(10)],
  /* 55 */ [__, arp(MIN3), __, __],
  /* 56 */ [b(A1), arp(MIN3), fade(1), kick(32)],
  /* 57 */ [__, arp(MIN3), fade(1), __],
  /* 58 */ [b(A2), arp(MIN3), fade(1), hat(10)],
  /* 59 */ [__, arp(MIN3), fade(1), __],
  /* 60 */ [b(A1), arp(MIN3), fade(1), snare(30)],
  /* 61 */ [__, arp(MIN3), fade(1), __],
  /* 62 */ [b(A1), arp(MIN3), fade(1), snare(40)],
  /* 63 */ [__, arp(MIN3), fade(1), hat(12)],
];

// ---------------------------------------------------------------------------
// Pattern 4 — BREAKDOWN. Am-Am-F-E at half-time: the pulse leads drop out
// and the triangle carries the arpeggio alone over the bass, then a snare
// build and a quiet lead pickup rebuild tension for the A section's return.
// ---------------------------------------------------------------------------

const PATTERN_BREAK: TrackerPattern = [
  // bar 1 — Am, half-time drums
  /* 00 */ [b(A1), padChord(A2, MIN3), __, kick(34)],
  /* 01 */ [__, __, __, __],
  /* 02 */ [b(A1), arp(MIN3), __, __],
  /* 03 */ [__, __, __, __],
  /* 04 */ [b(A2), arp(MIN3), __, hat(8)],
  /* 05 */ [__, __, __, __],
  /* 06 */ [b(A1), arp(MIN3), __, __],
  /* 07 */ [__, __, __, __],
  /* 08 */ [b(A1), arp(MIN3), __, snare(36)],
  /* 09 */ [__, __, __, __],
  /* 10 */ [b(A2), arp(MIN3), __, __],
  /* 11 */ [__, __, __, __],
  /* 12 */ [b(A1), arp(MIN3), __, hat(8)],
  /* 13 */ [__, __, __, __],
  /* 14 */ [b(A1), arp(MIN3), __, __],
  /* 15 */ [__, __, __, __],
  // bar 2 — Am again, held low
  /* 16 */ [b(A1), padChord(A2, MIN3), __, kick(34)],
  /* 17 */ [__, __, __, __],
  /* 18 */ [b(A1), arp(MIN3), __, __],
  /* 19 */ [__, __, __, __],
  /* 20 */ [b(A2), arp(MIN3), __, hat(8)],
  /* 21 */ [__, __, __, __],
  /* 22 */ [b(A1), arp(MIN3), __, __],
  /* 23 */ [__, __, __, __],
  /* 24 */ [b(A1), arp(MIN3), __, snare(36)],
  /* 25 */ [__, __, __, __],
  /* 26 */ [b(A2), arp(MIN3), __, __],
  /* 27 */ [__, __, __, __],
  /* 28 */ [b(A1), arp(MIN3), __, hat(8)],
  /* 29 */ [__, __, __, __],
  /* 30 */ [b(A1), arp(MIN3), __, __],
  /* 31 */ [__, __, __, __],
  // bar 3 — F
  /* 32 */ [b(F1), padChord(F2, MAJ3), __, kick(34)],
  /* 33 */ [__, __, __, __],
  /* 34 */ [b(F1), arp(MAJ3), __, __],
  /* 35 */ [__, __, __, __],
  /* 36 */ [b(F2), arp(MAJ3), __, hat(8)],
  /* 37 */ [__, __, __, __],
  /* 38 */ [b(F1), arp(MAJ3), __, __],
  /* 39 */ [__, __, __, __],
  /* 40 */ [b(F1), arp(MAJ3), __, snare(36)],
  /* 41 */ [__, __, __, __],
  /* 42 */ [b(F2), arp(MAJ3), __, __],
  /* 43 */ [__, __, __, __],
  /* 44 */ [b(F1), arp(MAJ3), __, hat(8)],
  /* 45 */ [__, __, __, __],
  /* 46 */ [b(F1), arp(MAJ3), __, __],
  /* 47 */ [__, __, __, __],
  // bar 4 — E major; snare build, and a quiet E-3 pickup on the lead
  /* 48 */ [b(E1), padChord(E2, MAJ3), __, kick(34)],
  /* 49 */ [__, __, __, __],
  /* 50 */ [b(E1), arp(MAJ3), __, __],
  /* 51 */ [__, __, __, __],
  /* 52 */ [b(E2), arp(MAJ3), __, hat(8)],
  /* 53 */ [__, __, __, __],
  /* 54 */ [b(E1), arp(MAJ3), __, __],
  /* 55 */ [__, __, __, __],
  /* 56 */ [b(E1), arp(MAJ3), ldv(E3, 24), snare(20)],
  /* 57 */ [__, __, __, __],
  /* 58 */ [b(E2), arp(MAJ3), __, snare(26)],
  /* 59 */ [__, __, __, __],
  /* 60 */ [b(E1), arp(MAJ3), __, snare(32)],
  /* 61 */ [__, __, __, __],
  /* 62 */ [b(E2), arp(MAJ3), __, snare(40)],
  /* 63 */ [__, __, __, __],
];

// ---------------------------------------------------------------------------
// The song
// ---------------------------------------------------------------------------

/**
 * Maps the song's instrument numbers to the synthesized voices in
 * `instruments.ts`. The tracker core deals only in the numbers; the output
 * layer needs the names. This table is the bridge, and it is data.
 */
export const SHELL_SONG_VOICES: Readonly<Record<number, InstrumentId>> = {
  [BASS]: "bass",
  [ARP]: "pulse25",
  [LEAD]: "pulse50",
  [DRUM]: "noise",
  [PAD]: "triangle",
};

export const SHELL_SONG: TrackerSong = {
  title: "Silver Mirage",
  initialSpeed: 6,
  initialTempo: 125,
  // The intro (order 0) plays once; every later lap re-enters at the A section.
  restart: 1,
  orders: [0, 1, 2, 1, 2, 3, 4, 1, 2, 3],
  patterns: [PATTERN_INTRO, PATTERN_MAIN_A, PATTERN_MAIN_B, PATTERN_BRIDGE, PATTERN_BREAK],
  instruments: [
    { id: BASS, finetune: 0, volume: 56 },
    { id: ARP, finetune: 0, volume: 36 },
    { id: LEAD, finetune: 0, volume: 52 },
    { id: DRUM, finetune: 0, volume: 44 },
    { id: PAD, finetune: 0, volume: 40 },
  ],
};

/**
 * THE PLATFORM MASTER LEVEL — where this port's absolute loudness is decided,
 * and the only place it is decided.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS FIXES, measured before it was touched
 * ---------------------------------------------------------------------------
 * Paula sums four 8-bit channels at volume 0..64, TWO PER SIDE at half a
 * side's scale each — a mono fold of the machine's output therefore carries
 * each music channel at ONE QUARTER of full scale, and four channels at full
 * volume land exactly at 1.0. This project's own reference renderer has
 * always said so (`research/gameover-music/tools/render-section.mts` folds
 * `acc / 4`), and that fold is level-true against the machine: aligned to a
 * WinUAE capture at waveform NCC +0.574, its peaks agree within 0.5 dB.
 *
 * The shipped graph ignored the fold. Every tracker voice reached the
 * destination at FULL per-channel scale (4x the machine) and the effect
 * channel at full scale beside it, so the mixer-model render of a real game
 * start measured the front-end tune at RMS -4.0 dBFS with 9.6% of output
 * samples PAST FULL SCALE — hard destination clipping — while the sibling
 * ports on the same games page play their music at RMS -25..-29 dBFS. That
 * is the operator's report ("way too loud starting the game compared to
 * every other game"), reproduced as a number. Figures and method:
 * `research/audio-level/LOUDNESS.md`.
 *
 * ---------------------------------------------------------------------------
 * THE CONVENTION MATCHED, constant for constant
 * ---------------------------------------------------------------------------
 * Both sibling ports run machine-scale content through one fixed attenuation
 * and no fancier mastering chain, read from their deployed bundles:
 *
 *   Pinball Fantasies HD   master 1.0; music bus 0.34; effect bus 0.85
 *                          (games/2026-07-28/pinball-fantasies/assets/
 *                           coarse-pointer-*.js: `musicGain??.34`,
 *                           `effectGain??.85`)
 *   Pinball Dreams II HD   music 0.29 (element volume) / intro gain 0.29
 *                          over a 0.34 master with 0.58 sfx bus; direct
 *                          effect voices at 0.55 (live bundle
 *                          PinballDreams-*.js: `gain.value=.34`, `.58`,
 *                          `.29`, `volume=.55`)
 *
 * Their music content is the machine's own four-channel mix rendered to a
 * file (normalised near full scale), so "sibling music level" means
 * MACHINE MIX x 0.34. This port's tracker IS the machine mix at per-channel
 * scale, hence:
 *
 *   MUSIC_MASTER_LEVEL = 0.34 / 4  — sibling music bus x Paula's mono fold.
 *
 * An effect is different on the machine itself: it owns AUD3, ONE OF TWO
 * channels on its side, i.e. HALF a side's scale — twice a music channel's
 * weight in the fold — and one effect sounds at a time. The siblings ship
 * effects at destination peaks 0.23..0.42 (their files x their buses,
 * measured); this port's effect records are full-scale PCM at volume/64, so:
 *
 *   EFFECT_MASTER_LEVEL = 0.85 / 2 — sibling effect bus x AUD3's own weight,
 *
 * which lands the decoded records (volume 40..64) at destination peaks
 * 0.27..0.42 — inside the measured sibling band. Every balance DECODED from
 * the machine is untouched: per-record volumes, per-note volumes, the AUD3
 * duck, the priority ladder and the section levels all scale by one constant
 * per path, and the two constants are the siblings' own two bus levels
 * mapped through Paula's own channel weights.
 *
 * NO CLIPPING, BY CONSTRUCTION: four music channels at full volume plus a
 * full-scale effect sum to 4 x 0.085 + 0.425 = 0.765 < 1.0, so the
 * destination cannot clip even at the theoretical worst case the old graph
 * exceeded routinely. The onset is a HARD START at the matched level — both
 * siblings start their music with a fixed gain and no ramp (Dreams sets
 * `volume` before `play()`; Fantasies sets `gain.value` and `start()`s), so
 * a ramp here would be an invention.
 *
 * Pinned by `tests/audio-level.test.ts`, which renders a real game start
 * through the mixer model and holds peak, RMS and the no-clipping property
 * to the sibling band — so a round that touches any gain in the graph moves
 * a measured number, not an opinion.
 */

/** Sibling music bus (0.34) through Paula's four-channel mono fold. */
export const MUSIC_MASTER_LEVEL = 0.34 / 4;

/** Sibling effect bus (0.85) through AUD3's half-a-side channel weight. */
export const EFFECT_MASTER_LEVEL = 0.85 / 2;

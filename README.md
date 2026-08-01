# Pinball Illusions HTML

A clean-room browser reconstruction of the four-disk AGA release of Pinball
Illusions (21st Century Entertainment, 1995) — the third game in the Pinball
Dreams / Fantasies / Illusions line, and the first with multiball.

## Status

Early, but the geometry is no longer guesswork. Disk custody, volume layout, the
table index and the per-table option defaults are established, and the per-pixel
collision map for all three tables has been decoded and shipped:

- Playfield is **336 x 600** on every table, stored as four stacked 1-bit layers of
  **620 / 620 / 600 / 600** rows at offsets **0 / 26040 / 52080 / 77280**.
- A pixel blocks the lower-level ball **iff its index is odd**. Bit 0 is the lower
  collision line; bit 1 is the upper one; bits 2 and 3 are structure artwork drawn
  over the ball and do not block it.
- The maps under `public/generated/tables/*.map.json` are decoded under those bases
  and are **current and correctly aligned**. (An earlier decode assumed four equal
  610-row planes and was misaligned by 10–20 rows; that is history, and
  `DISK_ANALYSIS.md` keeps the record of how it was caught.)
- `scripts/export-table-maps.mjs` is the generator of record for those files. It
  needs the operator's own disks, so it is not part of `npm run build`:
  `node scripts/export-table-maps.mjs <segment-dir>` rewrites them and
  `--check` re-decodes and compares without writing.

And the **ramp drive** is decoded and shipped beside them, in
`public/generated/tables/*.accel.json`:

- Slot 4 of each table package opens with **two 42 x 75 byte block maps**, one per
  playfield level, one byte per **8 x 8 pixel** block of the 336 x 600 playfield,
  followed by a short list of signed **(dx, dy)** word pairs the bytes index. The
  engine adds that pair to the ball's velocity beside gravity on every integration
  substep; the consumer is disassembled in full in
  `scripts/export-table-accel.mjs`, at `main.seg00 +0x00B70A`.
- This is what a ramp uses to carry the ball, and a reconstruction cannot do
  without it. Any surface shallower than the contact model's static-friction angle
  of `atan(154/1024)` = 8.55 degrees is an equilibrium, and the tables are full of
  them because a real ramp is nearly flat. No choice of friction coefficient
  escapes that — and the original never needed one, because its bounce has no
  Coulomb term at all. See `src/game/table-accel.ts`.
- `scripts/export-table-accel.mjs` is the generator of record, with the same
  `<segment-dir>` and `--check` interface as the map exporter, and four fatal
  self-checks: the module's relocation table must parse to the byte and rewrite
  nothing in the decoded region; the slot-0 descriptor must delimit all three
  structures exactly; the vectors must be shaped like a ramp drive; and the block
  maps must be mostly zero and spatially coherent.
- `tests/table-accel.test.ts` does the part a comment cannot: it measures the
  shipped block maps against the shipped collision maps and asserts that the
  driven blocks land on the ramps.

And the **missions** are decoded and shipped in
`public/generated/tables/*.modes.json`:

- The thing a mode record points at is not a data record, it is a **bytecode
  program**. `jsr $6C10` is seven instructions and appends to a 64-slot ring; the
  interpreters are at `0x58BC` (the background queue, one opcode per frame) and
  `0x57AC` (the running mission, plus its wait machinery). The 31-entry dispatch
  table at `0x5912` is indexed **scaled by four**, which is the correction that
  unlocked it — see `docs/RULES_SPEC.md` §12 and `scripts/export-table-modes.mjs`.
- A mission arms an element, waits on it, and advances when a shot's own script
  `AWARD`s that element and clears its armed bit. That single bit is the whole
  join between the physics and the rules. `src/game/mode-vm.ts` is the runtime.
- Law 'n Justice has **eight** missions, not the seventeen secondary sources
  claim: the selector table's terminator holds the engine's own count. Extreme
  Sports' Iron Man serves **three** balls, not four.
- `scripts/export-table-modes.mjs` is the generator of record, with the same
  `<segment-dir>` and `--check` interface, and six fatal self-checks.

And the **sound effects** are decoded and shipped in
`public/generated/tables/*.audio.json` plus one WAV per sample:

- Slots 7 and 8 are not raw PCM: every one begins `SNT!` and is a ProTracker-
  derived module bank, with the effect PCM appended after the last bank. The
  26-byte sound record's layout is proven by the DMA servicer at `$7958`, and its
  period is a **pitch** — every value is an exact ProTracker period and records
  that share a sample form chromatic runs across adjacent lane rectangles.
- `src/browser/audio.ts` plays them through Web Audio on one channel with the
  original's priority rule, and is **strictly downstream of the simulation**:
  nothing under `src/game/` imports it, and `tests/audio.test.ts` runs the same
  game twice — once silent, once with the whole sound layer on every tick — and
  asserts the two snapshots are byte-identical.

`scripts/aggressive-census.mts` is the survey instrument the strand sites are
measured with — a player who taps the bats on a fixed cadence whatever the ball
is doing, over every plunge hold from 8 to 97, 90 games and 270 ball ends a
table. It is deliberately not a test; `tests/plays.test.ts` holds the contracts.

### What runs today

A Q10 fixed-point N-ball simulation, a 50 Hz fixed-step scheduler, ring-based
collision against the decoded map on BOTH of its collision levels, three
flippers, a plunger, nudge and tilt, a scrolling camera that reframes to the
whole table during multiball, a Canvas2D renderer that blits the decoded 336x600
playfield artwork at integer scale with smoothing off, and a game loop — strict
`tsc` clean and `npm run build` green.

A ball serves in the shooter lane, a full plunge carries it up the lane and round
the top arch onto the playfield, the flippers send it back up the table, it
drains, the next ball is served, and after three the game ends. Tilt kills the
flippers, nothing escapes the playfield, and an identical input sequence
reproduces byte for byte.

**All three tables play a three-ball game, and all three drain every ball down
the middle.** Extreme Sports was the last holdout: it used to end every single
ball as a ball-search write-off on one pixel, (302,163), and its apparent
30-in-30 completion rate was entirely the search retiring stuck balls. Its crown
ramp does not stop there — it continues on the UPPER collision line, down a
wireform to y=380 and back onto the playfield — and `crown-mouth` and
`crown-end` in `src/game/playfield-levels.ts` are that pair of hand-offs, both
read off the shipped map.

**Balls are no longer written off while they are still moving.** Friction used
to be a flat 15% of the ball's whole along-surface speed, taken on every tick of
contact: not Coulomb friction but a viscous damper. It gave a ball on a slope a
terminal crawl of 0.001-0.036 px/tick instead of letting it accelerate, and
since the ball search asks for 8 px in 500 ticks, balls that were visibly
rolling were being retired as lost. `reflectVelocity` now takes a tangential
impulse bounded by the normal impulse, which is the real rule.

### The arch, and why a ball used to be stuck in the lane

For a long time a game could not reach ball two: Law 'n Justice's LOWER collision
line stops dead at the top of the shooter lane — no bit-0 pixel anywhere in
columns 281..300 above y=560, and none at all in rows 0..34 — so a launched ball
met a flat virtual ceiling, fell back down the lane and rested there forever.

The arch was never missing. It is on the UPPER collision line (map bit 1), which
the engine correctly treated as passable for a ball on the playfield and had no
other use for. The lane's two walls are upper-only up to y=126, carry BOTH lines
through y=127..175, and are lower-only from y=176 down; above that hand-off they
curve left as two concentric arcs that cap the whole table, forming a channel
about 21 px wide — a 16 px ball and no more.

So the ball now carries a level, `src/game/playfield-levels.ts` supplies the
upper-level view of the map and the hand-off lines, and a full plunge rides the
real, authored ramp. The earlier synthesised sloped arch is gone.

That hand-off is not Law 'n Justice's alone, and it is no longer hand-tuned.
`src/game/level-scan.ts` derives it from any map: walk the shooter lane's centre
column, take the free-ball-centre run on each collision line, and a **hand-off
band** is a run of rows where both lines carry the same channel — over which the
probe ring reads identically, so a level change there cannot be felt. Which way
the gate points comes from which line still carries the channel beyond the band.
Run against the shipped maps it finds Law 'n Justice's 49-row band on its own,
plus BabeWatch's (whose lower line otherwise seals the served ball in a 577-cell
box) and Extreme Sports' two (whose lane changes line twice). `tests/level-scan.test.ts`
re-runs the derivation on every build and asserts the shipped gates are what it
produces, so those constants stay checkably derived rather than merely asserted.

One thing there is honest about its status: the row at which the ramp puts the
ball back on the playfield is **inferred, not read** — the ramp's outboard rail
runs off the edge of the bitmap and the channel pinches shut below y=91, so the
ball must leave somewhere, but nothing in the data says where.

The other used to be the ball search, which was doing more work than it should
because nothing emptied the playfield's holes. That is closed, and the fix was
not a bigger constant.

### Devices and scoring

The **surface-ID map** — one byte per pixel per level, naming what the ball is
touching rather than merely whether it is solid — is decoded, shipped beside the
collision map and the ramp drive, and wired into the physics. Three things come
with it, all read off the original rather than chosen:

- **Restitution and the kicks.** The engine indexes a 256-row table of four words
  at `main.seg08` by surface ID; a plain wall returns 0.297 of the approach where
  this project had been assuming 0.625, a pop bumper adds 5500 of the original's
  velocity units before restitution and a slingshot 3500 plus ±400 along its face.
  `src/game/surface-physics.ts` has all thirty-two numbers and says which two of
  the four words this port can honestly adopt and why the other two are recorded
  and not applied.
- **The awards.** Devices, bumpers, slingshots, zone triggers and locks, each with
  its packed-BCD first-hit score, first-hit bonus and repeat score. The score is
  kept in packed BCD as the original keeps it, twelve digits, through the same
  ABCD chain — the digits displayed are the digits stored. Every bonus field in
  every record on all three tables is zero, which is a result rather than a gap:
  the bonus ladder comes from a mission-script VM that is not decoded.
- **The hand-offs.** Surface IDs 10 and 11 move the ball between the two collision
  lines and stop it dead, and the zone list carries the engine's own twenty-pixel
  hand-off boxes. Both are now applied, and between them they took the ninety-game
  aggressive census from 26 written-off balls on Law 'n Justice to zero.

### Not started

Modes, missions and the bonus ladder; table select, options and high-score
screens; audio; BabeWatch and Extreme Sports beyond geometry, the shared engine
and the shipped scoring layer.

See [docs/DISK_ANALYSIS.md](docs/DISK_ANALYSIS.md) and
[docs/GAMEPLAY_PARITY.md](docs/GAMEPLAY_PARITY.md).

## The table set

Three tables, named exactly as the game stores them in `tables.bin`:

1. Law 'n Justice
2. BabeWatch
3. Extreme Sports

*The Vikings* belongs to the PC CD-ROM and console ports, not to this release, and
is out of scope.

## Why this is not a fork of the Dreams reconstruction

Two structural differences drove a fresh engine rather than a copy:

**Multiball.** Illusions' defining feature. The Dreams and Fantasies
reconstructions both simulate exactly one ball, from the fixed-point integrator
upward. An N-ball simulation — ball list, ball-to-ball collision, drain handling
while other balls stay live, and a camera that reframes when more than one ball is
in play — has to be in the core from the first commit, not bolted on later.

**Disk format.** Pinball Dreams used a custom track encoding that needed a
track-list reconstruction and a bespoke embedded file directory. Illusions is plain
AmigaDOS FFS, so its structure is directly readable and the analysis effort moves
from *recovering the filesystem* to *understanding the table packages*.

What does carry over is the architecture proven in the sibling projects: Q10
fixed-point deterministic physics on a fixed-step scheduler, declarative table
geometry compiled to material maps, an unsmoothed integer-scaled Canvas2D
renderer, Web Audio synthesis, and a build
that refuses to ship preservation media.

## Development

Requires Node.js 20.19 or newer.

```sh
npm install
npm run verify   # tests, strict typecheck, production build, rights guard
npm run dev
```

## Rights boundary

The original disks belong to the operator and are read locally, read-only. The line
this project draws is between **functional geometry** and **creative content**:

- **Collision geometry is disk-derived.** The per-pixel material map is decoded from
  the operator's own disks and shipped as `public/generated/tables/*.map.json`. It
  records where the walls, rails and devices are — the facts the physics needs — and
  contains no artwork, audio or executable code. This is the same approach the
  Pinball Dreams reconstruction shipped with.
- **Playfield artwork is disk-derived too, and gated the same way.** The 256-colour
  336x600 picture and its palette are decoded from the operator's own disks and
  shipped as `public/generated/tables/*.art.png`, each beside a manifest carrying the
  `disk-derived-playfield-artwork` provenance marker and the image's sha256. It is a
  still image: no audio, no executable code. Shipping it is an explicit decision by
  the operator, and `npm run guard:public` refuses a build that contains it — or any
  raster image no manifest accounts for, or one whose bytes do not match the digest
  its manifest records — unless the authorization variable is set.
- **The mission bytecode is disk-derived, and gated the same way.** Each table's
  event records — the programs that run its missions — its playfield element
  records, its display text and the device and zone bindings that fire them are
  decoded into `public/generated/tables/*.modes.json` under the
  `disk-derived-mode-scripts` marker. Rules data: no artwork, no audio, no
  executable code, and no 68k is emulated to run it.
- **THE SOUND EFFECTS ARE DISK-DERIVED. This changed, and the change matters.**
  This section used to say audio was "newly created — synthesised or
  independently recreated rather than sampled", and while the missions were being
  decoded the sound records turned out to be decodable too. So the effects now
  shipped are the machine's own samples, taken out of the `SNT!` banks at the
  Paula period each sound record names, written to `public/generated/tables/*.wav`
  and claimed by a `disk-derived-audio` manifest carrying each file's sha256.
  Several of them are speech, which is a heavier rights question than a still
  picture, so they go through exactly the same authorization gate: `npm run
  guard:public` refuses a build containing a sound file no manifest accounts for,
  or one whose bytes do not match its recorded digest, unless the operator sets
  the variable. **No music is shipped** — the modules' packed pattern format is
  not decoded, so there is nothing here that could play a tune.
- No disk image, ROM, Amiga executable or PowerPacker payload enters this
  repository or any build, and that is checked mechanically rather than promised.

Publishing the derived maps is a deliberate act, not an accident of file layout.
`npm run guard:public` refuses the build if a map carrying the
`disk-derived-collision-geometry` provenance marker is present without:

```sh
PINBALL_ILLUSIONS_DERIVED_AUTHORIZED=1
```

The same guard independently scans for preservation file formats, raw disk-image
sizes, Amiga executable and PowerPacker signatures, local filesystem paths and
credentials, and fails on any hit.

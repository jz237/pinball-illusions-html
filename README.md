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

Two things there are honest about their status. The row at which the ramp puts
the ball back on the playfield is **inferred, not read** — the ramp's outboard
rail runs off the edge of the bitmap and the channel pinches shut below y=91, so
the ball must leave somewhere, but nothing in the data says where. And the ball
search — a real machine's "nothing has moved, write the ball off" timeout — is
currently doing more work than it should, because the playfield has kicker holes
that the undecoded device layer would empty. Both are documented at the point of
use with the measurements that constrain them.

### Not started

Devices, rules and scoring; table select, options and high-score screens; audio;
BabeWatch and Extreme Sports beyond geometry and the shared engine.

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
- **Audio is newly created.** Synthesised or independently recreated rather than
  sampled. No disk image, ROM, Amiga executable or ripped sample enters this
  repository or any build.

Publishing the derived maps is a deliberate act, not an accident of file layout.
`npm run guard:public` refuses the build if a map carrying the
`disk-derived-collision-geometry` provenance marker is present without:

```sh
PINBALL_ILLUSIONS_DERIVED_AUTHORIZED=1
```

The same guard independently scans for preservation file formats, raw disk-image
sizes, Amiga executable and PowerPacker signatures, local filesystem paths and
credentials, and fails on any hit.

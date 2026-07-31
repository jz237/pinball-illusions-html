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
collision against the decoded map, three flippers, a plunger, nudge and tilt, a
scrolling camera that reframes to the whole table during multiball, a procedural
Canvas2D renderer in period style, and a game loop — 557 vitest cases, strict
`tsc` clean, `npm run build` green.

A ball serves in the shooter lane, the plunger launches it, the flippers send it
back up the table, tilt kills the flippers, nothing escapes the playfield, and an
identical input sequence reproduces byte for byte.

### The one thing standing between this and playable

**A game cannot reach ball two.** Law 'n Justice's map carries no collision line
in its top rows, so there is no arch to turn the vertical launch into a lateral
entry onto the playfield. A full-charge launch peaks at y=34 against a ceiling at
y=34: the ball rises up the shooter lane, meets a flat soffit dead-on with no
sideways velocity, falls back down the lane and rests there. No ball ever drains.

A synthesised sloped arch was tried and reverted — it did free the ball but
measurably degraded the flipper return, at which point the numbers were being
fitted to tests rather than to the original. The likelier explanation is that the
arch is not missing at all: slots 1 and 3 of each table package are still
unidentified, and slot 3 is a raster of identical size on all three tables.
Decoding those comes before inventing anything.

`tests/plays.test.ts` records this with an `it.fails` characterisation test, so
the suite stays green while the gap exists and starts failing the moment real
geometry makes a ball drain.

### Not started

Devices, rules and scoring; table select, options and high-score screens; audio;
BabeWatch and Extreme Sports beyond their shared engine support.

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
geometry compiled to material maps, a procedural Canvas2D renderer that draws from
those maps rather than from extracted sprites, Web Audio synthesis, and a build
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
- **Everything visible or audible is newly created.** Playfield artwork is drawn
  fresh in period style rather than extracted; audio is synthesised or independently
  recreated. No disk image, ROM, Amiga executable, ripped bitmap or ripped sample
  enters this repository or any build.

Publishing the derived maps is a deliberate act, not an accident of file layout.
`npm run guard:public` refuses the build if a map carrying the
`disk-derived-collision-geometry` provenance marker is present without:

```sh
PINBALL_ILLUSIONS_DERIVED_AUTHORIZED=1
```

The same guard independently scans for preservation file formats, raw disk-image
sizes, Amiga executable and PowerPacker signatures, local filesystem paths and
credentials, and fails on any hit.

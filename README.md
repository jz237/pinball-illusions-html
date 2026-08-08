# Pinball Illusions HTML

A clean-room browser reconstruction of the four-disk AGA release of Pinball
Illusions (21st Century Entertainment, 1995) — the third game in the Pinball
Dreams / Fantasies / Illusions line, and the first with multiball.

## Status

All three tables play, in HD, with sound, on a desktop or a phone. What is on
screen and what comes out of the speakers is the disk's own data, and where the
two disagree with a recording of the real machine, the recording wins.

The instrument that made that possible is worth stating up front, because most
of the interesting findings came from it rather than from reading code: the
original runs under WinUAE beside this port, filmed at one frame per PAL frame
with unresampled audio, and — when film is not sharp enough — its ball record is
read live out of emulator memory, frame by frame. Several beliefs this project
held with confidence were overturned that way. The credits roll is twelve pages,
not nineteen. The flipper collision body was a third thinner than the bat drawn
over it. The title music was the wrong module entirely. An untouched ball on Law
'n Justice scores nothing on the real machine either, so the zero this port
produces is correct and the round chasing it was chasing correct behaviour.

Some numbers that are checkable rather than adjectival: the three playfields
agree with filmed frames of the original at **98.45 / 99.86 / 99.13 percent** of
pixels; the twelve credit pages match at **27,400 of 27,400** ink pixels; the
front-end music correlates with the filmed audio at **0.72 waveform and 0.98
envelope** and loops at exactly the machine's own 8077 PAL frames. And because
the first three of those are all about the PICTURE: driven one frame at a time
from the original's own RAM, this port's ball reproduces the machine's velocity
word exactly on **470 of 576** traced frames and its position on **487**, with
every remaining unit of error on a contact frame. The score panel is set in the
machine's **own six bitmap faces**, read out of `main` hunk 5 — the caption one
is **five rows** tall, which is why a caption now lands on the strip's dot rows
2..6, exactly where it was counted on native-resolution film — and every figure
beside a caption ("BUMPER VALUE", "JACKPOT") is the field the machine's own
number opcode reads, comma-grouped by its own `0x24924924` mask. 1943 tests,
strict `tsc`, and a build that refuses to ship any asset nothing accounts for.

The geometry everything else rests on:

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

And the **playfield lamps** are decoded and shipped in
`public/generated/tables/*.lamps.json`:

- The mission VM's lamp opcodes drive **lamp objects** in hunk 4, reached from an
  element's `+$04` (START, lit **blinking** at the measured 8-frame half-period)
  and `+$08` (AWARD, relit **steady**). The per-frame scan at `$64D0` walks the
  group table the slot-0 descriptor names at `+$38` and blits each lamp's slot-6
  shape into **bitplane 7** of the playfield. The shipped artwork stores every
  insert **lit**: the OFF blit (minterm `$FC`) sets bit 7 and moves the insert's
  pixels into the upper palette half, where the artist painted the dim variants.
  So the port draws the **dim overlays of the lamps the VM is not lighting** —
  `index | 0x80` through the artwork's own palette — over the cached raster each
  frame. Extreme Sports adds six masked-image lamps with explicit OFF/ON sprites.
- `scripts/export-table-lamps.mjs` is the generator of record, same
  `<segment-dir>` and `--check` interface, with four fatal self-checks —
  including that every one of the ~11,000 mask pixels per table sits on
  bit-7-clear artwork, and that the element wiring agrees with the shipped
  `*.modes.json` element by element. `src/game/lamp-overlays.ts` decides the
  pixels (pure, node-testable); `src/browser/lamp-layer.ts` blits them; and
  `tests/lamp-overlays.test.ts` runs the same game twice — once rendering lamps
  every tick, once never touching them — and asserts identical state, so lamp
  state cannot feed back into the physics.

And the **two things that move** — the flipper bats and the ball — are decoded
and shipped in `public/generated/flipper-bats.json` and
`public/generated/tables/*.ball.json`:

- `pkg/flipdat1.bin` is a **three-bitplane** pose bank, not the two planes plus a
  fill mask this project believed for five rounds. The third run in each unit is
  bitplane 2, and it is what turns a red-outlined blob into the slim grey-bodied
  blade the original draws: `plane0 | plane1<<1 | plane2<<2` into entries 0..7 of
  the table's own artwork palette, with plane 2 inset two rows top and bottom. One
  136,288-byte file serves all three tables; only the palette differs.
- 120 poses to a turn at 3 degrees, 109 stored (the eleven with the tip pointing
  up are absent because no bat reaches them), and **64 shipped** — the union of
  the four arcs, derived by walking each table's flipper records rather than
  listed. The blit anchor is not in the file; it is `A = (8, 8)` on whichever end
  the boss cap is, `W-7` / `H-7` on the other, a rule that reproduces all 34
  anchors measured pixel-exact off filmed WinUAE frames.
- The **ball is a per-table 17x17 sprite**, the last 544 bytes of slot 6, eight
  line-interleaved bitplanes, shipped as 289 palette indices. Not 16: the disc is
  odd-sized with a true centre pixel, which is exactly the reconstruction's
  `BALL_RADIUS_PIXELS = 8`. Its footprint is main.bin's shared 221-pixel disc, and
  the original draws it LAST and cookie-cuts it against the level's structure
  layer — map bit 2 or bit 3 — which is how ramps pass in front of it.
- `scripts/export-flipper-bats.mjs` and `scripts/export-table-ball.mjs` are the
  generators of record, same `<segment-dir>` and `--check` interface, with eleven
  and eight fatal self-checks. `src/game/moving-sprites.ts` decides the pixels
  (pure, node-testable); `src/browser/sprite-layer.ts` blits them through the same
  `playfieldBlitGeometry` the artwork and the lamps use, so every sprite pixel is
  a uniform SxS block at integer scale S — measured, zero non-uniform blocks over
  the 327x228 comparison window, where the procedural bats and ball scored 599 /
  559 / 621. When a sprite document is absent the renderer draws a **magenta
  outline**, not a plausible substitute.
- Two numbers the picture and the simulation still disagree on, both stated in
  `src/game/flipper-bats.ts`: the records put every lower pivot on **row 556**
  where the simulation collides on the inferred 558, and they rest at **pose 10 /
  pose 50 — exactly 30 degrees** where the simulation rests at 26.7. The drawn bat
  uses the record; closing the gap moves the ball and belongs in its own round.

And the **sound effects** are decoded and shipped in
`public/generated/tables/*.audio.json` plus one WAV per sample, with the
engine's own seven sounds beside them in `public/generated/engine.audio.json`:

- Slots 7 and 8 are not raw PCM: every one begins `SNT!` and is a ProTracker-
  derived module bank, with the effect PCM appended after the last bank. The
  26-byte sound record's layout is proven by the DMA servicer at `$7958`, and its
  period is a **pitch** — every value is an exact ProTracker period and records
  that share a sample form chromatic runs across adjacent lane rectangles.
- The engine bank is `main.bin` hunks 10/11 — flipper up- and down-stroke, ball
  serve, ball drain, level transfer, lock capture and device eject — wired to
  the tick report's own event fields, and the table manifests carry the
  award/mode sting layer (lock-eject voices, award fanfares, the universal
  script stings, Extreme Sports' mission callouts) keyed by the ids the mode VM
  already reports. The full census of what the original plays and from where is
  `research/SOUND_CENSUS.md`.
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
playfield artwork, its lamp overlays, its flipper bats and its ball at integer
scale with smoothing off — every pixel on screen a decoded pixel — and a game
loop — strict `tsc` clean and `npm run build` green.

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

### The shell

`main.bin` is the shell, and `src/browser/shell.ts` is its two state machines:
the menu machine at hunk-0 0x100E and the non-gameplay half of the in-game
machine at 0x3D3E. The flow is the disk's — attract roll, main menu ("Tables"
and "Exit", and there are only two), table select with its scrolling name list
and its "Info" box, the info screen, the game, "REALLY QUIT TABLE?" on ESC,
game over, the high-score check against that table's own ladder, three initials
typed on the keyboard, and the table's own attract screen. The function keys
pick a table and go straight into a game, skipping the menu, as they do on the
Amiga. All three tables are reachable and all three are playable; there is no
build-time choice of table anywhere.

Every coordinate on those screens is read off the display lists in `main.bin`
and used unchanged, in a 320 x 256 box centred in this reconstruction's
336-wide window. The colours and the fonts are NOT the disk's: the original
takes both from `menudata.bin`, whose two proportional bitmap fonts and three
tumbling-object backdrop strips are not exported.

**The table names ship; the marketing prose does not.** The names are exactly
the twenty-three-byte fields in `tables.bin` — the shell patches the record's
index into every filename and into the nonvolatile item name `Table00N`, so the
name is how the machine refers to the table at all. The paragraph each
`tableNNN.mnu` carries beside its artwork is the publisher's copy, and the
credits roll in `menudata.bin` is the developers' own authored text; neither is
reproduced. The info screen's description is written fresh, and the picture it
shows is the table's own playfield artwork, which already ships and is already
claimed by the build's manifest.

**There is no options screen, and that is not an omission.** The `.opt` records
are read by the engine at fixed addresses and their labels do not exist as text
anywhere in the release.

### On a phone

The cabinet grows a five-button deck under the picture and a small bar above it,
and nothing else changes: touch goes through `InputRouter.pointerDown` /
`pointerUp` and reaches `tickGame` as exactly the `ControlSnapshot` a keyboard
produces, so the simulation never learns there is a touchscreen. The deck
appears on a coarse pointer — `(hover: none) and (pointer: coarse)`, never a
user-agent string — or the moment a finger actually touches the glass, so a
laptop with a touchscreen gets it when its owner uses the screen and not before.

| Button | In a game | In a menu |
|---|---|---|
| LEFT / RIGHT | the two bats; hold to cradle | move left / right |
| UP | the upper bat | move up |
| NUDGE | shove the cabinet | move down |
| LAUNCH | fire the ball, and only while one is on the rod | select |

The menu screens are painted into the canvas rather than built out of HTML, so
they are also tappable directly: the menu's two boxes, table select's name and
Info boxes, and the scrolling name list, all hit-tested against the renderer's
own coordinates. "REALLY QUIT TABLE?" takes 'Y' and nothing else, exactly as the
original does, so the deck offers QUIT and PLAY ON by name and a stray tap on
the glass always means PLAY ON. Initials are typed on the phone's own keyboard.

Portrait and landscape both work and neither is locked or nagged about; in
landscape the deck moves to the left and right edges, which is worth about half
as much picture again, because this machine's window is wide and short where
both sibling remakes' are tall. There is no accelerometer: the nudge is a
button, iOS gates motion behind a permission prompt, a real shake is
indistinguishable from walking, and this table's tilt is a measured mechanism
that a noisy continuous signal would trip for players who did nothing.

### Formerly not started, both since fitted

MULTIPLE PLAYERS shipped in the hot-seat round: the original scans F1..F8 for
one to eight and alternates them per ball, and so does this — the rotation,
the per-player state banks, the PLAYER/BALL panel cards, the per-player
high-score walk and the front door's stepper are all decoded from main.seg00's
ball-end state and documented in `research/MULTIPLAYER_DECODE.md`. A
one-player game is byte-identical to what it was, which `tests/sim-hash-pin.
test.ts` proves rather than promises.

The INTRO ANIMATION shipped the round before: `intro.bin`'s FreeAnim stream is
decoded (`research/INTRO_DECODE.md`) and plays on every cold load, and its
SNT! tune had already shipped as the front-end music the menus play.

The BONUS LADDER count-up.

Six of Law 'n Justice's seventeen sound records, which are reachable only from
table-native 68000 code this port does not run, or hang off a pointer ladder
with no decoded consumer. Unbindable without new decode work, so unbound rather
than guessed.

And one thing that is measured, understood, and deliberately left alone. Coming
down Law 'n Justice's left orbit the machine turns 14.13 degrees off vertical at
the first arch contact and leaves the wall to coast; this port turns 7.58 and
grinds along it, arriving about 1.5 px/tick slow. The wall there is a
three-pixel staircase, and the machine's own cold launches take that same
contact anywhere from 10.78 to 14.13 degrees depending on a quarter-pixel of
launch timing. A response that swings 3.35 degrees per quarter pixel cannot be
fitted; closing it would mean tuning to one draw. It needs a decoded rule for
staircase normals, and until someone has one the honest state is a measurement,
not a fix. See the session-4 trace under `research/view/reference/`.

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
- **The lamp overlays are disk-derived, and gated the same way.** Each table's
  insert positions, mask shapes and the masked lamps' two image states are
  decoded into `public/generated/tables/*.lamps.json` under the
  `disk-derived-lamp-overlays` marker. Functional presentation data: no audio,
  no executable code.
- **The flipper bats and the ball are disk-derived, and gated the same way.** The
  bat pose bank goes into `public/generated/flipper-bats.json` under the
  `disk-derived-flipper-sprites` marker and each table's ball into
  `public/generated/tables/*.ball.json` under `disk-derived-ball-sprite`, both
  carrying the sha256 of the source bytes. Still images only: no audio, no
  executable code, and no palette — both draw through the artwork palette that
  already ships. The pixels live INSIDE the JSON, so there is no extra raster file
  beside them, and `npm run guard:public` refuses a build containing either
  unless the authorization variable is set.
- **THE SOUND EFFECTS ARE DISK-DERIVED. This changed, and the change matters.**
  This section used to say audio was "newly created — synthesised or
  independently recreated rather than sampled", and while the missions were being
  decoded the sound records turned out to be decodable too. So the effects now
  shipped are the machine's own samples — the tables' out of the `SNT!` banks,
  the engine's out of `main.bin` hunk 11 — at the Paula period each sound record
  names, written to `public/generated/tables/*.wav` and `public/generated/engine.snd-*.wav`
  and claimed by `disk-derived-audio` manifests carrying each file's sha256.
  Several of them are speech, which is a heavier rights question than a still
  picture, so they go through exactly the same authorization gate: `npm run
  guard:public` refuses a build containing a sound file no manifest accounts for,
  or one whose bytes do not match its recorded digest, unless the operator sets
  the variable.
- **THE FRONT-END MUSIC IS DISK-DERIVED TOO, and this bullet used to deny it.**
  It said "no music is shipped — the modules' packed pattern format is not
  decoded, so there is nothing here that could play a tune". Both halves are now
  false. The packed cell format IS decoded (`scripts/export-shell-music.mjs`,
  from the playback decoder at `main.seg00 $7F8A-$7FE6`), and the original
  front-end module ships: the `SNT!` bank in `intro.bin`, as a JSON document
  plus one 8-bit WAV per live instrument, under a `disk-derived-shell-music`
  manifest carrying each file's sha256, through the identical gate. A raw
  `.mod` still cannot ship — that extension is on the guard's forbidden list and
  stays there. What is published is a decoded document and digest-claimed
  samples, never a module file.
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

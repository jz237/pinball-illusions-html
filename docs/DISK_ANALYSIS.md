# Disk analysis — Pinball Illusions (AGA, 4 disks)

Read-only analysis of the operator's own IPF preservation images. **No byte extracted
from these disks is committed to this repository or shipped in any build.** Derived
files live only under `D:\Projects\_pinball_research\illusions\` on the local machine.
This document records measurements and structure — the facts needed to reimplement
behaviour — not payload.

## Source custody

| IPF | Bytes | SHA-256 |
|---|---:|---|
| `PinballIllusions_Disk1.ipf` | 1,049,612 | `5253f362083e018caa246d59ec335b71b4ae4b78dda37ed91fe07bb254e46ffb` |
| `PinballIllusions_Disk2.ipf` | 1,049,612 | `6b805c45220e2ed49506a9d7cce247240316dd31e775dfa64787da4eb2acb009` |
| `PinballIllusions_Disk3.ipf` | 1,049,612 | `3a00cc6ce17e984da6ddeb5e3002ea69a4c4138e09b5c302f486ee3d9d46b172` |
| `PinballIllusions_Disk4.ipf` | 1,049,612 | `22cd54af4e0e6d27213820499c934fde0f7a535773fed693fa6394c89b9b22aa` |

All four carry the CAPS/SPS container magic `43 41 50 53` (`CAPS`).

## Format: plain AmigaDOS — a major simplification vs. Pinball Dreams

Keir Fraser's `disk-analyse` format table classifies this release as:

```text
"Pinball Illusions AGA" = amigados
```

No custom track encoding and no copylock. This is the important structural difference
from Pinball Dreams, which used a bespoke track format requiring a RawDIC-style
track-list reconstruction and an embedded four-character-name file directory.
Illusions is an ordinary FFS filesystem, so the contents are directly enumerable.

Reproduce the conversion:

```powershell
$da = "D:\Projects\_pinball_research\disk-utilities\disk-analyse\disk-analyse.exe"
foreach ($n in 1..4) {
  & $da -q -f "Pinball Illusions AGA" `
    "D:\Projects\Pinball Illusions\PinballIllusions_Disk$n.ipf" `
    "D:\Projects\_pinball_research\illusions\PinballIllusions_Disk$n.adf"
}
```

Each output is exactly 901,120 bytes — a standard double-density Amiga ADF.
`CAPSImg.dll` is used only as a local input decoder and is not redistributable.

Enumerate with `amitools`:

```powershell
$env:PYTHONPATH = 'D:\Projects\_pinball_research\pydeps'
python -m amitools.tools.xdftool <disk>.adf list
```

## Volume layout

Four volumes, `PIN3001`–`PIN3004`, all `DOS1:ffs`, block size 512. File timestamps
run 1995-01-04 to 1995-04-05, consistent with the 1995 AGA release.

### Disk 1 — `PIN3001` (boot and shell)

| File | Bytes | Role (inferred) |
|---|---:|---|
| `Pinball` | 25,044 | Loader / launcher executable |
| `main.bin` | 92,600 | Main shell program |
| `intro.bin` | 658,938 | Intro sequence (graphics + music) |
| `menudata.bin` | 36,000 | Shared menu presentation data |
| `tables.bin` | 104 | Table index — see below |
| `table001.mnu` | 10,092 | Law 'n Justice menu definition |
| `table002.mnu` | 11,266 | BabeWatch menu definition |
| `table003.mnu` | 11,458 | Extreme Sports menu definition |
| `Libs/lowlevel.library` | 6,920 | Commodore library (joypad/CD32 input) |
| `Libs/nonvolatile.library` | 3,588 | Commodore library (score persistence) |
| `Scores/PinballIllusions/Table001..003` | 50 each | Per-table high-score files |
| `S/Startup-Sequence` | 41 | Boot script |
| `Prefs/Env-Archive/Sys/nv_location` | 15 | Non-volatile storage location |

### Disks 2–4 — one table each

| Disk | Volume | Table package | Bytes | Companion files |
|---|---|---|---:|---|
| 2 | `PIN3002` | `Table001.bin` | 732,534 | `flipdat1.bin` (136,288), `table001.opt` (70) |
| 3 | `PIN3003` | `Table002.bin` | 753,788 | `music001.bin` (85,568), `table002.opt` (70) |
| 4 | `PIN3004` | `Table003.bin` | 757,888 | `table003.opt` (70), `HD_Install` (3,159), `Installer` (69,568) |

Each table is a single self-contained ~750 KB package. `flipdat1.bin` appears once
(disk 2) and is presumably shared flipper animation/behaviour data loaded for every
table; `music001.bin` likewise appears once and is presumably the shared or
BabeWatch-jukebox music bank. Both inferences are **unverified** and must be
confirmed before being relied on.

## `tables.bin` — the table index (104 bytes)

Three fixed 34-byte records followed by a `FFFF` terminator. Record shape:

```text
u16  table_id          (1, 2, 3)
u16  reserved          (0)
u16  name_field_len    (0x001C = 28)
u16  reserved          (0)
char name[23]          space-padded
u8   trailer[3]        00 00 03
```

Canonical in-game table names, exactly as stored:

| id | Name |
|---:|---|
| 1 | `Law 'n Justice` |
| 2 | `BabeWatch` |
| 3 | `Extreme Sports` |

This settles two questions the secondary sources disagree on. The release on these
disks has **three** tables — the fourth table, *The Vikings*, was produced by the
porting team for the PC CD-ROM and console versions and is absent here. The
apostrophe form is `Law 'n Justice` (no second apostrophe), and `BabeWatch` is one
word with a medial capital.

## `table00N.opt` — per-table option defaults (70 bytes each) — SETTLED

Seven 10-byte records. Record shape, **measured** from the loader that consumes them:

```text
s16 minimum
s16 maximum
u16 current      (0 in every record of every shipped file)
u16 default
u16 terminator   (FFFF)
```

`main.seg00` +0x00333C reads the 70 bytes; +0x0009E6 walks the seven records writing
`default -> current` (`move.w $6(a0),$4(a0)`); +0x0009FE copies the seven currents into
`$E84(a5)..$E90(a5)`, one word each, in order. Every reading below is the *consuming
instruction*, found by scanning every even offset of the 53 KB segment body for that a5
displacement and checking the opcode word in front of it — so each row states not only
what a record means but how many places in the whole program can see it.

Zero-indexed to match `$E84 + 2n`, and byte-identical across all three tables except
record 5's default:

| # | live word | min | max | default | Meaning | Readers |
|---:|---|---:|---:|---:|---|---|
| 0 | `$E84` | 3 | 5 | 3 | Balls per game | — |
| 1 | `$E86` | 2 | 8 | 4 | **Gravity**: added to the ball's Y acceleration once per sub-step | +0x003500 (seeds a ball), +0x00B758 (the add) |
| 2 | `$E88` | 1 | 7 | 5 | **Camera scroll divisor**: `step = (ballY - scrollY - anchor) / divisor` | +0x006D6A only |
| 3 | `$E8A` | 0 | 200 | 100 | **Tilt sensitivity**: counts added to a warning counter that trips at 200 | +0x00BE9A only |
| 4 | `$E8C` | −3 | +3 | 0 | **Table x-tilt**: added to the ball's X acceleration beside gravity | +0x003500 (seeds a ball), +0x00B754 (the add) |
| 5 | `$E8E` | 0 | 10 | 5 (**Extreme Sports 10**) | A duration in whole **seconds**, consumed at +0x0049AE as `option x VBlankFrequency` frames for the ball-start countdown | +0x0049AE |
| 6 | `$E90` | 0 | 2 | 2 | **View mode**: 0 narrow and locked, 1 wide, 2 narrow with the script allowed to widen | +0x003514, +0x005A26 |

### The camera follower, record 2

+0x006D5A is the whole vertical camera and it is thirteen instructions. `$DA8` is the
followed ball's row, `$DA4` the top visible playfield row, `$D9E` the anchor and `$DA0`
the maximum scroll:

```text
006D5A  err  = $DA8 - $DA4 - $D9E
006D6A  step = err / $E88                    ; divs.w, truncates toward zero
006D6E  bpl -> the downward branch
        UP:   if $DA4 <= 32: step >>= 1      ; asr.w #1, a soft landing at the top
              $DA4 += step, floored at 0
        DOWN: if $DA0 - $DA4 is in -49..-1: do not scroll at all
              step >>= 1                     ; downward tracking is ALWAYS half rate
              $DA4 += step, clamped to $DA0
006DAC  display row = $DA4 + $D98            ; $D98/$D96 are the +-3 px nudge shake
```

There is **no dead zone and no per-tick cap**. `$D9E`/`$DA0` are set by the screen mode
rather than by an option: narrow is `$D9E = 70, $DA0 = 370` at +0x003C10, i.e. a
**230-row window**; wide is `$D9E = 200, $DA0 = 138` at +0x003C52, 462 rows.

The follower's fixed point is `anchor + 2 x divisor x v` for a ball falling at `v` px a
frame and `anchor - divisor x v` for one rising. **That is why the shipped default is 5**,
and it is a derivation rather than a fit: the engine's own velocity clamp is ±4095 units
= 16 px a frame, and `70 + 2 x 5 x 16 = 230` is *exactly* the narrow window's height, so a
ball at the machine's top speed sits precisely on the bottom edge and never leaves it.
Divisor 6 gives 262 and divisor 7 gives 294, both off the bottom. Upward, `70 - 5 x 14 = 0`
and 14 px a frame is the measured full plunge, so a plunge puts the ball precisely on the
top edge. Four separately measured numbers — the clamp, the anchor, the window height and
the divisor — close on each other to the pixel.

The followed ball is the **lowest** one: +0x00BEF0 seeds from the first ball and then keeps
any ball with a larger Y (`cmp.w $da8(a5),d1 / bcs` at +0x00BF2C), skipping any at or below
row 600.

### The tilt rule, record 3

+0x00BE90 is the tail of `$BC24`, entered with no `rts` between it and the flipper
animation loop that precedes it:

```text
00BE90  d0 = $23EF AND $23EE       ; a direction went live THIS pass
00BE98  beq -> skip the add
00BE9A  $23F0 += $E8A(a5)          ; warning += SENSITIVITY
00BEA2  cmpi.w #$C8,$23F0 / bcs    ; 200
00BEAA  st.b $23ED                 ; TILT
00BEAE  if $23F0 != 0: subq.w #1   ; and it decays on EVERY pass, nudged or not
```

Two things decide what that means in nudges and neither is in the routine itself:

- **The add is once per key PRESS.** `$23EE` has all three bits re-armed by
  `ori.b #$7,$23ee(a5)` at +0x00BC28 on every call, and the per-direction blocks at
  +0x00BC34/+0x00BC9C/+0x00BCDC `bset` `$23EF` and then `bclr` the matching `$23EE` bit
  only when the bset found the bit already set. So the AND is non-zero on the pass a
  direction first goes active and zero on every pass it is held. The key bytes `$ED2`,
  `$EF8`, `$EF9` are never written in hunk 0 — the keyboard handler sets them on key-down
  and clears them on key-up — so a held key counts exactly once.
- **The decay is four a frame.** `$BC24` is called once per COLLISION PASS: +0x00A65A,
  +0x00A6A4, +0x00A6EE, +0x00A736, and four times over in each of the two no-ball paths at
  +0x00A750 and +0x00A770. 200 counts a second.

So at the shipped sensitivity of 100 against a threshold of 200: one nudge drains to
nothing in 25 frames (half a second); **two nudges can never tilt** (100 + (100−4) = 196 at
the very best); **three inside half a second do**. Sensitivity 0 makes the table
untiltable and 200 tilts on the first shove. `$23F0` is cleared at ball and game start
(+0x0045F2, +0x004A80, +0x005052, +0x0054B6) and `$23ED`, while set, suppresses the surface
handlers at +0x00B216 and +0x00B234, so kickers and scoring go dead.

### What the previous reading was, and why it survived eleven commits

The day-one decode read the record as `{u16 current, u16 max, u32 default, u16 FFFF}` and
labelled the seven as *balls, players, three unknowns, table slope, nudges before tilt, and
a multiball cap*. It produced the right **defaults** — because "u32 default" is
current(=0) followed by default, so the low word of the long is the right number — which
is precisely what made it look verified. Every check anyone ran was "do the published
defaults come out?", and they did.

The single most durable piece of it was **"nudges before tilt: 5, 5, 10 — Extreme Sports
tolerates twice as many"**. That is record 5, and it is a duration in whole SECONDS
(+0x0049AE multiplies it by `VBlankFrequency` and counts frames). The same three numbers,
meaning something else entirely, attached to the one record that actually does vary between
tables — so the reading came with its own corroborating "parity fact". It was carried as
**[disk]** for eleven commits and quoted throughout the project, and it was wrong in every
respect except the digits.

Two lessons are worth keeping with the correction rather than in a postmortem: a decode
that reproduces the values it was derived from has not been tested, only restated; and a
record's *meaning* is established by the instruction that consumes the live word, never by
the plausibility of its range. Every row of the table above now names that instruction.

**The option labels do not exist as text anywhere in the shipped data.** There is no
options screen in this release; the only menu descriptor in the program has three items
(`Tables`, `Exit`, `Info`). Any option name in this reconstruction is the project's own
invention. The semantics are facts; the words are not.

## The `TSL!` package container — solved

Every packaged file on these disks (`main.bin`, `Table00N.bin`, `music001.bin`,
`table00N.mnu`) shares one container. All fields big-endian:

```text
char  magic[4]        'TSL!'
u16   segment_count
repeat segment_count:
    u32  type_flags
    u32  decompressed_size
u8    payloads[]      concatenated, in descriptor order
```

Payloads are Imploder streams beginning `ATN!`, whose own header repeats the
decompressed size. `type_flags & 0xFFFF` is the content class — **0 for
relocatable 68000 code, 2 for data**.

**Bit 16 (`0x00010000`) is BSS**: allocate `decompressed_size` bytes at load
time; **no payload is stored in the package** and the splitter must consume zero
input bytes for such a descriptor. This mirrors Amiga hunk BSS, which fits,
since slot index equals hunk number.

This was first mis-read as "segment stored raw", and the mistake is worth
keeping on record because of how it failed: the splitter copied `declared` bytes
out of the file for `main.bin`'s descriptor 9, which sliced payload belonging to
descriptors 10 and 11 into a bogus `.raw` file and silently never extracted the
real final two segments. The correction was proven by accounting, not
plausibility: `main.bin` declares 12 segments but contains 11 `ATN!` streams,
and the stream after descriptor 8's declares 228 bytes — descriptor 10's size,
not descriptor 9's 11,664. Decisively, `menudata.bin` declares two
`0x00010002` segments of **81,920 bytes each — 320×256, a screen buffer — in a
36,000-byte file**, which could not possibly be stored. With BSS handled, every
package's payloads consume its file exactly, including `intro.bin` (BSS
allocations of 512 and 249,600 bytes).

`flipdat1.bin` is the exception: no `TSL!` magic, no compression — a flat raw file.

Verified by splitting and decompressing with Teemu Suutari's `ancient` (a clean,
permissively licensed decompressor — the original depacker is not reused):

```powershell
python D:\Projects\_pinball_research\illusions\split_tsl.py `
  D:\Projects\_pinball_research\illusions\seg `
  D:\Projects\_pinball_research\illusions\pkg\Table001.bin
```

All nine `Table001.bin` segments decompress to **exactly** their declared sizes,
which confirms the model rather than merely fitting it.

### `Table001.bin` segment inventory

Total decompressed 1,356,740 bytes from a 732,534-byte package. Classification
below combines the type flag with a byte-value histogram; the flags are fact, the
role column is inference.

| # | flag | Bytes | Byte-value character | Likely role |
|---:|---:|---:|---|---|
| 0 | code | 472 | 68000 opcodes, jump table, relocations | Per-table entry stub |
| 1 | data | 75,320 | dominated by small values (13, 3, 4, 1, 15, 9) | **Collision/material map candidate** |
| 2 | data | 102,488 | 72% zero, 9% `0xFF` | 1-bit mask / bitplane |
| 3 | data | 238,856 | 39% zero, 15% `0xFF` | Bitplane imagery |
| 4 | code | 47,644 | 68000, 67% zero | **Per-table rules and scoring** |
| 5 | data | 406,500 | zero, `0xAA`, `0x81`, `0x82` | Playfield bitplanes (`0xAA` is a dither signature) |
| 6 | data | 55,488 | 44% `0xFF`, 18% zero | Mask, inverted sense |
| 7 | data | 265,076 | flat, all 256 values | Audio samples |
| 8 | data | 164,896 | flat, all 256 values | Audio samples |

Segment 0 contains recognisable 68000: `4EF9` (JMP long) forming an entry jump
table, `4E75` (RTS), and a leading table of u32 offsets. Segment 4 is the large
code module and is therefore the authoritative source for mission structure and
scoring values on this table.

### Data-segment preamble

Every data segment opens with an 8-byte preamble whose leading `u32` is the payload
length, always `segment_size - 8`. Verified on slots 1, 2, 3, 5 and 6. Pixel data
starts at offset 8.

### The playfield map — found, at 336 x 600 in four layers

Slot 2 is the hidden playfield map, and its geometry is now established rather than
guessed.

Row stride was measured by autocorrelation (`stride.py`) rather than inferred from
factorisations. Slot 2 peaks sharply at **lag 42** at 1.48x the mean agreement, with
clean harmonics at 84, 126, 168, 210, 252, 294, 336 and 378 — every multiple of 42
and nothing else. A 42-byte stride is 336 pixels at one bit per pixel.

After the 8-byte preamble, 102,480 bytes divide by 42 into **exactly 2,440 rows**.

Rendering those rows as a 1-bit image (`render.py`) resolves the rest: the segment
is **four stacked panels — 620, 620, 600 and 600 rows** — and each panel is
recognisably the same pinball playfield — shooter lane and rails on the right, wireform ramps across the
top, bumper circles and rollover buttons mid-table, slingshots and drain lanes at the
bottom. Curves render smooth and vertical rails render perfectly vertical, which is
the proof that the stride is correct; a wrong stride shears the image diagonally.

```text
playfield        336 x 600 pixels
storage          4 sequential layers, 42 bytes per row
layer rows       620 / 620 / 600 / 600
layer offsets    0 / 26040 / 52080 / 77280   (after the 8-byte preamble)
physics area     the first 600 rows of each layer
```

**Current state, so no reader has to infer it:** the shipped maps under
`public/generated/tables/*.map.json` were re-exported under the 620 / 620 / 600 / 600
bases above and **are correct and current**. Their material-index censuses are the
corrected ones — Law 'n Justice `0: 108,789`, `3: 4`, **no index 9**; Extreme Sports
`9: 1`. Any statement anywhere that these files are vertically misaligned, or that
they were exported as four equal 25,620-byte planes, is stale and false. The
paragraph below is **history**: it records the superseded decode and how it was
caught, because that is worth keeping, but it does not describe any file in the repo
today.

**Superseded decode (historical).** The layout was first recorded as four equal
610-row planes at `0 / 25620 / 51240 / 76860`. That is wrong, and instructively so:
both partitions
total exactly 102,480 bytes, so every size and divisibility check passes either way
while three of the four layers sit out of registration by 10, 20 and 10 rows.
Rendering looked plausible because each layer is individually a valid image.

Two independent lines of evidence settled it:

1. The slot-0 pointer descriptor in the table code gives the four offsets directly.
2. Bit 0 is a collision outline of the structure carried in bit 2, so the outline
   must lie *inside* the area it outlines. Scanning the vertical offset that
   maximises that containment peaks sharply at exactly **+20 rows** on all three
   tables — 0.976, 0.963 and 0.970, against roughly 0.6 elsewhere.

Re-decoding under the corrected bases reproduced the independently predicted census
exactly (index 0: 108,789; index 4: 65,819; index 5: 11,410; index 14: 8,644), and
made index 9 vanish while index 3 appeared — both predicted in advance. Agreement
from two directions on figures neither method could fake.

### The map is two-level, and only one bit is collision

The four layers are not four planes of one picture. Each bit means something
different:

| bit | value | meaning |
|---:|---:|---|
| 0 | 1 | lower-level collision line — **the only bit the physics tests** |
| 1 | 2 | upper-level collision line |
| 2 | 4 | lower structure / occlusion artwork |
| 3 | 8 | upper structure / occlusion artwork |

So a pixel blocks a ball on the lower playfield exactly when **its index is odd**.
The structure bits are artwork drawn over the ball, not geometry — which is why
index 4, at roughly a third of every table, is passable despite looking solid, and
why index 14 (ramp guide rails, ~4% of the table) is passable at ground level: the
ball rolls underneath it.

This also explains the earlier "six thin-stroke wall classes" reading. There are
not six wall materials; there is one collision line (bit 0) crossed with the two
structure masks and the upper-level line, which produces six *combinations*.

#### Does bit 2 block the lower-level ball? — SETTLED: no. Do not reopen.

Bit 2 covers 45.1% / 46.7% / 36.8% of the three tables, so whether it blocks was the
largest open question in the physics: it is the difference between a playable table
and a sealed one. **It is now closed.** Four independent investigations were run —
connectivity flood-fill on all three tables, two 68000 disassemblies started from
opposite ends of the engine, and structural boundary (outline-inside-fill) analysis.
**All four concluded, unanimously, that bit 2 does not block the lower-level ball.**
Confidence: **high**. The disassembly is decisive; the geometry corroborates it;
nothing dissents. Treat this as established fact and do not re-derive it.

The decisive numbers, all reproduced below in full:

- Treating bit 2 as solid **seals the plunger lane on 2 of the 3 tables** — the ball
  is launched and permanently trapped.
- It **seals Law 'n Justice's entire upper playfield: 0 reachable pixels, against
  44,549** with bit 0 alone.
- It destroys **84–96%** of the upper playfield on the other two tables.
- The result holds unchanged at ball radii **0, 1, 2 and 4**, so it is topological
  and **not an erosion artefact**.

**The one genuine caveat, stated plainly:** this refutes bit 2 blocking the
**lower-level** ball only. Bit 2 may still be the **upper deck's** wall set for a
ball riding the second level. That reading is untested — nothing here confirms or
denies it — and it must be tested on its own terms before upper-level physics is
written. It does not weaken the lower-level verdict in any way.

**Method 1 and 2 — disassembly** (capstone M68K over `seg/main.seg00.bin`, 58,448
bytes; address == file offset, established by checking that all 605 `jsr` absolute
operands are even and in range). Every byte pattern quoted below was re-verified by
direct search, and each is the **only** occurrence in the entire engine:

| file offset | bytes | meaning |
|---|---|---|
| `+0x00B43E` | `226C 0054` | `movea.l $54(a4),a1` — the collision plane pointer |
| `+0x00B47E` | `3D7C 0026 0064` | `BLTAMOD = 38` |
| `+0x00B492` | `0040 0BA0` | `ori.w #$0BA0,d0` → `BLTCON0` |
| `+0x00B4AE` | `3D7C 0442 0058` | `BLTSIZE` = 17 rows x 2 words |
| `+0x00A7FA` | `082E 0005 0002` | `btst.b #5,$2(a6)` — DMACONR bit 13, `BZERO` |
| `+0x0009CC` | `0642 002A` | `addi.w #$2A,d2` — map row table stride 42 |
| `+0x00BF3C` | `266C 0058` | `movea.l $58(a4),a3` — the *other* per-level plane |
| `+0x00BFDC` | `4680` | `not.l d0` — the sprite occlusion mask |

Four findings follow, and together they close the question:

1. **The test is a blitter AND over one bitplane.** `BLTCON0 = $0BA0` is
   `USEA|USEC|USED` with minterm `$A0 = A!BC + ABC`, which expands to exactly
   `D = A AND C`, independent of B. A is the map, C is a static 17×17 ball ring, D
   is a 68-byte scratch buffer, and collision is `D != 0` read as `BZERO`. One bit
   per pixel — no nibble assembly, no 16-entry material LUT, no OR of two planes
   anywhere on the path. The ring itself is `main.seg02.bin` (144 bytes): 17 longs
   from offset 4 forming a circle outline of exactly **44 set pixels**, which
   matches the 44 hard-coded direction weights in the normal analyser at
   `+0x00A9C8` and the analyser's `d7` range of 0..43. Three independent
   confirmations of the same number.
2. **The stride pins it to a single plane.** `BLTAMOD 38` with a 2-word blit width
   gives a source row stride of 4 + 38 = **42 bytes = 336 pixels at 1 bit per
   pixel**. That is one layer, not four. The runtime-built map row table at
   `+0x0009CC` steps by the same 42 for 600 entries.
3. **Bit 2 cannot physically be the source.** The blit reads 17 rows starting at map
   row `y`, and the guard at `+0x00B29E` is `cmpi.w #600,d1` — `y` up to 600 is
   allowed, so rows up to **616** are fetched. Layers 0 and 1 are 620 rows; layers
   2 and 3 stop dead at 600. Only the two 620-row layers can service that
   look-ahead, and their surplus rows are verifiably padding (0 set bits above row
   599 on layer 0; 29 and 32 on layer 1 for tables 1 and 2). Bit 2 is a 600-row
   layer, so it can never be the blit's A source.
4. **Bit 2's real job is positively identified.** `$58(a4)` is read at exactly one
   site, `+0x00BF3C`, inside the ball **draw** routine, where the plane word is
   NOT-ed and ANDed into each of the sprite's bitplanes so structure is drawn in
   front of the ball. It never touches position or velocity. A 37–47% coverage mask
   is exactly what "artwork drawn over the ball" looks like and is nonsense as
   walls.

**Method 3 and 4 — connectivity and morphology** on all three decoded maps
(336×600, exact-Euclidean disk erosion at the 8 px ball radius, 4-connected
labelling, flood fill from the drain). Blocking bit 2 in addition to bit 0 is
catastrophic:

| | Law 'n Justice | BabeWatch | Extreme Sports |
|---|---|---|---|
| reachable, bit 0 only | 130,138 px (64.6%) | 107,145 (53.2%) | 114,368 (56.7%) |
| reachable, bit 0 + bit 2 | 55,460 px (27.5%) | 67,328 (33.4%) | 60,942 (30.2%) |
| plunger lane reachable | yes / **no** | yes / **no** | yes / yes |
| upper playfield reachable | 44,549 px / **0** | 27,079 / 1,080 | 30,584 / 4,767 |
| free regions | 33 → 97 | 27 → 44 | 26 → 42 |

Adding bit 2 seals the plunger lane on two of three tables — the ball is launched
and permanently trapped — and seals or destroys 84–96% of the upper playfield on
all three. This holds at ball radii 0, 1, 2 and 4, so it is topological, not an
erosion artefact. Rendered, the bit-0-only masks are immediately recognisable
pinball tables (outer orbit, plunger lane, top arch, bumpers, slingshots, flippers,
outlanes, all one connected component); the bit-0-plus-bit-2 masks are black with a
small pocket around the flippers.

The reason bit-2 bodies *look* solid is that **bit 0 is a collision outline lying
inside the bit-2 body** — containment 98.2% / 96.6% / 97.5%, and 99.3% / 98.3% /
99.0% within one pixel. On compact objects the outlining is essentially perfect:
individual slingshot, inlane-guide and ramp bodies score 89–100% of their boundary
carrying a bit-0 line. So the bit-2 fill extends past the collision line as bevels,
shadows and painted inserts, and bumper and slingshot *interiors* come out free but
unreachable — which is correct behaviour, not a leak. The same pairing holds
independently for bit 1 inside bit 3 (98.2% / 92.6% / 97.4%), which was not used
when the +20-row alignment was fitted, so it is fresh confirmation of the decode.

**Also ruled out, so nobody re-runs them:** any per-pixel material LUT (no 16-entry
and no power-of-two bit-mask tables exist in `main.seg00/01` or in any `Table00N`
slot); byte-granular bitplane indexing (zero `lsr #3` in the engine); and the plane
offsets being computed in code (the constants 26040 / 52080 / 77280 / 102480 appear
in no code segment — the four planes arrive as four independent pointers).

**Still unverified, and left visibly so:**

- *Which* of the two 620-row layers is the lower level. `$54(a4)` is loaded from
  `$22F2(a5)` for level 0 and `$230A(a5)` for level 1, and those pointers are
  block-copied at `+0x0032F2` from a table-package header that is zero-filled on
  disk, so the layer→level mapping is **inferred** from stroke geometry and the
  outline/fill pairing, not read. If it were inverted, the blocking bit would be
  bit 1 rather than bit 0 — but bit 2 would still not block, so the verdict above
  is unaffected. Closing this needs an emulator dump of `$22EE(a5)..$2302(a5)`.
- The vertical anchor of the 17-row probe window (rows `y..y+16` assumed). Even a
  centred window still exceeds 600 rows, so finding 3 survives either way.
- Whether per-table script code in the slot-0/4 segments performs an *additional*
  test against bit 2. Not exhaustively disassembled; no blitter setup with a
  42-byte modulo exists in those slots.
One dissenting *recommendation* (not a dissenting verdict) is worth recording: the
fourth investigation observed that bit 0 alone lets an 8 px ball pass through 9–13
narrow gateways into the top half of the table, and proposed `bit 0 | bit 1` as a
single-plane approximation for a one-level reconstruction. That is rejected here on
the disassembly: the engine keeps an explicit level flag at `$8(a4)` and swaps the
collision plane pointer per level (`+0x0053C6` lower, `+0x0053F4` upper), so the
lower ball reads bit 0 **alone** and the top arch and orbits genuinely are lower
playfield. Confining the lower ball is the job of a level state machine, not of
ORing the upper level's outline into the lower test.

**Conclusion, unchanged from the working rule but now evidenced:** a pixel blocks a
ball on the lower playfield **iff its index is odd**. Indices 4, 6, 12 and 14 stay
passable.

#### The Law 'n Justice top-border gap — a map property, not a physics bug

On Law 'n Justice, rows `y = 0..19` carry **no bit-0 line at all**. The collision
layer therefore does not wall the very top of the raster, and a ball can drift above
where the top arch should be and travel across the **full 336 px width**.
**BabeWatch and Extreme Sports show no such gap** — only Law 'n Justice's top border
is open. (An earlier note claimed Extreme Sports had the same empty band; re-checked
against the shipped maps, it does not.)

This is a property of the shipped map, **not** a defect in the collision code and
**not** evidence that bit 2 blocks. The fix belongs in the table definition as a
**virtual wall**, not in the physics:

- Forcing rows `y < 26` solid leaves connectivity **fully intact**: reach 60.3%,
  shooter lane 7,367 px, upper playfield 36,021 px — nothing is sealed off.
- Forcing `y < 30` solid **breaks the plunger feed**.

So the real top-arch feed sits at **`y = 26..30`**, which is exactly where a
plunger-lane exit over the top arch belongs. A virtual wall at `y < 26` is therefore
both safe and correct; anything at or above `y = 30` is not.

In the current reconstruction the escape is incidentally contained because
`OUT_OF_BOUNDS_MATERIAL` is index 5 and off-map probes read solid — but that is a
side effect, not the intended geometry, and the virtual wall should be made explicit.

Four layers give 16 distinct per-pixel values. Note that this is **not** an index
into a 16-entry material table: no such table exists anywhere in the engine (see
"Also ruled out" above). The four bits are independent masks and only bit 0 is read
by the lower-level collision test.

### Material index census — as shipped, under the corrected bases

These are the censuses of the current `public/generated/tables/*.map.json`, read
straight out of the files' own `materialHistogram`. Each table is 336 x 600 =
**204,960** pixels. Percentages are of the whole playfield.

| idx | Law 'n Justice | % | BabeWatch | Extreme Sports | Blocks lower ball? |
|---:|---:|---:|---:|---:|---|
| 0 | 108,789 | 53.08 | 105,715 | 122,375 | no |
| 1 | 237 | 0.12 | 601 | 337 | **yes** |
| 2 | 132 | 0.06 | 290 | 211 | no |
| 3 | 4 | 0.00 | 41 | 30 | **yes** |
| 4 | 65,819 | 32.11 | 52,317 | 36,187 | no |
| 5 | 11,410 | 5.57 | 12,171 | 8,500 | **yes** |
| 6 | 41 | 0.02 | 185 | 24 | no |
| 7 | 25 | 0.01 | 159 | 139 | **yes** |
| 8 | 1,134 | 0.55 | 601 | 3,413 | no |
| 9 | *absent* | — | *absent* | 1 | **yes** |
| 10 | 443 | 0.22 | 119 | 1,116 | no |
| 11 | 8 | 0.00 | 19 | *absent* | **yes** |
| 12 | 2,528 | 1.23 | 17,851 | 12,507 | no |
| 13 | 293 | 0.14 | 3,229 | 2,910 | **yes** |
| 14 | 8,644 | 4.22 | 5,046 | 10,748 | no |
| 15 | 2,093 | 1.02 | 3,256 | 3,102 | **yes** |

Two of these figures are the ones that adjudicated the alignment, because they were
predicted in advance and could not have been fitted: index 3 is **present but almost
empty** (4 px on Law 'n Justice) and index 9 has **vanished from two of the three
tables** (1 px survives on Extreme Sports). The superseded 610-row decode produced
the mirror image — index 3 absent, index 9 at 146 px — which is how the misalignment
was caught.

Odd (blocking) indices total **14,070 px, 6.87%** of Law 'n Justice. That is the
whole of the lower-level collision geometry, and it is consistent with bit 0 being a
one-pixel outline: Law 'n Justice carries **41 horizontal and 11 vertical solid runs
exactly one pixel wide**, so any collision scheme that cannot see a 1 px wall is
broken by construction.

The remaining structural reading:

- **Two area classes** (0 and 4) cover 85.2% of Law 'n Justice between them. Index 0
  is open playfield; index 4 is bit-2 structure artwork, passable, drawn over the
  ball.
- Index 12 is bit-2 plus bit-3 — structure on both decks — and is far larger on
  BabeWatch and Extreme Sports (8.7% and 6.1%) than on Law 'n Justice.
- The earlier "six thin-stroke wall classes" reading is **superseded**. There are not
  six wall materials; there is one collision line (bit 0) crossed with the two
  structure masks and the upper-level line, which yields eight odd combinations.

Which odd index maps to which *behaviour* — rubber, slingshot, plain wall, ramp
edge — is **still open**, and cannot be settled from geometry alone. It needs the
collision constants in the slot 4 code or observation of the original in motion.

Because slot 2 is the same size on all three tables, **all three playfields share
these dimensions**. One decoder and one geometry pipeline serve the whole game.

Slot 3 is also a clean raster: autocorrelation peaks at **lag 48** (1.88x mean,
harmonic at 96), and 238,848 divides by 48 into exactly 4,976 rows — 384 pixels
wide. Its role is not yet identified.

Slots 1 and 5 show **no raster periodicity at all** (best lags barely above the
mean), so neither is a simple bitmap. Slot 1's earlier "collision map candidate"
reading was wrong: the small byte values are real, but the data is not a raster.
Slot 6 peaks at lag 64 with strong sub-harmonics at 32 and 48, which reads more like
fixed-size records than a bitmap.

### The layout is positional across all three tables

`Table002.bin` also has 9 segments; `Table003.bin` has 8. Slot roles line up by
index — slots 0 and 4 are code on every table, the rest data — so **one decoder
serves all three tables**, and Extreme Sports simply lacks the final audio slot.

| slot | Law 'n Justice | BabeWatch | Extreme Sports | Varies? |
|---:|---:|---:|---:|---|
| 0 code | 472 | 492 | 404 | per-table |
| 1 data | 75,320 | 81,748 | 85,576 | per-table |
| 2 data | 102,488 | 102,488 | 102,488 | **fixed size** |
| 3 data | 238,856 | 238,856 | 238,856 | **fixed size** |
| 4 code | 47,644 | 45,916 | 38,984 | per-table |
| 5 data | 406,500 | 364,868 | 502,472 | per-table |
| 6 data | 55,488 | 42,112 | 34,488 | per-table |
| 7 data | 265,076 | 228,040 | 380,460 | per-table |
| 8 data | 164,896 | 259,808 | *absent* | per-table |

Slots 2 and 3 hold the same number of bytes on every table but **hash
differently** — so they are not shared assets, they are per-table content in a
fixed-size allocation. A constant byte count across three different tables is the
signature of a fixed-dimension raster, which makes these two slots the best lead
for establishing playfield dimensions. Neither 102,488 nor 238,856 divides cleanly
by 40 (the bytes-per-row of a 320-pixel-wide bitplane), so a header, a different
width, or a plane count other than the obvious one is in play.

Slot 1's size grows across the three tables in the same order the packages do,
consistent with a per-table geometry map rather than a fixed structure.

## `music001.bin` — DECODED: the shell's front-end music, one `SNT!` module

The last never-decoded file on the disks is decoded, excavation only — nothing is
wired into the game. 85,568 bytes on Disk 3, a `TSL!` package with one data
descriptor (flags `0x00000002`, no BSS) declaring 0x182E8 = 99,048 bytes; the
`ATN!` stream decompresses to exactly that and the payloads consume the file
exactly. The slot is hunk-wrapped pure data: u32 body length 0x182E0, body, empty
relocation table. Clean split in `seg_clean/music001.bin.seg00.*`.

**The body is one `SNT!` bank — DICE's repacked ProTracker — holding ONE song:**
the layout `sound.py` proved for the in-table slot-7/8 banks, here with 31 sample
descriptors (12 live: indices 1–7, 9–11, 14, 15), song length 14, restart 127,
order list `[0,6,4,3,10,3,10,1,7,5,2,5,8,9]`, 11 packed patterns and 94,128 bytes
of signed 8-bit PCM ending 2 pad bytes short of the body end.

**The packed pattern cell encoding is cracked**, from the playback decoder at
`main.seg00` body `$7F8A–$7FE6`, and verified bit-exact: all 11 patterns decode to
exactly 256 cells (4 channels × 64 rows, row-major) consuming exactly their
offset-table byte ranges. A byte with bit 7 set is one whole cell — `0x80` empty,
`0xC0` "repeat this channel's previous event" (cached at channel state `$38–$3A`);
bit 7 clear opens a 3-byte event: `note = byte0 >> 1` (1-based into a 36-entry
period table), `instrument = ((byte1 >> 4) << 1) | (byte0 & 1)`,
`effect = byte1 & 0xF`, `param = byte2`. Note→period is the standard ProTracker
16-finetune × 36-note table at `main.seg00` `$A198` (stride `$48`, ft0 = 856..113;
lookup at `$83F2–$8404`). Effects present are plain ProTracker: `4`/`6` vibrato,
`C` set-volume, `EA/EB` fine slides, `F` set-speed (F08 then F04), `1`/`3`
portamento, `9` sample offset. ~3× compression against the raw 1,024-byte
ProTracker pattern.

**Who plays it:** the shell (`main.seg00`) lazily loads `PROGDIR:music001.bin` —
path string at body `$CAE7`, entry 5 of the shell's file table at `$CB22` — at
body `$E74–$E9E`: if the cache long `$D44(a5)` is empty it calls the loader
(`jsr $B90`, mode 3, which unpacks the `TSL!`), then starts the module player at
`$79EA` with d0 = start position. The player's `SNT!` parser is `$7BF8`; playback
runs on the VBlank chain `$8240/$828A` (vector `$78`, DMA-safe double interrupt).
The alternate entry `$7A24` parses the in-table banks at `$2378/$237C` instead.
So `music001.bin` is the **front-end / shell music**, one module, nothing else.

**The BabeWatch jukebox does NOT use it.** The jukebox UI strings are in
`Table002.bin.seg04` at 0x7EE0–0x8090 (`PICK A SONG`, `JUKEBOX`, `IN D JUKEBOX`,
`CHOOSE LEFT RIGHT`, `SELECT WITH RETURN`); the selectable songs are start
positions inside BabeWatch's own two `SNT!` banks (slot 7: songlen 78, 60
patterns, 196,578 B PCM; slot 8: songlen 28, 28 patterns, 195,122 B PCM), fed
through the player's start-song APIs at `main.seg00` `$815E/$8182` (d1 = bank,
d0 = 1-based order position, sentinel `$80` for 0). For the record: Table001
slot 7 is songlen 70 / 64 patterns and slot 8 is 24 / 24; Table003 slot 7 holds
TWO banks (70/63 and 16/16).

Sample character (waveform/envelope/ZCR/FFT analysis of WAV exports in the
research `view/audio/` directory — analysed, not listened to): #1 is a 2.56 s
one-shot sampled percussion phrase played only at C-3; #2–#4 looped chord/pad
clusters; #6 a looped ~350 Hz lead; #7 a 112-byte chip waveform (the only nonzero
finetune, +2); #11 a very clean deep bass (harmonics 28/56/113 Hz). Signedness and
rate sanity: mean absolute sample-to-sample delta is 4–16 of 255 (noise would be
~85), and FFT peaks sit at the period-implied rates.

Still open, none affecting the identification: which shell screen triggers the
`$E74` load site (its d0 = `$11` start argument exceeds songlen 14 and is clamped
to 0 by `$7B18–$7B2C`, so it plays the same either way); the jukebox's concrete
song-index → order-position table in Table002; whether anything streams music001's
instrument 1 through the kind-5 / `$7812` 26-byte-record path.

## Closed questions

Recorded so nobody spends effort re-opening them:

- **Where the collision map lives, and its geometry.** Slot 2, 336 x 600, four
  layers at 620 / 620 / 600 / 600 rows, offsets 0 / 26040 / 52080 / 77280 after the
  8-byte preamble. Settled. Slot 1 is *not* the collision map — it shows no raster
  periodicity at all, and that earlier reading is withdrawn.
- **Which bit blocks.** Bit 0 alone; a pixel blocks the lower-level ball iff its
  index is odd. Settled by four independent investigations.
- **Whether bit 2 blocks the lower-level ball.** No. Settled; see above. (Whether it
  is the *upper* deck's wall set remains untested.)
- **Whether the segment layout is positional across tables.** Yes — slots 0 and 4 are
  code on all three, the rest data, and slots 2 and 3 are fixed-size. One decoder
  serves all three tables.
- **Whether the shipped maps are correctly aligned.** Yes. The re-export under the
  corrected bases reproduced independently predicted census figures exactly.

## Open questions

1. The `.mnu` files are `TSL!` packages too, so the option labels are recoverable —
   decompress and read them to turn the inferred option rows above into fact.
2. Slot 1's encoding and role. Not a raster, so its earlier "collision map candidate"
   label is withdrawn; its small byte values are real and unexplained. It grows across
   the three tables in package order, consistent with per-table device or script data.
3. ~~Confirm the audio-sample reading of segments 7 and 8~~ — **CLOSED, and they are
   more than samples: the slot 7/8 banks are the tables' IN-GAME MUSIC**, full `SNT!`
   modules the engine plays through the replayer's alternate entry `$7A24`
   (`[$2378]/[$237C]` = descriptor `+$74/+$78`), driven by kind-4 cue records through
   `$6868` and the mailbox at `$2412`. Every pattern of all six banks decodes bit-exactly
   under the `$7F8A` cell encoding, tiling each bank's offset table with zero slack.
   Decoded, shipped and film-verified by `scripts/export-table-music.mjs` and
   `docs/RULES_SPEC.md` §13.3. Identify `flipdat1.bin` remains.
   (~~and `music001.bin`~~ — **CLOSED**: one `SNT!` tracker module, the shell's
   front-end music; see the section above. Correlated against the gameplay captures it
   plays no part in play — waveform NCC +0.01..+0.02, noise, on all three tables.)
4. Which of the two 620-row layers is the lower level. Inferred from stroke geometry,
   not read; closing it needs an emulator dump of `$22EE(a5)..$2302(a5)`.
5. Which odd material index carries which wall behaviour (rubber / slingshot / plain
   wall / ramp edge).
6. Whether bit 2 is the upper deck's collision plane for a ball on the second level.
7. ~~The multiball camera / resolution switch.~~ **CLOSED.** It is option record 6 and a
   script opcode: +0x005A26 compares `$E90(a5)` with 2 and calls the wide-screen setup at
   +0x003C52 if it matches. The dispatcher at +0x0058FC indexes a 4-byte table at 0x5912,
   and the entry whose handler is 0x5A26 is number 25, length 2, no operands. See
   `GAMEPLAY_PARITY.md`.
8. The original's true window HEIGHT. `$DA0 = 370` over a 600 px playfield forces a
   230-row narrow window, and the wide mode's interlaced `BPLxMOD` of `$2D0 = 2*384-48`
   corroborates the 2x relationship, but the display-window words set alongside them at
   +0x003BE0 (`$9CA = 48`, `$9CE = 208`) imply 160 lines and have not been reconciled.
   This port renders 256 rows, which is 26 more than the camera law was designed around.
9. Which of the two screen modes the game's own `F9 FOR LO-RES` / `F10 FOR HI-RES` strings
   name. `$EEA`/`$EEB` drive the same two routines from the vertical-blank handler at
   +0x00094A, but neither has been tied to a scancode.

## Rights boundary

Original disks, ADFs, extracted packages and any decoded art or audio are
preservation media. They stay on the local machine, outside this repository and
outside every build output. The shipped game is an independent reimplementation:
geometry authored as declarative shapes, artwork drawn fresh, audio synthesised or
independently recreated. `npm run guard:public` enforces this by scanning build
output for preservation formats, Amiga executables, private paths and secrets.

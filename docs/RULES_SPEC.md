# Rules specification — Pinball Illusions

What the three tables actually *do* — scoring, modes, timers and options — measured
from the operator's own disks wherever possible. Companion to `DISK_ANALYSIS.md`
(container formats, artwork, collision maps) and `GAMEPLAY_PARITY.md` (the behavioural
target). Tagging is the project's:

- **[disk]** — measured, with the byte offset that proves it
- **[src]** — from published secondary sources
- **[open]** — not established

No byte of game data is committed to this repository. Offsets refer to files derived
locally under `D:\Projects\_pinball_research\illusions\`.

---

## 0. Honest grade

This excavation went much better than the previous round, but it is **not** a complete
rules dump and nothing here is sufficient to write mode logic from.

| Area | Grade | State |
|---|---|---|
| Score/bonus representation | **A** | Fully decoded from the engine's own instructions |
| Per-event award magnitudes | **A−** | 337 award records recovered across three tables with exact values |
| Option records 1–7 | **A** | All seven identified positionally from consuming code; layout corrected |
| Mode/mission inventory | **B** | Counted and named from strings; the *rules* of each mode are unknown |
| Message/display format | **A** | Format proven against the engine's own printer |
| Which trigger fires which award | **B** | **Link found.** Two of them, both structural — see §11 |
| Mode timer values | **F** | The countdown *mechanism* is decoded; not one duration constant was found |
| Combo windows, hurry-up rates | **F** | Not found |
| Script/bytecode grammar | **D** | Two opcodes out of ~24 proven; record lengths not solved |

~~**The single most important negative:** we can now say what an award is *worth* but not
what *causes* it.~~ **SUPERSEDED — see §11.** The award values are not a table at all;
they are inline fields of the trigger and device records themselves, which is why
searching for an award table found nothing. And there are two independent
geometry-to-award keys: the per-pixel surface-id map in slot 1, whose ids ≥ 32 index a
per-level array of device records; and the 14-byte zone rectangles in each table
module, whose type-1 and type-4 records carry the award inline. Both are decoded below.
The remaining gap is the per-table SCRIPT — which mode a device starts, and how many
locks light multiball — and that has not been located.

Four independent investigators produced the underlying work. **Two of them contradicted
each other on the most load-bearing number in the document** (award magnitudes, by a
factor of 10,000), and **one declared the Law 'n Justice award table not to exist when
it does**. Both were re-measured from raw bytes for this spec and are resolved below in
§10 rather than quietly averaged. Read §10 before trusting any single prior report.

---

## 1. Offset conventions — read this first

Everything is `+4`, for the same reason across two different file types.

**Table modules** (`Table00N.seg04.bin`) are Amiga relocatable hunk images:

```
[u32 dataLen][hunk data ...][HUNK_RELOC32 blocks ...][u32 0]
```

Hunk data begins at file byte 4 — the project's known `PREAMBLE = 4`. Relocation
offsets *and* stored pointer values are hunk-relative, so:

> **file offset = data offset + 4**

This document quotes **data offsets** for table modules. Every prior report that quoted
file offsets is 4 higher. Verified: `Table001` dataLen `0x9FC8`, reloc blocks
→hunk2 ×5, →self ×1478, →hunk5 ×128, →hunk6 ×54, →hunk8 ×8, consuming the file exactly.
`Table002` `0x99A0` (3/1465/102/50/15). `Table003` `0x80A4` (4/1311/124/52/10). **[disk]**

Because the relocation tables are complete and parse to the byte, **every longword in
these modules is unambiguously classified as pointer or immediate.** That is what makes
the structural claims below checkable rather than pattern-matched. **[disk]**

**The engine** (`main.seg00.bin`) is quoted in **linked addresses**, and `file offset =
linked address + 4` there too. Verified 981/981 against the hunk-0 relocation list and
independently against the filename pointer table at blob 52006. **[disk]**

---

## 2. Shared engine

### 2.1 The table modules contain almost no code

`Table00N.seg04.bin` is a **data/bytecode module**, not 68000. Opcode census: 8 `RTS`
in Table001's 47,644 bytes, 7 in Table002, 2 in Table003; zero `JMP.L`/`JSR.L`
absolute; top word frequencies are `0x0000` ×12691, `0x0001` ×441, `0x0002` ×370 — a
small-integer distribution, not an instruction distribution. Each module carries one or
two small native islands (Table001 ≈ `0x287C`–`0x2B3C` and `0x85EC`–`0x88FC`; Table003
`0x299A`–`0x2B84`) which are the end-of-ball bonus display, and nothing else. **[disk]**

The interpreter is `main.seg00.bin` (58,448 bytes; 438 `RTS`, 605 `JSR.L`; version
cookie `Pinball_Illusions 1.7` at blob 291) and it is **shared by all three tables**.
No other `main.segNN` contains executable code. **[disk]**

Consequence for the reconstruction: there is no per-table code to port. There is a
per-table *dataset* and one engine, and the engine is where every rule actually lives.

### 2.2 Score, bonus and the player record

Scores are **6-byte packed BCD = 12 decimal digits**, big-endian nibbles. The current
player's record is pointed to by `$DC2(a5)`; `a5` is the engine's global base register.

| Player offset | Meaning | Proof |
|---|---|---|
| `+0x02..+0x07` | **SCORE** | receives the end-of-ball bonus at `0x51C6` |
| `+0x0A..+0x0F` | **BONUS** | multiplied into the bonus total at `0x5158` |
| `+0x12` (u16) | **bonus multiplier** | `DBRA` count at `0x514A`/`0x5172` |
| `+0x10`, `+0x11`, `+0x14` | byte flags (`+0x10` is an extra-ball / ball-save credit tested at `0x505E`) | |

Player array: 8 entries × 22 (`0x16`) bytes at `$DC6(a5)`; count `$DBC(a5)`; current
index `$DBE(a5)`. **[disk]**

Adder idiom throughout the engine: `ANDI #$EF,CCR` (clear X) followed by six unrolled
`ABCD -(Ay),-(Ax)`. Byte signature `023C FFEF` + six `C10B`/`C30A`. **[disk]**

### 2.3 The three award primitives — hand-decoded

Capstone will not render `ABCD`, so these were decoded byte by byte from
`main.seg00.bin`. All three take **`a3` = a pointer one past the end of a 6-byte BCD
operand**.

```
0x6B96  48E7 0088   movem.l a0/a4,-(a7)
        023C FFEF   andi.b  #$EF,CCR
        286D 0DC2   movea.l $DC2(a5),a4      ; current player
        41EC 0010   lea     $10(a4),a0       ; -> BONUS end
        C10B ×6                              ; BONUS += [a3-6 .. a3-1]
        554B 5548   subq.w  #2,a3 / #2,a0
        023C FFEF   andi.b  #$EF,CCR
        C10B ×6                              ; SCORE += [a3-14 .. a3-9]
        4CDF 1100 / 4E75
```

| Address | Effect |
|---|---|
| `0x6BCC` | `SCORE += [a3-6 .. a3-1]` |
| `0x6BEE` | `BONUS += [a3-6 .. a3-1]` |
| `0x6B96` | `BONUS += [a3-6 .. a3-1]` **and** `SCORE += [a3-14 .. a3-9]` — two adjacent 8-byte fields, one call |

**[disk]** — bytes at `main.seg00.bin` linked `0x6B96`–`0x6C0E`, quoted in full above.

This is the whole scoring machinery. There is no other adder in the engine.

### 2.4 Award record, family A — the per-table award table

Each table module holds one NULL-terminated array of pointers to award records:

| Table | Array @data | Entries | Terminator |
|---|---|---:|---|
| Table001 Law 'n Justice | `0x2746` | **123** | `0x2932` |
| Table002 BabeWatch | `0x27E6` | **116** | `0x29B6` |
| Table003 Extreme Sports | `0x27A0` | **98** | `0x2928` |

Every array slot is a self-hunk relocation — verified, no slot is an immediate. **[disk]**

Field offsets, established **empirically from the relocation table** by counting, for
each byte offset, how many of the *n* record starts have a relocation there:

| Offset | Table001 (of 123) | Table002 (of 116) | Table003 (of 98) | Meaning |
|---|---:|---:|---:|---|
| `+0x00` u16 | — | — | — | flags (`0000/0100/0200/0800/1000/1100/2000/2100/2200/2800`) |
| `+0x04` ptr | 70 | 74 | 62 | sound/effect descriptor |
| `+0x08` ptr | 14 | 9 | 10 | — |
| `+0x10` ptr | 9 | 8 | — | — |
| `+0x14` ptr | 5 | 5 | 5 | — |
| `+0x18` ptr | 78 | 67 | 60 | script / command block |
| `+0x1C` | 0 | 0 | 0 | **8-byte BCD, SCORE award** (significant `+0x1E..+0x23`) |
| `+0x24` | 0 | 0 | 0 | **8-byte BCD, BONUS award** (significant `+0x26..+0x2B`) |
| `+0x2C` u16 | — | — | — | action/type code (`0,1,5,6,7,8,0A,0B,0E,0F,10,11,12,13,14,15,16,18,1B`) |
| `+0x34` ptr | 76 | 66 | 66 | mode/feature group object — **only on the ≥0x38-byte variant** |

Records are **not fixed length**: sorted-start stride histogram is 52 ×32 / 54 ×5 /
56 ×62 for Table001, 52 ×35 / 54 ×5 / 56 ×37 / 64 ×8 for Table002, 52 ×17 / 54 ×4 /
56 ×39 / 60 ×4 / 64 ×6 for Table003. A 52-byte record has no `+0x34`. **[disk]**

The zero counts at `+0x1C` and `+0x24` are load-bearing: **no relocation lands anywhere
in `+0x1C..+0x2B` in any of the 337 records**, so those sixteen bytes are pure
immediate data in every record — exactly what two 8-byte BCD fields would be. **[disk]**

**Why the field offsets are what they are.** At `main.seg00` `0x5560`:

```
005560  47E9 002C        lea  $2C(a1),a3
005564  4EB9 00006B96    jsr  $6B96
```

With `a3 = a1+0x2C`, `0x6B96` reads BONUS from `a1+0x26..a1+0x2B` and SCORE from
`a1+0x1E..a1+0x23`. That is the *only* thing that fixes the window, and it is why the
figures below are ten thousand times larger than one prior report's (§10.1). **[disk]**

Sanity: all **337** records across the three tables decode as valid BCD in that window,
the high halfword of both 8-byte fields is zero in **all 337**, and of the **288**
nonzero award values **286** have ≤3 significant digits. The two that do not are
recorded in §5.4 as anomalies rather than smoothed away. **[disk]**

**Are the stored digits the displayed digits?** Yes, on the balance of evidence:
BabeWatch ships the string `ENABLED FOR 1 MILLION` and its records hold values in
millions; the shipped default high-score table tops out at 1,000,000,000, which is a
plausible target against 5–100 million awards and an unreachable one against the
smaller reading. Not a proof — no display path was traced from a record to the panel —
so treat magnitudes as **strongly supported** and ratios as certain. **[disk]/[open]**

### 2.5 Award record, family B — a second, distinct family

Engine handler 0 (`main.seg00` `0x55CE`) uses a *different* record. Decoded from
`0x55CE`–`0x5620`:

```
0x55CE  cmpi.w #$20,d0        ; state index < 32
        tst.b  $2(a0)         ; a0 = script node
        move.b #6,$2(a0)      ; debounce = 6 ticks
        movea.l $C(a0),a1     ; a1 = award record (family B)
        movea.l $4(a0),a2     ; a2 -> per-player once-only bit byte
        move.w $DBE(a5),d0    ; current player index
        bset   d0,(a2)        ; Z = "this was the FIRST hit"
   first hit  -> sound #$0C ; lea $12(a1),a3 ; jsr $6B96
   repeat hit -> sound #$08 ; lea $1A(a1),a3 ; jsr $6BCC
```

so family B is:

| Offset | Meaning |
|---|---|
| `+0x04..+0x09` | first-hit **SCORE** (6-byte BCD) |
| `+0x0C..+0x11` | first-hit **BONUS** |
| `+0x14..+0x19` | repeat-hit **SCORE** (no bonus on repeats) |

**[disk]** — and this is a strictly better reading than the previous report's, which
put the fields at `+0x16`/`+0x1E`.

The **once-only-per-player** mechanic is therefore real and engine-level: a bit per
player in a shared byte, first hit pays score+bonus, every later hit pays score only.
The switch debounce constant is **6 ticks**. **[disk]**

**Family B instances are [open].** A stride-0x26 scan of the regions where they were
reported (`Table003` `0x2E80`–`0x2FF0` and the equivalents) produces BCD-invalid
garbage, so that placement is wrong. The field offsets are certain; *which* records in
the modules are family B is not established.

### 2.6 End-of-ball bonus, and the bonus multiplier

`main.seg00` `0x5136`:

```
005136  tst.b $23ED(a5)        ; TILT -> skip the bonus entirely
        movea.l $DC2(a5),a0
        move.w $12(a0),d0      ; multiplier
        beq +2 / subq.w #1,d0
        lea $2448(a5),a1 / lea $10(a0),a2
        andi #$EF,CCR / ABCD ×6 / dbra d0
        ...
0051C6  movea.l $DC2(a5),a0
        lea $8(a0),a1 / lea $2440(a5),a2
        andi #$EF,CCR / ABCD ×6        ; SCORE += bonus total
```

So **end-of-ball bonus = BONUS × multiplier**, the loop runs `max(multiplier, 1)`
times, the total is accumulated at `$2442..$2447(a5)`, and **tilting forfeits it
entirely**. **[disk]**

**The multiplier ladder differs per table — a genuinely new finding.** Each module has
a small pointer array of multiplier *messages*:

| Table | Array @data | Entries | Messages |
|---|---|---:|---|
| Table001 Law 'n Justice | `0x2BF8` | 5 | `X2` `X4` `X6` `X8` `X10` |
| Table002 BabeWatch | `0x2C4E` | 5 | `X2` `X4` `X6` `X8` `X10` (records `0x2C62/0x2C6E/0x2C7A/0x2C86/0x2C92`) |
| Table003 Extreme Sports | `0x2BE8` | 4 | `X2` `X3` `X4` `X5` |

**[disk]** — Table001 `0x2C0C/0x2C18/0x2C24/0x2C30/0x2C3C`; Table003
`0x2BF8/0x2C04/0x2C10/0x2C1C`. The arrays are fixed-length, not NULL-terminated.

This **confirms** the secondary-source claim that BabeWatch has multiple routes to a
high multiplier, and shows Extreme Sports caps at ×5 where the other two reach ×10.

Whether `player+0x12` holds the multiplier *value* (2,4,6,8,10) or an *index* into
these arrays is **[open]**. The `DBRA` says it is used directly as a repeat count,
which favours the value; nothing found writes it.

### 2.7 Combo bonus — identical on all three tables

Each module's native end-of-ball routine reads the combo count for the current player
and adds a fixed constant that many times. The constant is an 8-byte BCD field, and the
three modules are **byte-identical** here:

| Table | Constant @data | Bytes | Value (low 6) |
|---|---|---|---:|
| Table001 | `0x2BA0` | `00 00 00 00 01 00 00 00` | **1,000,000** |
| Table002 | `0x2BF6` | `00 00 00 00 01 00 00 00` | **1,000,000** |
| Table003 | `0x2B90` | `00 00 00 00 01 00 00 00` | **1,000,000** |

**[disk]**. The surrounding native code is byte-identical too — `303C 0064` (wait 100
frames) and `303C 0096` (wait 150 frames) appear at the same relative positions in all
three. The routine formats `<n> COMBOS` into the message at `0x2BB0`/`0x2BFE`/`0x2BA0`,
suppressing the trailing `S` when the count is 1, then prints `TOTAL BONUS` + the number
or `NO BONUS`. Calls into the engine use the 68020 memory-indirect form
`JSR ([disp,A4])` (`4EB4 0161 00xx`), which is independent confirmation the game targets
68020/AGA. **[disk]**

Engine vector table used by those calls, `main.seg00` `0x5766`, 8 entries: `+0x00`→
`0x089A`, `+0x04`→`0x6CD0` lamp command, `+0x08`→`0x6B06` clear panel, `+0x0C`→`0x5230`
wait D0 frames, `+0x10`→`0x71BA` draw BCD number, `+0x14`→`0x73D0` print message record,
`+0x18`→`0x6DD0` BCD→ASCII, `+0x1C`→`0x6C10` queue object. **[disk]**

### 2.8 Message records

Proven against the engine's own printer at `main.seg00` `0x73D0` (`movem.w (a0),d3-d5`
then `move.w $6(a0),d0`, then `a0 += 8`):

```
{ u16 x, u16 row, u16 font/colour, u16 align, char[] ASCIIZ, pad to even }
align: 0 = left, 1 = right-adjust by width, else centre
x: 160 = panel-centred, 240 = right slot (timers), 80/64 = left slot, 40 = multiplier
row: ×0x28 bytes into the panel bitmap
```

**[disk]**. Round-trip check: BabeWatch's `GYM MODE ENABLED` message record is at data
`0x40D0` (its ASCII at `0x40D8`), and `0x40D0` is exactly the relocated pointer value
stored at data `0x3FD4` and again at `0x3FEE`. That round trip proves the record format
and the `+4` convention at once. **[disk]**

### 2.9 The script interpreter

`main.seg00` `0x558A`, decoded in full:

```
lea $F92(a5),a2                 ; array of playfield-element objects
move.w $D7E(a5),$D80(a5)        ; element count
movea.l (a2)+,a4
tst.b $9(a4)                    ; skip if set
move.w $6C(a4),d0 ; bmi skip    ; element's CURRENT STATE INDEX
movea.l $60(a4),a0              ; element's array of script-node pointers
move.l (a0,d0.w*4),d1 ; beq     ; indexed load, longword-scaled
movea.l d1,a0 ; move.w (a0),d2  ; node opcode word
move.w $55C8(pc,d2.w),d2
jsr $55C8(pc,d2.w)
```

The dispatch table at `0x55C8` has **exactly 3 entries** (`0006 0084 00E8` → handlers
`0x55CE`, `0x564C`, `0x56B0`); it is 6 bytes long because the first handler starts at
base+6. A second 8-entry table at `0x6CE4` (`001C 001C 0010 001C 0022 002E 001C 001C`,
indexed by `andi.w #7`) is the lamp/light command decoder. **[disk]**

**There is no jump table in any table module** — `0x4EF9` and `0x4EB9` counts are zero
in all three. Dispatch is entirely by data tables. **[disk]**

**Script stream grammar is [open].** Pointer-bearing records are 6 bytes (`u16 op` +
`u32`, position confirmed by the relocation table). Records without pointers are
variable length and no `op → length` rule survives: opcode `0x0000` demonstrably takes
both a 4-byte and a 6-byte form within one 16-byte stretch of Table001. **No linear
disassembly of the scripts was attempted**, and every structural claim in this document
is anchored on the relocation table or on byte-identical repeated templates instead.

Opcode census (relocated longwords classified by the preceding word), Table001:

| op | uses | op | uses | op | uses |
|---|---:|---|---:|---|---:|
| `0x00` | 384 | `0x09` | **15** | `0x13` | 32 |
| `0x01` | 211 | `0x0C` | 54 | `0x14` | 1 |
| `0x02` | 28 | `0x0D` | 5 | `0x16` | 6 |
| `0x03` | 130 | `0x0E` | 94 | `0x17` | 3 |
| `0x04` | 7 | `0x0F` | 6 | `0x18` | 12 |
| `0x05` | 152 | `0x10` | 102 | `0x1A` | 9 |
| `0x06` | 24 | `0x11` | 38 | `0x1C` | 26 |
| `0x07` | 4 | `0x12` | 3 | | |
| `0x08` | 5 | | | | |

Only two opcodes are proven: **`0x0003` = display message** (operand → message record;
verified for 45 of Table003's 52 in-script strings and 66 of Table001's) and
**`0x001A` = a second text-display op** used for jackpot banners. `0x0010` and `0x0013`
always point into the sound/effect descriptor table. Everything else is a census entry,
not a decoding. **[disk] for the census, [open] for the semantics.**

### 2.10 Mode objects

Each module has a second NULL-terminated pointer array, immediately after the award
array, pointing at fixed-layout **mode objects**:

| Table | Array @data | Entries |
|---|---|---:|
| Table001 Law 'n Justice | `0x2936` | **16** |
| Table002 BabeWatch | `0x29BA` | **13** |
| Table003 Extreme Sports | `0x292C` | **15** |

Layout, checked against all 44: `0x40` bytes of zeroed runtime state, then 8 bytes
pre-filled `FF`, then 8 bytes `00`, then a u16 tail (`FFFF` or a small count). 40 of 44
match the `FF×8` pattern exactly. **[disk]**

Award records reference these through `+0x34`, which is what lets a mode be tied to its
award ladder in §3–§5.

### 2.11 Timers — mechanism decoded, values not found

All in the engine; the table modules supply constants the search never located.

| Address | What it does |
|---|---|
| `0x56D4` | Generic **mode timer** tick. Walks the NULL-terminated list at `$232E(a5)`; `subq.w #1,$26(a1)`; on zero, `move.l $28(a1),$30(a1)`, `move.l $2C(a1),$34(a1)`, `clr.l $38(a1)`, `clr.l $3C(a1)`. A timed object = u16 countdown at `+0x26`. |
| `0x5700`, `0x5716` | Two **combo / lane window** lists (`$231E(a5)`, `$2322(a5)`); `subq.b #1,$1(a1,d0.w)` per entry per tick — byte-sized windows |
| `0x62E0` | Per-lamp flash/hold timer, `subq.w #1,$2E(a0)` |
| `0x6334` | **BCD ramp engine.** Walks `$2356(a5)`. Bit 0 of byte `+0x01` clear → six `ABCD` (count **up** by the 6-byte step at `+0x1C`), clamp against the target at `+0x12` with `BCS`. Bit 0 set → three `SBCD` pairs (count **down**), clamp with `BHI`. |

**[disk]**

`0x6334` is the mechanism behind Extreme Sports' signature rule: one list, one tick,
both directions, so an up-ramping bonus and a down-ramping timer are serviced by the
same loop on the same frame. That **confirms** the secondary-source claim mechanically.
**Which** ramp object is Extreme Sports' bonus is **[open]** — the objects are
runtime-allocated and their table-side templates were not isolated.

**Not one timer duration constant was found, on any table.** Per-mission countdowns
demonstrably exist (the `TIME` labels at x=240 — four in Table001, eight scripts
pointing at one shared label in Table003) and `HURRY UP` exists, but no threshold,
no rate and no combo window is established. This is the largest single gap. **[open]**

A false positive worth recording so nobody re-derives it: a raw opcode scan of Table001
reports `SBCD -(a2),-(a1)` (`0x850A`) at seven sites, each just after a mode's countdown
text, looking exactly like seven per-mission timer decrements. Every one is the low half
of a relocated longword `0x0000850A` — verified against the relocation list in all seven
cases. **There is no `SBCD` in that module.** **[disk]**

### 2.12 Sound / effect parameter table

Table001 data `0x9E6E..0x9FC3`, ~74 records of 8 bytes:
`{ u16 = 0x0400 ; s16 ∈ {−2,−1,2,3,6} ; u16 index (0x00..0x17 monotonic in the second
half) ; u16 flag ∈ {0,1} }`. **112 of 112** `op 0x10`/`op 0x13` operands land on an
8-byte-aligned boundary inside it. **[disk]**

Table003's equivalent is a 30-byte descriptor family at `0x7BAA..0x7D5x` reached via
award-record `+0x04`, indexed by a 22-entry array at `0x7888`. **[disk]**

---

## 3. Options — `table00N.opt`, fully settled

Seven records, 10 bytes each, 70 bytes total, verified byte-for-byte in all three files.

**The record layout previously published in `GAMEPLAY_PARITY.md` was wrong.** It is
**not** `{u16 value, u16 max, u32 default, FFFF}`. It is:

```
+0 s16 min
+2 s16 max
+4 u16 CURRENT   (always 0 on disk)
+6 u16 DEFAULT
+8 u16 flag      (0xFFFF = include in the "changed from default" test)
```

The old "u32 default" was current(=0) followed by default, which is why every published
*default* was right and the first word of every record was wrong. **[disk]**

Loading, `main.seg00`: `0x330C` `lea $CACF` → byte 16 of `"PROGDIR:table001.bin"`, then
`0x3312/0x3318/0x331E` poke `'o'`,`'p'`,`'t'` over `"bin"`; `0x3324` `Open()` mode
`$3ED`; `0x333C` `AllocMem #$46` (70 bytes) → `$64(a5)`; `0x3352` `Read()` 70 bytes,
`Close`, then three fix-ups:

- `$9E6` — for i in 0..6: `move.w $6(a0),$4(a0)`, `adda.w #$A,a0` → default → current
- `$9FE` — `lea $E84(a5),a0`; for i in 0..6: `move.w $4(a1),(a0)+` → current → live array
- `$A18` — for i in 0..6: if `word@+8 != 0` and `word@+4 != word@+6` then `st.b $90(a5)`

**Live option *i* (0-based) is the word at `$E84(a5) + 2i`.** The filename is built by
patching `.bin` in place, which is why no `"opt"` string exists anywhere in the shipped
data and the file looked unread. **[disk]**

| # | Setting | Range | Default | Live word | Consuming code |
|---:|---|---|---:|---|---|
| 1 | **Balls per game** | 3–5 | 3 | `$E84(a5)` | `0x4558 move.w $E84(a5),$D82(a5)`; `0x508C subq.w #1,$D82(a5) ; beq $5124` |
| 2 | **Table slope** (downhill Y acceleration) | 2–8 | 4 | `$E86(a5)` | `0xB758 add.w $E86(a5),d1` into the per-material acceleration pair; `0x3504` writes it to `ball+0x3E` at init |
| 3 | **Camera follow divisor** | 1–7 | 5 | `$E88(a5)` | `0x6D6A divs.w $E88(a5),d0` on (target Y − camera Y − dead zone); `0x6D78 add.w d0,$DA4(a5)` |
| 4 | **Tilt sensitivity** | 0–200 | 100 | `$E8A(a5)` | `0xBE9A add.w d0,$23F0(a5)` per nudge frame; `0xBEA2 cmpi.w #$C8,$23F0(a5)` → `st.b $23ED(a5)`; `0xBEB4 subq.w #1` decay |
| 5 | **Lateral lean** (X acceleration bias) | −3…+3 | 0 | `$E8C(a5)` | `0xB754 add.w $E8C(a5),d0`; `0x34FC` writes it to `ball+0x3C` at init |
| 6 | **Timed ball-save grace, in seconds** | 0–10 | 5 (**Extreme Sports 10**) | `$E8E(a5)` | `0x49AE move.w $E8E(a5),d0 ; mulu.w $50(a5),d0 ; move.w d0,$D8A(a5)`; `0x4DF2 subq.w #1`; `0x4E4E tst.w ... beq`; `0x50FA clr.w` on drain |
| 7 | **View / screen mode** | 0–2 | 2 | `$E90(a5)` | `0x3514 cmpi.w #$1,$E90(a5)` → `$3C1E` else `$3BDC`; `0x5A26 cmpi.w #$2,$E90(a5)` → `$3C1E` |

**[disk]** — every row above was re-disassembled for this document and reproduces
exactly.

Notes that matter:

- **Record 2 is not "players".** Players are chosen with F1–F8 at start (`PRESS ENTER
  OR F1-F8 TO BEGIN PLAY`); the 8-entry player array at `$DC6(a5)` is never sourced from
  the `.opt`. Records 2 and 5 are the two halves of one acceleration pair added to every
  ball every frame, and record 5's signed symmetric range forces it to be the lateral
  one. **[disk] — refutes the previous doc.**
- **Record 6 is not "nudges before tilt".** The tilt threshold is a hard-coded 200 and
  belongs entirely to record 4. Record 6 is `option × GfxBase.VBlankFrequency` (`$50(a5)`,
  set at `0x412`/`0x68E` from `move.b $212(a6),d0`), i.e. a countdown in frames, i.e. the
  option is in whole **seconds**. **[disk] — refutes the previous doc.** Calling it "ball
  save" specifically is the one inferential step; the drain handler was not traced far
  enough to watch the timer veto a ball loss. **[open]** on that last hop.
- **Record 7 is not a multiball cap.** `$3C1E` (wide): display words `$9CA=$50`,
  `$9CE=$A0`, `$9D2=$8214`, `$9E2=$80`, `$9DA=$9DE=$2D0`; camera dead-zone `$D9E=$C8`,
  camera max-Y `$DA0=$8A` (138). `$3BDC` (narrow): `$9CA=$30`, `$9CE=$D0`, `$9D2=$210`,
  `$9E2=$40`, `$9DA=$9DE=$150`; `$D9E=$46`, `$DA0=$172` (370). Against a 600-row
  playfield that is ~462 visible rows versus ~230 — exactly 2×. `$D9A(a5)` then selects
  drawing paths at `0x7708` (X snapped to even), `0x773A`, `0xC09A`. So **0 = always
  narrow, 1 = always wide, 2 = narrow but the table script may switch to wide at run
  time** (the default), which is the option behind the `F9 FOR LO-RES` / `F10 FOR HI-RES`
  keys. **[disk] — refutes the previous doc.** Which configuration the game calls
  "LO-RES" is **[open]**.

**There is no options screen in this release, and the option labels do not exist as
text anywhere in the shipped data.** This was established, not merely unfound:
literal search for `opt` across every decompressed segment of `main.bin` (12),
`menudata.bin` (3), `intro.bin` (4), all three `Table00N.bin` (26 total), the `Pinball`
loader and the raw packages gives 2 hits, both inside compressed pixel data; word search
for BALLS / PLAYERS / TILT / SLOPE / SPEED / MUSIC / SOUND / DIFFICULTY / MULTIBALL /
OPTION / NUDGE / GRAVITY / SENSITIVITY / HANDICAP / SCROLL / VIEW / RESOLUTION returns
only in-play messages; and the **only** menu layout descriptor in the program
(`main.seg00.bin` blob 53012–53236) has exactly three items — `Tables`, `Exit`, `Info`.
The `.opt` is read at table load and applied silently. **[disk]**

Consequence: **any option label in this reconstruction is the project's own invention
and must be documented as such.** The semantics above are facts; the words are not.

This also closes parity open question #1 with a **no**: the `.mnu` files are the
table-select info screens (artwork, table name, a two-line blurb, `Press ESC to exit.`)
and contain no option labels.

## 3.1 Default high-score table

`main.seg00.bin` blob 52036 (`0xCB44`), 5 records × 10 bytes: `char[4]` initials
(3 + NUL) then 6-byte packed BCD:

| Initials | Bytes | Score |
|---|---|---:|
| `AXL` | `00 10 00 00 00 00` | 1,000,000,000 |
| `M N` | `00 05 00 00 00 00` | 500,000,000 |
| `ORG` | `00 02 50 00 00 00` | 250,000,000 |
| `F L` | `00 01 00 00 00 00` | 100,000,000 |
| `P B` | `00 00 50 00 00 00` | 50,000,000 |

Byte-identical to `meta\score00{1,2,3}.bin` (50 bytes each), which confirms the encoding
rather than assuming it. Matching display strings at blob 6204–6323. **[disk]**

---

## 4. Law 'n Justice (Table001)

### 4.1 The "17 missions" claim — REFUTED

Secondary sources report **17 scoring missions**. That number does not appear anywhere
in the table's data.

Exhaustive measurement — every maximal run of consecutive stride-4 relocations in
`Table001.seg04.bin`:

| Run @data | Entries | What it is |
|---|---:|---|
| `0x2746` | **123** | award records (§2.4) |
| `0x2936` | **16** | mode objects (§2.10) |
| `0x3F8C` | 6 | — |
| `0x8160` | **26** | sprite/animation records `0x81D4..0x85D2` |

**There is no run of 17 in any of the three modules.** Run-length histogram for
Table001 ≥10: {16, 26, 123}. For Table002: {10, 13, 29, 116}. For Table003:
{15, 22, 98}. **[disk]**

The mission dispatch is **8 entries**, at data `0x3112`, stride 12,
`{ u16 op = 0x0009 ; u32 script_ptr ; 6 bytes of zero }`, preceded at `0x310C` by the
word `0x0008`:

| idx | record @data | script @data | announce text |
|---:|---|---|---|
| 0 | `0x3112` | `0x7308` | `SHOOT FLASHING ARROWS` / `TO CALM DOWN RIOTS` |
| 1 | `0x311E` | `0x6DC2` | `BLOW ALL BOMBS BEFORE` / `TIMER REACHES ZERO` |
| 2 | `0x312A` | `0x7820` | `SHOOT ALL TERRORISTS` / `TO FREE HOSTAGES` |
| 3 | `0x3136` | `0x4ED0` | `SHOOT RIGHT RAMP TO` / `BUST DRUGDEALERS` |
| 4 | `0x3142` | `0x67A4` | `BRING ALL PRISONERS` / `BACK TO JAIL` |
| 5 | `0x314E` | `0x6256` | `STOP SPARKYS FIRE` / `FROM SPREADING` |
| 6 | `0x315A` | `0x55DA` | `THE HOVER IS SPEEDING` / `IT IS A HOVERCHASE` |
| 7 | `0x3166` | `0x4CA2` | `GIMME YOUR BEST SHOT` / `TO CLEAR THE STREET` |

Seven of those eight scripts open with the byte-identical 12 bytes
`00 00 00 00 00 03 00 00 30 22 00 03`; mission 5 (`0x6256`) opens
`00 00 00 00 00 1E 00 C4 00 03 00 00` — the 7 + 1 split described below. **[disk]**

**[disk]**. The `0x0008` count word is **[open]** — `0x0008` is also a real opcode
elsewhere, so it may be an op-8 record with a null operand rather than a count.

**How the text pairing was proven, independent of any opcode reading.** Seven of the
eight mission scripts open with a byte-identical 78-byte preamble; anchor byte string
`00050000302200000000400000000010` occurs at data `0x4D0A, 0x4FD0, 0x5686, 0x68AC,
0x6EBA, 0x7426, 0x7934`. A column-wise diff of all seven over `[-0x20, +0x50]` shows
every word identical **except exactly two longwords**, at anchor+0x26 and anchor+0x2C,
and both are relocations resolving to the two announce-message records. 7/7 with no
free parameters. Mission 5 uses a variant preamble; its pair was found by reverse
lookup — the only pointers to message headers `0x640C` and `0x6426` are op-`0x0003`
records at `0x63E4` and `0x63EA`, inside that mission's block. 8/8. **[disk]**

Counts that *could* be mistaken for 17: **15** relocated longwords in the module are
preceded by the word `0x0009` (8 in this dispatch, 7 elsewhere); **16** mode objects.
Neither is 17, and Array B's 16 entries become "17" only if the preceding NULL — which
is the award array's terminator at `0x2932` — is miscounted as a slot. **[disk]**

It remains *possible* that a secondary source counts 17 by adding non-dispatch scoring
features (bumper mania, jackpot, jailbreak, hurry-up, the 4-lock multiball ladder,
extra ball, multipliers-held, bonus, combos) to the 8 timed missions. **No evidence
supports that grouping and this document does not assert it.** What the data supports is
**8 timed missions and 16 mode objects**. **[disk]**

### 4.2 Award ladders

The 123 award records, grouped by their `+0x34` mode object. Values are `SCORE / BONUS`.

| Mode object | Mode-table idx | Records | Values | Nearby text |
|---|---:|---|---|---|
| `0x5210` | 1 | 1–4, 74–78 | 4 × `—/—`, then 5 × `—/1,500,000` | `DRUGBUST VALUE` |
| `0x454A` | 12 | 93–100 | 6 × `1,000,000 / 500,000`, 2 × `—/—` | `JACKPOT`, `BUMPER MANIA` |
| `0x66AA` | 14 | 103–109, 111 | 6 × `5,000,000 / —` | `HURRY UP` |
| `0x80EC` | 15 | 113–118 | 6 × `10,000,000 / —` | — |
| `0x4BF6` | 7 | 41–47 | 7 × `—/—` | `BUMPER VALUE`, `BUMPERS ADD`, `TIME` |
| `0x7166` | 8 | 56–61 | 6 × `—/—` | `SHOOT JAIL` |
| `0x76CE` | 9 | 65–70 | 6 × `—/—` | `SHOOT ALL TERRORISTS` |
| `0x6C00` | 4 | 23, 24, 28, 30 | `—/—`, `—/—`, `—/1,500,000`, `—/100,000` | `JAILBREAK BONUS`, `OF 25 PRISONERS` |
| `0x6AE4` | — | 25–27 | 3 × `—/100,000` | `JAILBREAK` |
| `0x486A` | 11 | 80–82 | 3 × `—/—` | `BUMPER MANIA` |
| `0x5822` | 2 | 0 | `—/2,500,000` | `MULTIPLIERS HELD` |
| `0x305A` | 13 | 48, 49 | `—/5,000,000`, `—/—` | — |
| `0x3192` | — | 122 | `—/5,000,000` | — |
| `0x3246`, `0x333E` | 0, 6 | 33, 34 | `—/1,000,000` each | — |
| `0x40A4` | 10 | 79 | `5,000,000 / —` | `1..4 MORE FOR M-BALL`, `JACKPOT` |
| `0x6C52` | 5 | 31 | `—/100,000` | — |
| `0x7B04` | — | 51–55 | 5 × `—/—` | — |

**[disk]**. The 47 records with no `+0x34` field (the 52-byte variant) include the
table's biggest single ladder, records 8–22 in array order:

| idx | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| score | 5M | 10M | 15M | — | — | — | 25M | 15M | 20M | 25M | 30M | 35M | 40M | 45M | 50M |

Records 15–22 are a clean **15M→50M in 5M steps**; 8–10 are a separate 5/10/15M run;
11–13 award nothing (11 and 12 display `MULTIPLIERS HELD` / `EXTRA BALL IS LIT`), and
14 sits between the two runs at 25M. The array order is **not** necessarily the play
order — see §7. Eight further records award **100,000,000** each (indices 5, 7, 29, 50,
62, 72, 110, 119). **[disk]**

### 4.3 Strings and what they confirm

Full message inventory (data offsets; the ASCII begins 8 bytes later):

`0x2BB0 0000 COMBOS` · `0x2C3C X10` · `0x36FE EXTRA BALL IS LIT` ·
`0x4082 HEY - IT IS NOT OPEN YET` · `0x4310/0x432A/0x4344/0x435E 1..4 MORE FOR M-BALL` ·
`0x48F6 JACKPOT` · `0x4A0C BUMPER MANIA` · `0x4BE0 BUMPER VALUE` · `0x4C80 BUMPERS ADD` ·
`0x4C94 TIME` · `0x4D56 GIMME YOUR BEST SHOT` / `0x4D74 TO CLEAR THE STREET` ·
`0x4E4A YOU SHOT 00 BAD GUYS` · `0x4EBE EXCELLENT` · `0x501C SHOOT RIGHT RAMP TO` /
`0x5038 BUST DRUGDEALERS` · `0x51CC TIME` · `0x5446 DRUGBUST VALUE` ·
`0x56D2 THE HOVER IS SPEEDING` / `0x56F0 IT IS A HOVERCHASE` · `0x57AC TIME` ·
`0x5F14 MULTIPLIERS HELD` · `0x5F80 EXTRA BALL IS LIT` · `0x640C STOP SPARKYS FIRE` /
`0x6426 FROM SPREADING` · `0x64A8 TIME` · `0x675C HURRY UP` · `0x68F8 BRING ALL PRISONERS` /
`0x6914 BACK TO JAIL` · `0x6BB8 JAILBREAK` · `0x6D0A JAILBREAK BONUS` ·
`0x6D90 OF 25 PRISONERS` / `0x6DA8 PUT BACK IN JAIL` · `0x6F06 BLOW ALL BOMBS BEFORE` /
`0x6F24 TIMER REACHES ZERO` · `0x72A6` and `0x72BA SHOOT JAIL` (two copies) ·
`0x7472 SHOOT FLASHING ARROWS` / `0x7490 TO CALM DOWN RIOTS` ·
`0x7980 SHOOT ALL TERRORISTS` / `0x799E TO FREE HOSTAGES`. **[disk]**

Against the secondary sources:

| **[src]** claim | Verdict |
|---|---|
| Police chases, jailbreaks, hostage situations | **CONFIRMED** — hover chase, jailbreak / `OF 25 PRISONERS`, `TO FREE HOSTAGES` |
| 17 scoring missions | **REFUTED** — 8 timed missions, 16 mode objects, no 17-anything (§4.1) |
| Locking balls feeds multiball | **CONFIRMED** — 4-step ladder `1..4 MORE FOR M-BALL` at `0x4310–0x435E` |
| Locking criminals also feeds multiball | **[open]** — `OF 25 PRISONERS` exists; no link to the lock ladder found |
| Ramps and transport channels | **CONFIRMED** independently by the collision maps (`GAMEPLAY_PARITY.md`) |
| A sub-game played on the score panel | **REFUTED for this table** — no such strings in Table001. The claim is true of **BabeWatch** (§5.3), so the source appears to have attributed it to the wrong table |

One runtime text patch is confirmed: `0x8794 lea $4E5B.l,a0` resolves to data `0x4E5B`,
which is exactly the first `0` of `YOU SHOT 00 BAD GUYS` (+9 into the string), so that
mission's kill counter is rendered by poking two ASCII digits into the message in place.
**[disk]**

Mission themes: riot control, bomb defusal, hostage rescue, drug bust, prisoner return,
arson, hover chase, street clear-out.

---

## 5. BabeWatch (Table002)

### 5.1 Modes

Five, and they sit in **one contiguous 134-byte block** of message records at data
`0x40D0..0x4156`:

| Record @data | Header `{x, row, font, align}` | Text @data | Mode |
|---|---|---|---|
| `0x40D0` | `{160, 2, 1, 2}` | `0x40D8` | `GYM MODE ENABLED` |
| `0x40EA` | `{160, 2, 1, 2}` | `0x40F2` | `SURF MODE ENABLED` |
| `0x4104` | `{160, 2, **3**, 2}` | `0x410C` | `BURGER MODE ENABLED` |
| `0x4120` | `{160, 2, **3**, 2}` | `0x4128` | `CASINO MODE ENABLED` |
| `0x413C` | `{160, 2, 1, 2}` | `0x4144` | `BABE HUNT ENABLED` |

The five split **3 + 2 by font/colour index** — GYM / SURF / BABE HUNT use index 1,
BURGER / CASINO use index 3 — and the lock strings say why: `LOCK 3 BALLS 4 BURGER`,
`LOCK 4 BALLS 4 CASINO`. Those two are the ones gated behind ball locks. **[disk]**

13 mode objects at `0x29BA`. **[disk]**

Mode banners: GYM `SHOW YOUR MUSCLES` / `TO SCORE JACKPOTS`; SURF `SURF THEM WAVES` /
`TO SCORE JACKPOTS`; BURGER `GET SUPER JACKPOT`, `HAVE A BURGER`, `DUDE`; CASINO
`MONEY HUNT` / `TRY YOUR WINNING LUCK`; BABE HUNT `NOW IT IS TIME FOR` / `BABE HUNT`.
**[disk]**

### 5.2 Award ladders

| Mode object | idx | Records | Values (`SCORE / BONUS`) | Context |
|---|---:|---|---|---|
| `0x440E` | 4 | 50–54 | **5M/100k · 10M/250k · 15M/500k · 20M/1M · 25M/5M** | ball-lock ladder |
| `0x49A8` | 8 | 45–47 | 3 × `5,000,000 / 250,000` | `LOCK 3/4 BALLS 4 ...` |
| `0x6752` | 1 | 22 records (8,9,11,15,18–23,29,44,55–58,75–80) | mostly `—/100,000`; `15 → —/500,000`; `58 → —/1,000,000`; `44 → 100,000/50,000` | GYM / SURF jackpots |
| `0x5B62` | — | 63–67 | 5 × `—/250,000` | gear ladder `2ND`–`6TH GEAR` |
| `0x7590` | — | 24–28 | 5 × `—/100,000` | BABE HUNT |
| `0x6C2C` | — | 12–14 | 3 × `—/100,000` | BURGER |
| `0x63E4` | — | 88 | `5,000,000 / 50,000` | `ENABLED FOR 1 MILLION` |
| `0x5796` | 6 | 59 | `2,000,000 / 25,000` | `RACE ENABLED` |
| `0x5864` | — | 60 | `—/500,000` | race |
| `0x7B34` | — | 73 | `25,000,000 / —` | jukebox area |
| `0x2EDC` | 0 | 0 | `—/1,000,000` | `EXTRA BALL IS LIT` |
| `0x5EF4` | — | 86 | `—/100,000` | casino |

**[disk]**

The `0x440E` ladder is the cleanest object in the whole excavation: a perfect
1:2:3:4:5 score progression against a 1:2.5:5:10:50 bonus progression, five records at
stride `0x38`, all flags `0x0100`.

### 5.3 Against the secondary sources

| **[src]** claim | Verdict |
|---|---|
| Venues include a casino and a gym | **CONFIRMED** — `CASINO MODE ENABLED`, `GYM MODE ENABLED`, plus `THE CASINO IS OPEN` / `IS CLOSED` / `THE GAME IS ON` |
| A race | **CONFIRMED** — `RACE COMBO`, `1..3 MORE TO RACE`, `RACE ENABLED`, and a 5-step gear ladder `2ND`–`6TH GEAR` at `0x5E6A–0x5EB2` |
| A chat-up sequence driven by hitting targets | **PARTIALLY** — `BABE HUNT` exists as a mode with a 5-record award group; nothing establishes the target-driven mechanic. **[open]** |
| Multiple independent routes to raise the multiplier | **CONFIRMED** — the `X2/X4/X6/X8/X10` ladder (§2.6) plus an independent `MILLIONS ENABLED` / `ALL WHITE TARGETS` / `ENABLED FOR 1 MILLION` route |
| Multiplier lanes near the top of the playfield | **[open]** — position not established |
| A music-selection feature | **CONFIRMED** — `PICK A SONG`, `JUKEBOX`, `IN D JUKEBOX`, `CHOOSE LEFT RIGHT`, `SELECT WITH RETURN`, and three titles: `BY THE BEACH`, `MOONLIGHT PARKING`, `ROLL ME ON` |
| A sub-game played on the score panel, aimed with the flippers | **CONFIRMED here, not on Law 'n Justice** — the jukebox is exactly that (`CHOOSE LEFT RIGHT` / `SELECT WITH RETURN`) |

Multiball lock ladder — offsets here and in §6 are of the **ASCII text**, i.e. the
message record starts 8 bytes earlier: `BALL 1..4 LOCKED` (`0x4886–0x48C8`),
`1..3 MORE TO START MODE` (`0x48DE–0x491A`), `LOCK 1 BALL 4 M-BALL` /
`LOCK 2 BALLS 4 M-BALL` / `LOCK 3 BALLS 4 BURGER` / `LOCK 4 BALLS 4 CASINO`
(`0x4938–0x4992`). **[disk]**

### 5.4 Two anomalous values — recorded, not smoothed

Of the 288 nonzero award fields across the three tables, exactly two are not round:

- Table002 record 48 @data `0x3F52`: score field raw `00 00 00 00 00 01 23 40` →
  **12,340**. Its bonus (`250,000`) is round.
- Table002 record 96 @data `0x3CE4`: bonus field → **500,010**.

`12340` reads as a developer placeholder. Both are reported rather than rounded off.
**[disk]**

---

## 6. Extreme Sports (Table003)

### 6.1 Modes

15 mode objects at data `0x292C`: `0x747E, 0x7122, 0x3A0E, 0x61BE, 0x4CDC, 0x56E6,
0x557E, 0x45B4, 0x6678, 0x68D4, 0x6E34, 0x5E80, 0x376C, 0x37F8, 0x49CC`. A further 10
group objects (`0x3B1C, 0x4A1E, 0x53AC, 0x54C4, 0x57D8, 0x5B8A, 0x6472, 0x6E86, 0x72E0,
0x7B10`) are referenced from award records but are not in the mode table — non-mode
feature groups (gate save, lane banks, rock-climb stages). **[disk]**

Two 5-entry op-`0x0009` dispatches exist, of the same 12-byte record shape as Law 'n
Justice's, rather than a single 8-entry one — data `0x6968` (targets `0x69A0, 0x6A46,
0x6AEC, 0x6B92, 0x6C38`) and data `0x71C2` (targets `0x3CDA, 0x58B2, 0x40FE, 0x4790,
0x4A7A`). All ten operands verified as relocations with the preceding word `0x0009`.
**[disk]**

### 6.2 Award ladders — the richest of the three

| Mode object | idx | Records | Values (`SCORE / BONUS`) | Mode |
|---|---:|---|---|---|
| *(no group)* | — | 0–5 | **5M/25k · 10M/50k · 15M/75k · 20M/100k · 25M/250k · 50M/500k** | 6-step ramp/lane ladder; score 1:2:3:4:5:10 |
| `0x6472` | — | 6–10 | 5M/20k · 10M/100k · **15M/200k** · 10M/100k · 5M/20k | speed lanes — a symmetric 5-lane bank |
| `0x4CDC` | 4 | 49–53 | 5M · 7.5M · 10M · 12.5M · 15M, all `/120,000` | off-piste, linear +2.5M |
| `0x5E80` | 11 | 80–85 | 6 × **25,000,000 / 1,000,000** | `EXTREMIST` |
| `0x37F8` | 13 | 87–93 | 3M/30k · 1M/10k · 3M/50k · 5M/500k · 1M/10k · 3M/50k · 5M/100k | bank group |
| `0x6E34` | 10 | 65, 67–70 | `—/50,000` then 4 × `500,000 / 25,000` | jackpot group |
| `0x45B4` | 7 | 58–63 | 3 × `1,000,000 / 50,000` alternating with `—/—` | bungee / free-fall |
| `0x49CC` | 14 | 25–27 | `—/5,000` · `—/5,000` · `—/50,000` | cliff dive |
| `0x5B8A` | — | 41–44 | 4 × `—/100,000` | rock climb stages |
| `0x54C4` | — | 29, 30 | 2 × `2,000,000 / 100,000` | rock climb |
| `0x3A0E` | 2 | 46, 47 | `500,000/7,000` · `500,000/2,000` | rubberband |
| `0x6678` | 8 | 64 | `250,000 / 10,000` | speed |
| *(no group)* | — | 16–19 | **1M · 2M · 3M · 4M**, all `/100,000` | 4-step progression |
| *(no group)* | — | 45, 54 | 2 × `50,000,000 / 500,000` | |
| *(no group)* | — | 73 | `50,000,000 / 5,000,000` | the single largest bonus award on any table |

**[disk]**

### 6.3 Against the secondary sources

| **[src]** claim | Verdict |
|---|---|
| Free-fall, bungee, cliff-diving, off-piste modes | **CONFIRMED** — `DO SOME FREE FALLING` / `AND CHALLENGE DEATH`, `GIMME YOUR BEST` / `RUBBERBAND JUMP`, `FIND THE HIGHEST` / `CLIFF AND DIVE`, `GO OFF PISTE MANIA FOR` / `WHITE POWDER JACKPOT` |
| Bonus counts **up** while its timer counts **down** | **MECHANISM CONFIRMED** — engine `0x6334` services add-direction and subtract-direction BCD ramps from one list on one tick, selected by bit 0 of object`+0x01` (§2.11). **Which ramp object is the bonus is [open]** |
| "Iron Man" is a **four-ball** multiball | **NOT ESTABLISHED.** No literal 4 is used as a ball count. Balls-in-play is a word at `$DBC(a5)` derived by counting occupied slots in the 8-byte array at `$EE2(a5)` (`0x4ADC–0x4B0C`) and clamped to 8 at `0x4B10` — never read from a constant. The Iron Man mode object `0x557E` is referenced by exactly **four** records (33 with code `0x0E`; 34/35/36 structurally identical with code `0x1B` and secondary pointers to three 42-byte records at `0x53D8/0x5402/0x542C`). Three lock records plus the ball in play *would* give a four-ball multiball, but that is an inference from record counts, not a decoded constant. **[open]** |
| Named awards: Maniac Skier jackpot, Super Iron Man jackpot | **PARTIALLY** — `GET THE SUPER` / `IRON MAN JACKPOT` is present at `0x537C/0x5392`. **No "Maniac Skier" string exists.** The nearest are the four ski-trick names `SPLIT`, `DUFFY`, `KOSAK`, `LOOP` (`0x4F8A–0x4FC0`, all x=80) and `GO OFF PISTE MANIA FOR` / `WHITE POWDER JACKPOT` — "off piste mania" is plausibly what the source garbled, but this document does not assert that |
| Combo scoring from ramp shots in quick succession | **[open]** — the combo bonus constant is 1,000,000/combo on all three tables (§2.7), but no combo *window* was found |
| Defaults to twice the nudge tolerance | **REFUTED as stated, CONFIRMED as corrected** — record 6 defaults to 10 vs 5, but record 6 is the ball-save grace in seconds, not nudge tolerance. Extreme Sports gives **10 seconds of ball save, not 10 nudges**. Its tilt sensitivity (record 4) is 100, identical to the others. **[disk]** |

Nine scripts push the panel `TIME` label — eight → `0x6306` (x=240) and one → `0x6314`
(x=64, the off-piste mode), so there are 8–9 timed features. **[disk]**

Menu blurb, `Table003.seg00.bin` file `0x3980`: *"Extreme Sports / The quest for the
ultimate adrenaline kick. … Welcome to the world of extreme sports: Iron Man Races,
balloon bungee, cliff diving, 50mph skateboard runs, vertical rock climbing and chess
tournaments!"* **[disk]** — note "Iron Man **Races**", which is the only in-data support
for Iron Man being a race rather than a multiball.

---

## 7. What is measured but not yet usable

These are real measurements that cannot be wired into the reconstruction yet, and it is
worth being explicit about why.

- **337 award values with no trigger keys.** §0. The award arrays are indexed 0..122 /
  0..115 / 0..97 and nothing found maps an index to a material index, a lamp, a switch or
  a coordinate. One prior report annotated BabeWatch records as "material 82..86" for
  indices 50..54 (implying `material = index + 32`); **that annotation is unsupported —
  no derivation for it appears anywhere in the source material and nothing in this
  re-measurement reproduces it.** Do not build on it. **[open]**
- **No mode timer durations.** §2.11.
- **No script grammar.** §2.9. Without it the modes' rules — what advances a stage, what
  resets it, what the `TIME` labels are counting — stay closed.
- **The loader link is missing.** Nothing in a table module points at its own root
  tables (`0x2746`/`0x2936` etc.), and the `a5` slots the engine reads them through
  (`$2352`, `$2356`, `$235A`, `$235E`, `$236A`, `$236E`) are **only read, never written**
  anywhere in `main.seg00`. There is a loader that was not found. Until it is, the
  association "array at `0x2746` = the award table" rests on the field-offset match plus
  the cross-table round-BCD check — strong, and reproduced independently here for all
  three tables, but not a traced pointer. **[open]**

## 8. Container-format corrections

Two tooling bugs found during this work, recorded because they invalidate derived files:

- **`TSL!` flag `0x00010000` means allocate-only**, not "stored raw": the segment has
  `declared_size` bytes of uninitialised memory and **no payload in the file**. Proof:
  `main.bin` declares 12 segments but contains 11 `ATN!` streams, and the stream after
  descriptor 8 declares 228 bytes (descriptor 10), not 11,664 (descriptor 9, the flagged
  one). `menudata.bin` declares 317,276 bytes across 5 segments in a 36,000-byte file,
  with descriptors 1 and 2 flagged `0x00010002` at 81,920 bytes each (= 320×256, a screen
  buffer). **[disk]**
- Consequently `split_tsl.py` truncated `main.bin`: `main.seg09.raw` is not a segment,
  it is a mis-sliced piece of descriptors 10 and 11. The two real segments were
  re-extracted to `seg\main.seg10.bin` (228 B) and `seg\main.seg11.bin` (27,104 B);
  both are data. Separately, `seg\Table00N.seg00.*` had been overwritten by a later run
  that split the `.mnu` files; a clean re-split lives in `seg2\`. **[disk]**

## 9. What would actually close the remaining gaps

In cost order. The honest summary is that **static analysis has probably reached its
practical limit for the rules, and observation is now the cheaper route.**

1. **Observe the original under emulation** — WinUAE/FS-UAE with an A1200/AGA
   configuration, the four ADFs already converted. This closes, in a single sitting and
   with no reverse engineering at all: what each mode's timer is, what each shot is
   worth, what the multiplier ladder maps to, how many balls Iron Man serves, what the
   combo window is, and whether the panel appends zeros to stored award digits. Every one
   of those is a §0 grade-F item. **This is the recommendation.**
2. **Instrument the emulator** rather than just watching it — breakpoint
   `main.seg00` `0x6BCC`/`0x6BEE`/`0x6B96` and log `a3` on every call. Each hit gives
   (award record address → game event) directly, which is exactly the missing key from
   §7. A few minutes of play would map most of the 337 records. This is the single
   highest-value experiment available and it needs no further static work.
3. **Find the loader** — the code that writes `$2352`–`$236E`. It is not in
   `main.seg00`, and no other `main.segNN` contains code, so it is in the `Pinball`
   loader executable or is built at run time. Closes §7's last item.
4. **Solve the script grammar** — only worth doing after (2), because (2) tells you
   which scripts matter.

Do **not** attempt to fill any `[open]` in this document by inference from the values
that are known. The prior round of this work produced a plane partition off by 20 rows,
a map off by 32 px, a renderer drawing the wrong artwork, an award table declared
non-existent while sitting in plain sight, and an award magnitude wrong by a factor of
ten thousand — all of which passed every test in place at the time.

---

## 10. Contradiction register

Recorded rather than silently resolved. Each was re-measured from raw bytes for this
document; the resolution and its evidence are given.

### 10.1 Award magnitude — a factor of 10,000

- **Investigator B (BabeWatch)** reported the award as the 6 bytes at record `+0x1C..+0x21`,
  giving BabeWatch's lock ladder as **500 / 1,000 / 1,500 / 2,000 / 2,500**, and flagged
  the absolute magnitude as unproven.
- **Investigator C (Extreme Sports)** reported an 8-byte field at `+0x1C` whose
  significant bytes are `+0x1E..+0x23`, giving values in the millions, plus a **second**
  award field at `+0x24` (bonus) that B did not report at all.

**Resolved in favour of C**, by hand-decoding `main.seg00` `0x6B96` and its call site:
`lea $2C(a1),a3` then `jsr $6B96`, and `0x6B96` reads `[a3-6..a3-1]` into BONUS and
`[a3-14..a3-9]` into SCORE. That is `a1+0x26..0x2B` and `a1+0x1E..0x23` exactly. B's
window is shifted two bytes low, which divides every value by 10,000, and B's report
omits the bonus field entirely.

Note that **roundness cannot arbitrate this** — both windows produce round numbers on all
three tables, because they differ by exactly two BCD bytes. Only the disassembly settles
it. Every value in §4–§6 uses C's window.

### 10.2 Does Law 'n Justice have an award table?

- **Investigator A (Law 'n Justice)** searched hard and reported **AWARD VALUE TABLE —
  NOT FOUND**, concluding the magnitudes live in the engine, and described the array at
  data `0x2746` as "the module's general handler/script table".
- **Investigator C** asserted the same construct exists in all three tables, at Table001
  `0x2746` with 123 entries, but only spot-checked 12 records.

**Resolved in favour of C.** The array at `0x2746` *is* the award table: all 123 slots
are relocations, all 123 records decode as valid BCD in the `+0x1E`/`+0x26` windows, the
high halfword of both 8-byte fields is zero in all 123, no relocation lands anywhere in
`+0x1C..+0x2B`, and the values form coherent ladders (§4.2) including a monotone
5M→50M climb across records 8–22.

Investigator A found the right array and applied the wrong test — they scanned for
*standalone* BCD runs with a consistent stride and an indexed reader, and the awards are
embedded per-record in a variable-stride array reached by pointer. A's methodology note
is still worth reading: they correctly caught and killed a false ladder at
`0x338C..0x33CC` that looked like 10,000/20,000/…/60,000 at stride 12 but is really
`{u32 index 1..6, u16 op, u32 ptr, u16}` with the index bleeding into the next opcode
word.

### 10.3 Player record offsets

A described the score as living at `$243A..$243F(a5)`; B and C describe it at
`player+0x02..+0x07` via `$DC2(a5)`. **Both are right and they are different things** —
`$243A(a5)` is a scratch accumulator used by the *table module's own* native end-of-ball
routine, `player+0x02` is the persistent per-player score. `0x51C6` copies the former
into the latter. No conflict.

### 10.4 Record size

B reported 52–56 bytes; C reported a flat 52. **Measured: neither.** Strides are 52, 54,
56, 58, 60 and 64 depending on the record, and the `+0x34` group pointer exists only on
records of 56 bytes or more (§2.4). A fixed-size reader would mis-parse ~35% of them.

### 10.5 Mode-table entry counts

C reported Table001 `0x2936` n=16, Table002 `0x29BA` n=13, Table003 `0x292C` n=15;
A independently reported Table001 n=16 and warned it becomes "17" if the preceding NULL
is miscounted. **Both confirmed by direct measurement** — and the miscount warning turns
out to be the most likely origin of the "17 missions" figure. See §4.1.


---

## 11. The geometry-to-award link, and the ball locks

Both halves of what §0 used to grade F. Data offsets throughout, per §1.

### 11.1 Slot 1 is the per-pixel SURFACE-ID map

Not a "cell coverage index" — it is the collision outline's id map, one block per
playfield level. Layout, after the 4-byte declared-length preamble:

```
block A (LOWER level)              block B (UPPER level), immediately after A
2400 x u16 offset table (4800 B)   2400 x u16 offset table (4800 B)
(col, id) byte pairs               (col, id) byte pairs
```

Offsets are **pair indices**: list *i* occupies bytes `base + 2*offs[i] .. base +
2*offs[i+1]` where `base = blockStart + 4800`. List index *i* → `y = i / 4`,
`band = i % 4`; column *c* → `x = c + 84*band`. Block sizes check to the byte on
Table002 and Table003 and leave 2 slack bytes on Table001. **[disk]**

The consumer is `main.seg00` data `0x00AD42..0x00AE3E` and it implements the format
literally: `move.w (a2,d1.w*8),d2` reads `offs[y*4 + band]`,
`lea.l $12c0(a2,d2.l*2),a2` skips the 4800-byte table and doubles the pair index,
`cmp.b (a2),d0 / addq.l #2,a2` scans for the column, `move.b $1(a2),d2` takes the id.
Then `cmpi.w #$1f,d2 / jsr $ae40(pc,d2.w)` for ids 0–31 and
`subi.w #$20,d2 / move.w d2,$6c(a4)` for ids ≥ 32. **[disk]**

Independent check before the consumer was found: block A covers **100.0000 %** of the
slot-2 bit-0 pixels on all three tables and block B **100.0000 %** of bit-1. Block A's
surplus over bit 0 is exactly the flipper ids 1–4 — the swept footprints of moving
parts. Every rejected alternative scored at chance. **[disk]**

Id vocabulary, straight out of the 32-entry jump table at `0x00AE40`:

| id | meaning |
|---|---|
| 0, 5–9, 12–15 | passive; behaviour is only the 4 words of physics constants at `id*8` |
| 1–4 | flippers 0–3, record stride 506 bytes |
| 10 / 11 | move ball to upper / lower level, zero its velocity, sound `$68` |
| 16–21 | bumpers 1–6 (`$4(a4) = id - 15`) |
| 22–31 | slingshots 1–5 (`$5(a4) = ((id-22)>>1)+1`; even ids kick +400, odd −400) |
| ≥ 32 | **device index = id − 32** |

**This is the first key.** Device index → the per-level NULL-terminated array of device
record pointers at `$60(a4)` → the record → its inline award. The dispatch on the
record's word 0 is at `0x0055A0` and has three handlers: `0x55CE` target/trigger,
`0x564C` mode start, `0x56B0` kicker (overwrites the ball velocity from `$6(rec)`).
**[disk]**

Notable per-table findings: Law 'n Justice carries a **third flipper** (id 1, swept
footprint x29–84, y295–348) that this reconstruction does not yet place; BabeWatch has a
**kickback** at (13,529) sitting on its own `KICK BACK` insert, matching the string
`KICKBACK ENABLED`; Extreme Sports has **four** bumpers where the others have three.
**[disk]**

### 11.2 The awards are inline, not tabulated

Three call sites, each passing `a3` = one past the end of a 16-byte value block:

| site | primitive | fields |
|---|---|---|
| `0x545E` | `0x6B96` score+bonus | trigger `+$10..$15` score, `+$18..$1D` bonus (first hit) |
| `0x5448` | `0x6BCC` score only | trigger `+$20..$25` score (repeat hit) |
| `0x5564` | `0x6B96` score+bonus | lock `+$1E..$23` score, `+$26..$2B` bonus |

Every recovered value is BCD-clean, which is the check. Law 'n Justice's five bottom
rollovers pay 100000 / 20000 / 20000 / 20000 / 100000 first-hit and nothing on repeat;
its two upper triggers pay 250000. **[disk]**

### 11.3 Ball locks — zone type 4

Zones are 14-byte records `{u16 x0,y0,x1,y1; u16 type; u32 object}` in a per-level list
at `$64(a4)`, walked once per live ball per frame from `0x52E6` against the ball's
**centre**. Five types: 0 shooter lane, 1 scoring trigger, 2 up a level, 3 down a level,
4 **capture**. List offsets: Table001 `0x25E6` / `0x26B2`, Table002 `0x25DE` / `0x2728`,
Table003 `0x25EC` / `0x26D4`. **[disk]**

| table | level | rectangle | award |
|---|---|---|---|
| Law 'n Justice | 0 | (85,60)–(145,100) | 250,000 |
| Law 'n Justice | 0 | (235,165)–(260,190) | 500,000 |
| Law 'n Justice | 0 | (55,170)–(85,200) | 100,000 |
| BabeWatch | 0 | (66,48)–(86,68) | 500,000 |
| BabeWatch | 0 | (152,110)–(172,130) | 500,000 |
| BabeWatch | 0 | (145,14)–(165,34) | 500,000 |
| BabeWatch | 0 | (200,250)–(230,295) | 500,000 |
| BabeWatch | 1 | (70,40)–(110,80) | 500,000 |
| Extreme Sports | 0 | (249,159)–(269,179) | 250,000 |
| Extreme Sports | 1 | (65,10)–(105,50) | 250,000 |

Capture (`0x552A`) refuses a ball already held and a saucer already occupied, sets bit 7
of `$1(a4)`, and never moves the ball. The integrator skips any ball with that bit
(`0xA684` / `0xA6CE` / `0xA718`). Release is opcode `$68` (`0x5B4E`) and puts the ball in
the **serve queue** `$D86(a5)`, not back on the playfield. Multiball is opcode `$6C`
(`0x5BCC`), a top-up to a requested count with a hard `cmpi.w #$3` refusal above three.
**[disk]**

**Explicit negative, unchanged by all of the above:** the lock counters at `device+$03`
and `$23E4(a5)` are written and never read, and `device+$02` — the byte gating those
increments — is zero on every type-4 device on all three tables as shipped. "N locks
light multiball" is per-table script data and the script streams are still **[open]**.

### 11.4 The script VM, decoded

Fetch at `0x58E8`. The opcode word stored in the stream **is** the byte offset into the
dispatch table: `opcode = 4 + 4k`. Table base data `$5912`, entries `$5916 + 4k` of
`(handler_offset.w, length.w)`, handler `= $5916 + entry[0]`, length in bytes including
the opcode word. 31 entries; opcode 0 terminates. Known so far: `$2C` set ball save,
`$64` option-record-7 test, `$68` lock release, `$6C` multiball. A second, structurally
identical VM lives at `0x66A4` (code at `object+$06`, table base `$6748`, 26 entries)
and is undecoded. No byte range in any table module has yet been found that parses as a
valid stream for either. **[disk]** / **[open]**

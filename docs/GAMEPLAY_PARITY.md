# Gameplay parity spec — Pinball Illusions

The target behaviour this reimplementation is measured against. Every claim is tagged:

- **[disk]** — measured from the operator's own disks (see `DISK_ANALYSIS.md`)
- **[src]** — from published secondary sources (reviews, retrospectives, encyclopaedic entries)
- **[open]** — not yet established; must be observed before it is implemented

Secondary sources contradict each other on several points. Where they do, the disk
wins, and unresolved conflicts are recorded rather than papered over.

> **Rules, scoring and options now have their own document: [`RULES_SPEC.md`](RULES_SPEC.md).**
> It carries the score representation, the per-table award tables, the mode inventories
> and the settled meaning of all seven `.opt` records, each with the byte offset that
> proves it — plus an honest grade of what the excavation did *not* reach. This document
> keeps the physical and behavioural target; `RULES_SPEC.md` keeps the rules. Several
> **[open]** items below are closed there, and three claims below were **refuted** by it
> and are corrected in place.

> **Every column number in this document is 32 larger than it was.** The shipped
> collision maps were exported a word out of phase — slot 2's payload begins at byte
> 4, not byte 8 — so every row of the old export was framed 32 px left of where it
> belonged. The maps have been re-exported and every measurement re-run. Rows are
> untouched, because a horizontal reframe cannot move a row; that invariance is the
> cleanest check that the correction is a correction. Two conclusions did not survive
> the re-measurement and are marked where they appear: Law 'n Justice's arch ramp does
> **not** run off the left edge of the bitmap, and the virtual left wall named nothing
> and did nothing.

## Release identity

- 1995, 21st Century Entertainment; third in the Dreams → Fantasies → Illusions line. **[src]**
- Requires AGA; 256-colour artwork authored for AGA rather than upscaled from the
  32-colour Amiga releases that preceded it. **[src]**
- The disks here are the four-disk AGA floppy release, volumes `PIN3001`–`PIN3004`. **[disk]**

## Table set

Three tables. **[disk]** — names exactly as stored in `tables.bin`:

| id | Name | Theme |
|---:|---|---|
| 1 | Law 'n Justice | Future-city police **[src]** |
| 2 | BabeWatch | Beach / lifestyle, with a music-selection feature **[src]** |
| 3 | Extreme Sports | Bungee, free-fall, cliff diving, off-piste **[src]** |

*The Vikings* is **not** part of this release — it was added by the porting team for
the PC CD-ROM and console versions. It is out of scope. **[disk]/[src]**

## Defining feature: multiball

Illusions is the first in the series to have it, and it is the reason the engine
cannot simply be lifted from the Dreams or Fantasies reconstructions — both of those
simulate exactly one ball.

- **The ceiling is THREE, and this is now settled.** Sources disagreed (three versus
  six) and this document previously said eight, reading the 8-entry array at
  `$EE2(a5)` / count at `$DBC(a5)` as balls. That array is the **players**, not the
  balls. The ball array is built at `main.seg00` data `0x3536`:
  `lea $f92(a5),a0 / lea $f9e(a5),a1 / lea $faa(a5),a4 / move.w #$2,d7` then a `dbra`
  with `adda.w #$6e,a4` — exactly **three** objects of 110 bytes, and
  `$FAA + 3*0x6E = $10F4` with the next live global at `$10F6`, so there is no room
  for a fourth. Corroborated twice more, by the per-ball render-buffer init at
  `0x34C0` (`move.w #$3,d0`) and the reset-all loop at `0x3E84`. And the multiball
  opcode itself refuses more: handler data `0x5BCC` starts
  `move.w $2(a1),d1 / cmpi.w #$3,d1 / bhi` — a request for four falls straight through
  and does nothing. **[disk]**
- **Multiball is a TOP-UP, not a fixed count.** Opcode `$6C` takes the target ball
  count as a word parameter and loops `while (live + queued < N) queued++`, so two-ball
  and three-ball multiballs are both expressible. **Which one each table asks for is
  now SETTLED, from the shipped scripts themselves:** across all 970 exported mode
  scripts (Law 'n Justice 304, BabeWatch 342, Extreme Sports 324) every
  `BALLS_UP_TO` operand is **2 or 3** — LnJ one 2 and three 3s, BW three 2s and three
  3s, ES three 3s — and a raw byte scan of the script segments in `seg_clean`
  (`Table00N.bin.seg04.bin`, pattern `00 1B 00 xx`) matches the export exactly with
  **zero occurrences of operand 4**. No shipped script ever requests four balls, the
  engine would refuse it if one did (`cmpi.w #$3,d1 / bhi` at data `0x5BD0`), and the
  ball array is physically three objects — the four-ball question is settled at both
  the content and the capability level. **[disk]** A locked ball is released by opcode
  `$68` (data `0x5B4E`), which does *not* kick it out of the saucer — it clears the
  held flag, re-initialises the ball object and increments the serve queue `$D86(a5)`.
  Locked balls come back out of the **plunger lane**, one at a time, gated by
  `$D88/$D89(a5)`. **[disk]**
- **A held ball is frozen, not removed.** Capture is zone type 4, handler data
  `0x552A`: it refuses if the ball is already held or the saucer occupied, records the
  ball id at `device+$01`, sets bit 7 of the ball's flag byte
  (`ori.b #$80,$1(a4)`), awards score and bonus, and never touches the position. The
  integrator then skips any ball carrying that bit — `tst.b $1(a4)` / `bmi` at
  `0xA684`, `0xA6CE`, `0xA718`. **[disk]**
- **How many locks light multiball is NOT in the shared engine, and that is a result.**
  The engine keeps two lock counters — per device at `+$03` and global at `$23E4(a5)` —
  and reads **neither**; `$23E4` is written at exactly one site (`0x5554`) and read at
  zero sites across `main.seg00` and `main.seg01`. Worse, `device+$02`, the byte that
  gates those increments, is **zero on every type-4 device on all three tables as
  shipped**, so the counting path is dead at load time. The rule lives in per-table
  script data, **and it is now DECODED end to end**:
  - Every lock device carries its own capture script via `device+$14`
    (`move.l $14(a1),d0 / jsr $6c10` at `0x557A`), and those scripts are exported —
    BabeWatch's five locks fire scripts 52/53/54/55/57, LnJ's three fire 62/63/64,
    ES's two fire 36/37. **[disk]**
  - **The dispatch that runs the Nth launcher on the Nth capture is award
    effect 6, and it is one linear per-game counter.** The capture script `AWARD`s a
    lock-lit lamp element whose award-effect index is 6; the handler (`0x5E5A`)
    increments the per-player counts in the element's counter record (`+$34`, the
    same record family effect 21 uses) and walks the 12-byte launcher table inline
    at the record's `+$50` (`0x5EAA`) — the mission selector's own
    `{u16 id, u16 mask, u32 launcher, u32 lamp}` format, which is why no relocation
    points at it and the earlier export missed it. The entry whose ascending id
    equals the count has its launcher queued through `$6C10`; walking past the
    `0xFFFE` terminator subtracts the word after it from the count and re-walks
    (`0x5F26`), so the ladder wraps. **BabeWatch's table (h4+0x49F8, ids 1..10,
    wrap 10)** is capture tiers of 1/2/3/4: the tier-completing ids launch scripts
    110/114/117/119 (`BALL 1..4 LOCKED` + `MODE_START` of the four multiball modes
    179 `BALLS_UP_TO 2`, 182 `3`, 188 `2`, 192 `3` — the FIRST lock of a fresh game
    starts a two-ball multiball) and the intermediate ids the `n MORE TO START
    MODE` alternates. **The alternates are purely positional** — the
    "chosen while a mode is already running" hypothesis is REFUTED; no reader of
    the running-mode flag `$d9b` exists anywhere on the dispatch path. (A launcher
    that fires while another mode runs still loses its `MODE_START` to the
    one-mode-at-a-time gate at `0x5D80` even though the ladder consumed the count —
    a consequence the port models.) **Law 'n Justice is the same mechanism**
    (table h4+0x40F4, ids 1..14, wrap 5): tiers of 2/3/4/5 JAIL locks, multiball at
    ids 2/5/9/14 (scripts 93/94: `BALL_REMOVE` jail then `BALLS_UP_TO 2`/`3`), every
    later multiball costing 5 locks. Only the scripted saucers count — BW's three
    level-0 grid saucers (lamps 29/30/31) and LnJ's jail (lamp 26, **lit by the
    SHOOT JAIL targets**, device surface ids 128/129, script 78) — the other
    rectangles award and eject without counting. `SET_COUNT` (handler `0x5C64`)
    writes the counter directly, which is how BW's four selectable jackpot missions
    arm tiers 1..4 with values 0/1/3/6; the `AWARD` relight (`flags & $A` at
    `0x5CA8`) keeps a lock lamp lit across its own award. **[disk]**
  - **`PUSH`/`PUSH_LINKED` on a lock is the physical eject.** The operand is the
    lock DEVICE record (the exporter's element pool misclassifies it); handlers
    `0x5BFC`/`0x5C14` push it onto the stack at `$23DC(a5)` and the per-frame popper
    `0x7078` runs a `$4C`-frame timer, then ejects the held ball using the device's
    own position and impulse words (`+$06..$0D`) — so a non-final lock spits the
    ball back out, and the final lock's entry (no push) leaves it held for
    `BALL_REMOVE`. **[disk]** The eject VECTORS are not yet exported; the port
    returns an ejected ball through the trough and serve queue instead, a labelled
    reconstruction (`runModes` in game-loop.ts).
  - **Extreme Sports has no lock ladder.** Its lock capture scripts award
    effect-**17** elements (a direct event-record dispatch at element `+$34`) whose
    handler is **not decoded**; its `BALLS_UP_TO 3` modes are mission-launched. An
    ES lock is a scoring eject until effect 17 is traced. **[open]**
  - One residue left, and one closed in round 7. CLOSED: the site that lights
    lamps for the first time in a fresh game is the per-GAME reset at
    `main.seg00 +0x004052`, which arms every element whose flags bit 1 ($02) is
    set and lights its START lamp; the per-BALL reset at `+0x003F80` repeats it
    and additionally keeps ARMED for flags bit 0 and DONE for flags bit 5. The
    lock lamps are not in that set on any table, so the first capture of a game
    counts nothing. **[disk]** STILL OPEN: nothing was found that resets the
    per-game ladder counters at game start (either the table module is reloaded
    per game or ladder state persists across games in one session); the port
    zeroes them per game, labelled (`ladderCounts` in mode-vm.ts). **[open]**
- The display switches to a high-resolution full-screen mode while multiball is
  active so every ball stays visible; toggleable by the player. **[src]** — the
  mechanism is now identified as option record 7 with its two display configurations
  (`$3C1E` wide / `$3BDC` narrow). **[disk]**
- Multiball is entered by locking balls, per table. **CONFIRMED** — Law 'n Justice has a
  4-step ladder (`1..4 MORE FOR M-BALL`), BabeWatch has `BALL 1..4 LOCKED` plus
  `LOCK 1 BALL 4 M-BALL` … `LOCK 4 BALLS 4 CASINO`. See `RULES_SPEC.md` §4.3, §5.3.
  **[disk]**

Engineering consequence: the simulation must be N-ball from the start — ball list,
ball-to-ball collision, per-ball state, drain handling while others remain live, and
a camera policy that changes when ball count exceeds one. Retrofitting this later
would mean rewriting the physics core.

**Implemented**, in `src/game/ball-locks.ts`, `src/game/mode-vm.ts` (award effect 6,
`SET_COUNT`, the `AWARD` relight, the `PUSH`/`BALL_REMOVE` lock releases) and the
lock sections of `src/browser/game-loop.ts`; the decoded ladders themselves ship in
the mode export (`ladders` in `*.modes.json`, `scripts/export-table-modes.mjs`). The
ten decoded capture rectangles, capture, freeze, release-to-serve-queue, the
three-ball ceiling, the top-up **and the multiball lock ladder** are all as above —
**the port's old "two saucers held lights a three-ball multiball" reconstruction is
deleted**, and both tables with a lock multiball now run the one decoded code path
(BabeWatch: first counted lock starts the 2-ball SHOW YOUR MUSCLES; Law 'n Justice:
second lit jail lock starts the 2-ball mode, with the jail lamp lit by the SHOOT
JAIL targets). Extreme Sports' locks eject and start nothing, which is as far as its
decode goes (effect 17, **[open]**). Labelled **reconstructions** that remain: a
capture which leaves nothing rolling buys the player a replacement ball (and the
saucer is remembered so a later scripted eject of the same ball does not owe a
second serve); an ejected ball returns through the trough and serve queue rather
than being kicked from the saucer in place (the decoded eject vectors at
device+$06..$0D are not yet exported); the lock lamps no physical trigger can light
are lit at game start; and the per-game ladder counters start at zero each game.
Balls the machine owes itself are auto-launched after half a second, because a
player already flipping two balls cannot also be winding a spring; a ball the
*player* was given is never auto-launched. And as before: a ball that settles inside
an **occupied** saucer — which capture must refuse, per the engine — is swallowed
back to the trough as an owed serve by the ball search rather than written off,
which is the decoded `$68` release semantics applied to the one place the playfield
genuinely cannot return a ball from (see the census baseline below, and
`runBallSearch` in `game-loop.ts`).

## Options — SETTLED

All seven records are now identified positionally, from the code that consumes each
live word. Full derivation, with every consuming instruction, in
[`RULES_SPEC.md` §3](RULES_SPEC.md#3-options--table00nopt-fully-settled). **[disk]**

**The record layout previously given here was wrong.** It is not
`{u16 value, u16 max, u32 default, FFFF}`; it is
`{s16 min, s16 max, u16 current (always 0 on disk), u16 default, u16 flag}`. The old
"u32 default" was current(=0) followed by default, which is why the published defaults
were right and the first word of every record was not.

| # | Setting | Range | Default | Live word | Was |
|---:|---|---|---:|---|---|
| 1 | Balls per game | 3–5 | 3 | `$E84(a5)` | confirmed |
| 2 | **Table slope** — downhill (Y) acceleration | 2–8 | 4 | `$E86(a5)` | **was "players" — refuted** |
| 3 | **Camera follow divisor** — `divs.w` on (ball Y − camera Y − ANCHOR); there is no dead zone | 1–7 | 5 | `$E88(a5)` | **was [open] — closed** |
| 4 | **Tilt sensitivity** — counts added per nudge KEY PRESS against a hard-coded threshold of 200, decaying four a frame | 0–200 | 100 | `$E8A(a5)` | **was [open] — closed** |
| 5 | **Lateral lean** — sideways (X) acceleration bias | −3…+3 | 0 | `$E8C(a5)` | was "table slope" — it is the other axis |
| 6 | **Timed ball-save grace, in whole seconds** (× `GfxBase.VBlankFrequency` → a frame countdown) | 0–10 | 5 (**Extreme Sports 10**) | `$E8E(a5)` | **was "nudges before tilt" — refuted** |
| 7 | **View / screen mode**: 0 = always narrow, 1 = always wide, 2 = narrow, script may switch to wide | 0–2 | 2 | `$E90(a5)` | **was "max multiballs" — refuted** |

Consequences worth restating:

- **Nudge tolerance is record 4, and it is identical on all three tables (100).** Extreme
  Sports' "double tolerance" was record 6 — it gets **10 seconds of ball save, not 10
  nudges**. The claim under *Extreme Sports* below is corrected accordingly.
- **The tilt option is a sensitivity, and it is not "the second nudge".** Two details
  outside the routine decide what 100-against-200 means, and both were read wrong when
  this row was first closed. The add fires on the RISING EDGE of a nudge key (`$23EE` is
  re-armed by `ori.b #$7` at +0x00BC28 and the matching bit is cleared only when the
  `bset` finds `$23EF` already set), so holding a key counts once; and the decay runs once
  per COLLISION PASS, four times a frame, because +0x00BE90 is the tail of `$BC24` and
  `$BC24` is called at +0x00A65A/6A4/6EE/736. So one shove is forgiven in half a second,
  **two shoves can never tilt** (100 + (100−4) = 196), and **three inside half a second
  do**. `src/game/tilt.ts` implements exactly this and `DISK_ANALYSIS.md` has the listing.
  This is roughly twice as touchy as the chosen 5/5/10 allowance it replaces.
- **The camera is a proportional follower with no dead zone and no step cap**, and the
  shipped divisor of 5 is *forced* rather than tuned: the follower settles a ball falling
  at `v` px a frame on screen row `anchor + 2 x divisor x v`, and `70 + 2 x 5 x 16` — the
  anchor, the divisor and the engine's own ±4095 velocity clamp — is exactly the 230-row
  narrow window. Divisor 6 puts a max-speed ball off the bottom. `src/browser/camera.ts`
  implements the law; `DISK_ANALYSIS.md` has the thirteen instructions.
- **Record 5 (the table x-tilt) is wired but inert.** +0x00B754 adds it to the ball's X
  acceleration in the same instruction pair that adds gravity to the Y, so it takes the
  same 32-Q10-per-unit bridge and its ±3 range is three quarters of gravity of permanent
  lateral lean. The shipped value is 0 on all three tables.
- **Players are not an option.** They are chosen with F1–F8 at start
  (`PRESS ENTER OR F1-F8 TO BEGIN PLAY`); the 8-entry player array at `$DC6(a5)` is never
  sourced from the `.opt`. Multiplayer is sequential, not simultaneous. **[src]/[disk]**
- **Record 7 is the option behind the in-game `F9 FOR LO-RES` / `F10 FOR HI-RES` keys**,
  and it is the multiball camera switch that this document has been calling **[src]**:
  wide shows ~462 of the 600 playfield rows, narrow ~230, exactly 2×. Which of the two
  the game calls "LO-RES" is still **[open]**.

### The reading this replaced, and why it lasted

The day-one decode read the record as `{u16 current, u16 max, u32 default, u16 FFFF}` and
labelled the seven as *balls, players, three unknowns, table slope, nudges before tilt, a
multiball cap*. It reproduced every published **default** correctly — "u32 default" is
current(=0) followed by default, so the low word of the long is the right number — and
that is exactly what made it look verified. It was tagged **[disk]** and quoted throughout
the project for eleven commits.

Its most durable claim was **"nudges before tilt: 5 / 5 / 10 — Extreme Sports tolerates
twice as many"**. That is record 6, a duration in whole SECONDS (+0x0049AE multiplies it by
`VBlankFrequency` and counts frames). The same three digits, meaning something else, sitting
on the one record that genuinely does vary between tables — so the wrong reading arrived
with its own corroborating "parity fact", and every check anyone thought to run confirmed
it.

Two rules came out of it and the table above obeys both: **a decode that reproduces the
values it was derived from has not been tested, only restated**, and **a record's meaning
is established by the instruction that consumes the live word**, never by the plausibility
of its range. Each row now names that instruction, and the count of readers in the whole
segment is part of the claim.

**There is no options screen in this release and the option labels do not exist as text
anywhere in the shipped data** — established by exhaustive search, not merely unfound
(`RULES_SPEC.md` §3). The only menu descriptor in the program has three items: `Tables`,
`Exit`, `Info`. **Any option label in this reconstruction is the project's own invention
and must be documented as such.** The semantics are facts; the words are not. **[disk]**

## The timebase — SETTLED, and it was 5.33x wrong

The first defect this project found by PLAYING rather than by measuring: **the ball moved
as if it were in space.** Gravity was 24 Q10 per tick squared — inherited as a chosen
value from the sibling Pinball Dreams reconstruction and never measured — and a ball fell
the playfield's 600 px in 227 ticks, four and a half seconds, where a real machine crosses
the table in about one. The whole suite was green: **every physics test asserted a
DIRECTION or a REACHABILITY and not one asserted a RATE.** `tests/timebase.test.ts` is the
answer to that and is the file whose absence let this ship.

**The frame.** One physics tick is one PAL video frame, 50 Hz. The tick is `main.seg00`
+0x00A618 and each of its seven call sites sits in a loop ending on a raster wait
(`cmpi.b #$54,$dff006.l / bcs`). `$50(a5)`, which every duration in the game is scaled by,
is **not a game constant**: +0x00040E reads `ExecBase->VBlankFrequency` (the byte at
ExecBase+0x212) into it, so it is 50 on PAL and 60 on NTSC, and its seventeen uses are all
`mulu.w`/`divu.w` turning whole SECONDS into frames. **[disk]**

**The frame's shape.** The tick is unrolled into FOUR collision passes (`jsr $b4ba` at
+0x00A64C, +0x00A696, +0x00A6E0, +0x00A728 — the first of the four had been missed here,
and `ROLLING_SLIP_FRICTION` was computed over three) and EIGHT integration sub-steps
(`jsr $b6e8` at +0x00A660/666, +0x00A6AA/6B0, +0x00A6F4/6FA, +0x00A73C/742). **[disk]**

**The unit bridge, which is forced.** Each sub-step is `pos_Q10 += v >> 1` — the `asr.w #1`
at +0x00B710/+0x00B712 — so eight of them travel **4v** per frame, not 8v, and the
`asr.l #10` at +0x00B724 proves the original's position is the same Q10 pixels this port
uses. Therefore **one original velocity unit is 4 Q10 per tick and one unit of per-sub-step
acceleration is 32 Q10 per tick squared.** Independently confirmed by the engine's own
velocity clamp of ±4095 (+0x00B4D6, +0x00B692): 4095>>1 is 2047 Q10, one unit under two
pixels, i.e. the clamp is chosen so a ball cannot move 2 px between collision passes.
**[disk]**

**Gravity is 128.** Option record 2 (`$E86(a5)`, min 2, max 8, **default 4**) added to the
ball's Y acceleration once per sub-step at +0x00B758, with no multiply, no shift and no
per-table factor anywhere on the path — `$E86` has exactly two readers in the whole 53 KB
segment. 4 × 32 = 128 Q10 per tick squared; a 600 px fall takes 98 ticks, 1.96 s. The
slider's range is 64…256, so **the port's 24 was 2.7x below the weakest setting the
original ships.** **[disk]**

**What the correction moved, and by how much.** Every decoded velocity by 4x and every
decoded acceleration by 32x — the ramp drive vectors (1…15 units are now 32…480 Q10/tick²),
the pop bumper (5500 → 22,000), the slingshot (3500 → 14,000 plus ±400 → ±1600 along the
face), the nudge (600 → 2400, and 600 is measured at +0x00BC3E/+0x00BCA6/+0x00BCE6). What
did **not** move: every restitution, because the original's `$36` word is a pure ratio;
every duration, because they are frames; `WALL_FRICTION`, because it is a coefficient. What
moved by **sqrt** rather than by the factor: the plunger, because a fixed climb makes launch
speed go as √g — 2.309x, not 5.33x, and it was re-swept in the real loop rather than scaled
(6 px/tick → 14). **[disk]/[inferred]**

**The flipper stroke, which was listed as unfindable and is not.** The bat's animation is
the tail of `$BC24`, entered at +0x00BD46, and `$BC24` is called **once per collision pass —
four times a frame**. The bat is not driven at a constant rate: it carries an angular
VELOCITY under constant acceleration to a cap, and the per-table flipper records at
`$2346(a5)` (four records of 0x1FA bytes, reached from the surface-id jump table entries for
ids 1…4) give every number, identical on all three tables and mirrored between the bats:
**sweep 18 poses = 54°, coil 20 units/step capped at 120, spring 30 capped at 50.** That is
a full stroke in **3.5 ticks** and a return in 6.25, and a tip speed of 17.7 px/tick where
this port's chosen constant-rate stroke gave 9.4. The same records also carry the **pivots**
— (86,556)/(199,556), (112,556)/(227,556), (113,556)/(227,556) — and a **third record per
table**, at (37,302) on Law 'n Justice sweeping 11 poses, (205,115) on BabeWatch sweeping 13
and (182,194) on Extreme Sports sweeping 18. **All nine are now what the simulation runs
on**; see *The drawn bat and the colliding bat were two different objects* below for the
round that wired the lower six in and for what it cost the census. **[disk]**

**The flipper IMPULSE, which is the other half and was this port's own invention.** The
stroke above is what the bat does; what it gives the ball is +0x00AEA2, reached from the
surface-id entries for ids 1…4. It is not a reflection and it is not a rigid-body frame
change:

1. `move.w $10(a0),d2 / beq -> rts`. The bat's angular RATE is a **gate**. A bat that is
   not turning imparts nothing at all, however it is placed.
2. `d0 = |ballX − pivotX|`, `d1 = |ballY − pivotY|`, `d0 = (d0<<6) + d1`, and
   `move.w (a1,d0.w*2),d0` off a **64×64 word table**. The table is at offset `$B0B8` of
   **hunk 1** — the `lea.l $b0b8.l,a1` carries a hunk-1 relocation, which is why reading it
   as a hunk-0 address lands inside the impulse sub-handlers and why it has been reported
   as undecodable. All 4096 entries are exactly `isqrt((dx² + dy²) × 35810 >> 16)`, i.e.
   `floor(0.7392 × distance)`: **the table is the ball's distance from the pivot at three
   quarters scale**, and the table pins that constant to [0.73919716, 0.73920458), a
   bracket seven parts in a million wide.
3. `d3 = d0>>1` is **subtracted from the bat's rate** toward zero and written back to
   `$10(a0)`: the ball takes angular momentum out of the bat, the impulse is computed from
   the reduced rate, and a second ball on the same stroke gets less.
4. Small radii are floored — `if d0 < $2E: d0 += ($2E − d0) >> 3` — so a ball struck at the
   boss still leaves with something. On a 46 px bat every radius is under 46, so the floor
   always fires: with the re-measured silhouette the nearest a ball's centre can come to the
   pivot is boss 8 + ball 8 = 16 px, which the table reads as 11 and the floor lifts to 15,
   and a ball on the tip is 46 px out, read as 33 and lifted to 34. (At the old 5 px boss the
   nearest centre was 13 px, read as 9 and lifted to 13.)
5. One of eight sub-handlers at `$B036 + 0x3C·n`, chosen by the record's byte `$1(a0)`,
   writes `$1c(a4) = magnitude × 2 × rate` and `$1a(a4) = 8 × 2 × rate`. Those are consumed
   at +0x00B528: `$1C` is added to the **normal** component of the ball's velocity and
   `$1A` to the **tangential**, after +0x00B4FE has rotated the velocity into the contact
   frame using `$28(a4)` and a pair of 16384-scaled sin/cos tables. The rotation **doubles**
   (`asl.l #3` then `swap`, against a table scale of 2¹⁴) and the inverse halves, so the
   real impulse is `magnitude × rate` along the outward normal and `8 × rate` along the
   surface. Each sub-handler also carries an eight-byte mask indexed by `$28(a4)>>8` — the
   contact normal's octant — and the eight masks are the same four-of-eight pattern rotated
   one byte per handler: **the bat only imparts to a ball on the face it is sweeping
   toward**. The bounce that would normally follow is skipped outright once the kick has
   sent the ball outward (`tst.w d0 / ble` at +0x00B550).

**Why this mattered.** The port reflected the ball in the bat's instantaneous rigid-body
frame with an elasticity of 400, which scales the whole impulse by angular velocity times
lever arm and nothing else. After the timebase correction that model **saturated the
engine's ±4095 velocity clamp from about 30 px out along a 45 px bat, at every rate**: a
shot struck at the boss and one struck at the tip left at the same 800 px a second, three
of five contact points did not send the ball up the table at all, and no tuning could give
the flipper any dynamic range because there was none left to give. The measured law is
**bounded by construction** — the table is a distance and the rate deduction is a
self-limiter, so the largest impulse anywhere on the bat at the coil's cap is 89% of the
clamp — and its spread lives in the STROKE: a ball met at rate 20 leaves at a sixth of the
speed of one met at 120. `src/game/flippers.ts` implements it and
`tests/timebase.test.ts` asserts the bound as arithmetic. **[disk]**

## Physical layout

- Three flippers per table, and all nine are **[disk]**: pivot, rest and flipped pose, sweep
  and all four stroke rates straight off each table's own flipper record. The claim that
  BabeWatch and Extreme Sports carried two records only was an alignment artefact — the
  four-slot array starts at a different hunk-4 offset on each table — and all three ship an
  upper bat: Law 'n Justice (37,302) 11 poses, BabeWatch (205,115) 13, Extreme Sports
  (182,194) 18. `FLIPPER_RECORDS` in `flippers.ts` is the only placement in the port, and
  `tests/flipper-bats.test.ts` pins every field of it against the shipped pose bank by
  equality. **[disk]**
- Bumpers, ball traps, ramps, multi-level playfields. **[src]**
- Vertically scrolling playfield in normal play; full-screen hi-res during multiball. **[src]**
  — and the scroll itself is now **[disk]**: a proportional follower closing 1/5 of the
  error a frame onto an anchor 70 rows from the top of a 230-row window, half rate
  downward and inside the top 32 rows, no dead zone and no step cap. See *Options* above.
- Nudge with a tilt penalty for overuse. **[src]** — the penalty itself is **[disk]**: a
  warning counter that takes 100 per shove, decays four a frame and tilts at 200.
- **Playfield is 336 x 600 pixels on all three tables**, stored as four stacked
  1-bit layers of 620 / 620 / 600 / 600 rows (offsets 0 / 26040 / 52080 / 77280),
  combined into one per-pixel index in 0–15. Measured, not guessed — see
  `DISK_ANALYSIS.md`. **[disk]**
- **A pixel blocks the lower-level ball iff its index is odd** — bit 0 is the lower
  collision line and is the only bit the lower-level physics tests. Bit 1 is the
  upper collision line; bits 2 and 3 are structure artwork drawn *over* the ball and
  do not block it. Settled by four independent investigations. **[disk]**
- **The bit-0 collision layer is one pixel wide.** Law 'n Justice contains 41
  horizontal and 11 vertical solid runs exactly 1 px thick, so any collision scheme
  that cannot see a 1 px wall is wrong. **[disk]**
- The maps shipped at `public/generated/tables/*.map.json` are decoded under these
  corrected bases and are **current and correctly aligned**. An earlier decode used
  four equal 610-row planes and *was* misaligned; that is history, and
  `DISK_ANALYSIS.md` records how it was caught. **[disk]**
- Law 'n Justice has an open top border: rows `y = 0..34` carry no bit-0 line, so a
  ball can drift above the top arch across the full width. This is a map property
  needing a **virtual wall at `y < 26`** (safe — connectivity stays intact; `y >= 44`
  severs the upper playfield), not a physics bug. BabeWatch and Extreme Sports do not
  need it. **[disk]**
- **The top arch is on the bit-1 line, and the ball changes level to ride it.** Law 'n
  Justice's shooter-lane walls read bit-1 only up to `y = 126`, BOTH lines over
  `y = 127..175`, and bit-0 only from `y = 176` down; above the lane they curve left as
  two concentric bit-1 arcs (outer cap `y = 0..2` at `x = 164..188`, inner cap
  `y = 24..26` at `x = 164..187`) enclosing a channel about 21 px wide. A radius-8
  disc blocked by bit 1 alone travels it unbroken from the lane to the crown. So bit 1
  is neither globally solid nor globally passable: it is the collision line for a ball
  on the ramps, and the 49-row both-bits band is the hand-off. **[disk]**
- **Where the ramp puts the ball back on the playfield — and it is read, not guessed.**
  This entry used to say the channel's outboard rail ran off the left edge of the
  bitmap, that the ramp therefore died around `y = 91`, and that the engine released the
  ball on an invented row `y = 46`. All of that was the 32 px export phase error: the
  rail was 32 px in from column 0 all along. On the corrected map the channel is
  continuous from the crown to `y = 210` — free centres `[67-76]` at `y = 46`, `[38-45]`
  at `y = 80`, `[25-30]` at `y = 120`, `[34-43]` at `y = 200`, `[34-36]` at `y = 207` —
  never wider than fifteen centres and never empty. Its inboard rail stops at `y = 205`
  and by `y = 214` what is left has merged into the strip along the table's left edge.
  `ramp-end` sits at `y = 207`, the last row on which the whole channel is also free on
  the lower line (`[34-36]` inside `[34-45]`; at `y = 208` the channel steps to `[33-35]`
  and 33 is solid below), and `sameRingReading` holds across it, so it is a hand-off by
  the same standard the lane bands meet. There is no inferred coordinate left in
  `playfield-levels.ts`. **[disk]**
- **~~The hand-off is not what strands balls; the top-left corner is.~~ RETRACTED.**
  This said that nine of ninety Law 'n Justice balls ended in a top-left pocket, all of
  them released from the arch at exactly `(46,46)`, and that closing it needed a device
  layer. It was an artefact of the misframed map: the release point only existed because
  the ramp appeared to run off column 0, and the "bowl" the ball free-fell into was
  where the ramp actually still had 160 rows to run. With `ramp-end` at `y = 207` the
  ball is handed over at the wireform's real end and never enters the bowl. Measured on
  the same census after the reframe: **Law 'n Justice writes off nothing at all — 63
  balls, 63 drains, zero ball-search retirements**, against a budget that used to be
  35%. The pockets themselves are still there in the geometry, and a ball placed in one
  still stops; nothing now puts a ball in one. **[disk]**
- **The hand-off is a device all three tables use, and it is derivable.** Law 'n
  Justice's 49-row band was written out by hand; copied to the other two it did nothing,
  because a hand-tuned row is one table's answer rather than a model. The rule
  underneath it is readable off any map, and `src/game/level-scan.ts` implements it:
  walk the lane's centre column, take the free-ball-centre run on each collision line,
  and a **hand-off band** is a maximal set of rows where both runs exist, both are
  narrow enough to be a channel, and they are the *same* run. Over such a band the probe
  ring reads identically on both lines, so a level change there is unobservable — which
  is why the row chosen inside a band does not matter (moving Extreme Sports' upper gate
  anywhere in `y = 139..238` leaves the trajectory byte-identical). Direction comes from
  which line still carries the channel beyond the band. `tests/level-scan.test.ts`
  re-runs the derivation against all three shipped maps and asserts the shipped gates
  are what it produces. **[disk]**
- **BabeWatch's lane is bit-0 only at the bottom and bit-1 only above.** Bands at the
  lane column are `y = 279..343` and `y = 407..458`. Below the lower band bit 0 carries
  the lane to the floor at `y = 561`; above it bit 0 is pinched shut at `y = 372..379`
  where its own right wall crosses the lane, and bit 1 carries on. Without that hand-off
  the served ball sits in a **577-cell sealed box** spanning `x = 317..327`,
  `y = 379..552` — flooded from the serve point with the engine's own radius-8 ring —
  with no path to the drain at all, which is why the table drained nothing in twenty
  thousand ticks at any plunge strength. The bit-1 lane above the band is a wireform:
  both walls sweep left together, from `x = 310/332` at `y = 456` to `x = 279/301` at
  `y = 300`, and it **ends** — last free centre `(296,273)`, rails 15 px apart at
  `y = 268`, solid across by `y = 260`. Bit 0 is open right there (`x = 285..297` over
  `y = 266..274`, part of the main playfield), so the ramp delivers its ball onto the
  table the way a wireform does. **[disk]**
- **Extreme Sports' lane changes line twice.** Bands at `y = 408..479` and
  `y = 139..238`. Bit 0 carries the lane from the floor to `y ≈ 408` where it opens into
  a funnel; bit 1 carries it from `y ≈ 480` up to `y ≈ 135`, where a wall peeling off
  the left rail at `y = 145` curves right and closes it against the right rail by
  `y ≈ 100`; above the upper band it is bit 0 again, walls `x = 311..313` and
  `x = 333..335`, and then the arch. Without the first gate the ball leaves the lane
  sideways at `y = 408` and dies in the funnel beside it; without the second it noses
  into the closed top of the upper lane at `y = 136` and falls straight back down.
  Its left orbit is the same device again: the bit-0 funnel narrows to nothing (free
  centres `[42-52]` at `y = 136`, `[37-41]` at `y = 150`, `[35-35]` at `y = 161`, none
  at `y = 162`) while a bit-1 channel between rails at `x = 38..40` and `x = 64..66`
  **begins** at `y = 132`, and the two overlap at `x = 49..50` over `y = 132..139`. At
  the bottom both lines carry it over `y = 181..182` — byte-identical runs `[49-56]` —
  and it swaps back. The mouth gate's columns are the funnel's own free-centre run **on
  the gate's row**, `[42-52]`, plus column 53 where a ball riding the right rail
  crosses; they used to be the run four rows higher, and balls hugging the left rail
  crossed outside them and died at the funnel's dead end. **[disk]**
- **Extreme Sports' crown ramp ends on the other collision line.** Its top arch is on
  bit 0, so a launched ball correctly rides the crown on the LOWER line and comes down
  the outside of the outermost arc. That face runs out: free bit-0 centres in the wedge
  between the arc and the shooter lane's outer wall go `[266-302]` at `y = 150`,
  `[290-302]` at `y = 158`, `[302-302]` at `y = 162` and none at `y = 163`, with the
  arc's hairpin apex at `x = 305` five pixels short of the lane wall at `x = 311`. Every
  ball used to end there as a ball-search write-off, and the table's 30-in-30 was false.
  The cup is still exactly one pixel on the corrected map, so it was never a framing
  artefact. The continuation is authored: a band running diagonally from `(302,131)` to
  `(290,158)` is free on BOTH lines, and the bit-1 channel through it runs `[302-304]` at
  `y = 131` down to `[274-276]` unbroken from `y = 197` to `y = 380`. `crown-mouth`
  (`y = 158`, the band's lowest row, where the wedge's own floor arrives at it) and
  `crown-end` (`y = 349`, which `level-scan` finds unaided as a byte-identical band on
  the wireform's column) are that ramp-mouth / ramp-end pair. Without them the table
  drains nothing; with `crown-mouth` alone the write-offs move to the wireform's closed
  bottom end at `(276,380)`. **[disk]**
- **A ramp mouth on a diagonal has to be one column wider than the free-centre band.**
  `crown-mouth` spanned `x = 290..291`, which is a correct reading of the columns free on
  both lines at `y = 158` and a wrong trigger. The mouth slides two columns left every
  three rows and the ball's path down the arc's convex face is nearly parallel to it; a
  free *centre* is where a ball sits clear of everything, while a ball rolling in
  *contact* with the arc has its centre one column outside that set. Measured over the
  thirty-game census: of ninety crossings of row 158 inside `x = 270..310`, **eighty-one
  are at `x = 289`** and five at 290..291, so the gate caught five balls in ninety and
  the rest rolled on into the `(302,163)` cup. `minX` is now `289` — which is the
  both-free run one row higher (`{289,290,291}` at `y = 157`), is the lower line's own
  leftmost free centre at the gate row minus one, and is free on level 1, the line the
  ball is handed to. Effect with nothing else changed: 23/30 census games -> 26/30, 68
  drains -> 77, all three `(302,163)` stalls gone. Widening further (288..291, 289..302)
  changes nothing, which is the check that column 289 is the whole of it. **[disk]**
- **A full plunge is worth six pixels a tick on every table — but the derivation named
  the wrong target.** It said: against `g = 24` a launch at `v` rises `v^2/(2g) - v/2`,
  so the 536 px climb from the serve point to the top of the lane needs `v >= 5145` Q10,
  and six pixels (6144) is the smallest whole pixel above that floor. Every step is true
  and the answer is still 6144, which is why the error survived — but the shot is not the
  lane. The ball has to cross the top arch on the upper line, rubbing both rails, and
  still be moving on the far side. Swept through the real loop on the shipped maps, the
  shot first completes at a pull of **28/32 on Law 'n Justice (5504 Q10), 22/32 on
  BabeWatch (4544) and 26/32 on Extreme Sports (5184)** — all three above the 5145 the
  old floor allowed, so the old check could have passed on a ceiling that no longer made
  the shot. The binding requirement is Law 'n Justice's 5504 and 6144 clears it by 11.6%.
  The consequence, stated rather than left to be rediscovered: on Law 'n Justice only the
  top 12.5% of the pull completes the shot, so an under-plunge is common, and what makes
  that acceptable is that an under-plunge gives the ball back. (536 rather than 540: `bottomY` was re-measured with the
  engine's own ring, and no ball centre can be below row 552 with the shared lane floor
  on row 561, so the serve is on row 544.) It used to be seven here and **ten** on BabeWatch, and that
  whole spread was paying for the friction bug below - BabeWatch's extra three bought
  survival through the staircase bend above `y = 400` (in at 6664 Q10, out at 2492). With
  friction corrected all three tables complete the shot on six. A full pull still
  finishes the shot and a two-thirds pull still does not, so pull length still aims.
  **SUPERSEDED BY THE TIMEBASE, AND IT IS THE CLEANEST ILLUSTRATION OF WHY:** every
  number in the paragraph above was swept honestly in the real loop, and all of it was
  swept against a gravity of 24 that had never been measured. At the true 128 a six-pixel
  plunge reaches `y = 403` of a 510 px climb and no table completes at any pull. Re-swept,
  the ceiling is **fourteen** pixels a tick and the shot first completes at 29 / 17 / 27 of
  32. Note the factor: √(16/3) = 2.309, because a fixed climb makes launch speed go as
  √g — this is the one constant in the audit that did *not* move by the 5.33x everything
  decoded off the disk moved by. The two-thirds line is gone: BabeWatch now completes from
  53%, because its lane is the only one the ramp map does not drive and its channel hands
  over to the upper line at `y = 384` rather than climbing to the top. **[inferred]**
- **Contact friction is a Coulomb impulse, not a percentage.** `reflectVelocity` used to
  scale the ball's ENTIRE tangential velocity by `1 - friction` every time it ran, and
  its guard against doing that off-impact never fired, because `stepBalls` adds gravity
  before every integration so a resting ball is "approaching" its surface on every tick.
  The result was a viscous damper: a ball on a slope reached a terminal crawl of
  `g*sin(t)*(1-f)/f`, about `135*sin(t)` Q10/tick - 0.001 to 0.036 px/tick - and stayed
  there. Traced on the shipped maps, balls the ball search retired were not wedged at
  all: at Extreme Sports' `(247,144)` the ball advanced exactly 36 Q10 on each of the 500
  ticks the search counted, and at Law 'n Justice's `(40,122)` exactly 1. The search asks
  for 8 px in 500 ticks, i.e. 16.4 Q10/tick, so anything shallower than about seven
  degrees could never clear it. The tangential loss is now `min(|v_t|, friction x normal
  impulse)`, which for a resting contact is one tick of gravity, so a ball accelerates
  down any slope steeper than `atan(friction)` and is held on anything shallower - the
  static-friction condition. Measured over 60 games a table with a player flipping and
  nudging, write-offs went 22.8% -> 31.1% (Law 'n Justice), 0.6% -> 1.4% (BabeWatch) and
  82.6% -> 2.7% (Extreme Sports). After the map reframe, the re-derived gates, the
  `crown-mouth` column and a census player that plays (below), the same census reads
  **0%, 0% and 0%** — 90/90 drains on every table, thirty games of three balls each.
  **[inferred]**
- **Eighteen of ninety census games were hanging, and nothing failed.** A game that never
  ended produced no drains and no write-offs, so it vanished from the ratio above instead
  of failing anything: nine on Law 'n Justice, six on BabeWatch, three on Extreme Sports,
  every one of them a ball sitting back on the plunger rod after a plunge too weak to
  clear the arch, being re-plunged at exactly the same strength for twenty thousand
  ticks. The machine was behaving correctly — the lane floor is the rod, a failed plunge
  gives the ball back, and `ballBackOnTheRod` re-arms the plunger — but the scripted
  player modelled someone who watches a plunge fail and makes the identical plunge again,
  forever. Two changes to that player, both strictly more player-like: it **pulls harder**
  when the machine hands the ball back, and it **swings once per approach** instead of
  holding both buttons down (holding them down on a raised bat is not a flip, it is a
  cradle — measured on Extreme Sports at a starting pull of 50, the ball sat on the left
  bat at `(122,540)` for sixty thousand ticks). `tests/plays.test.ts` now asserts that
  every one of the ninety games reaches `game-over` having served all three balls, which
  was never asserted at all. **[inferred]**
- **~~The lower line is missing its left border on two tables.~~ RETRACTED, and the
  virtual left wall is deleted.** The claim rested on "bit 1 is solid at `x = 6..8` on
  every row from `y = 50` to `y = 390` on Extreme Sports", so nine columns was said to
  be the upper line's own border. On the corrected map that rail is at `x = 38..40`, and
  there is a second continuous bit-1 line at `x = 16..18` (set on every row of
  `y = 33..397`). Neither is inside `x = 0..8`: the constant named nothing. Nor did it
  do anything — the write-off census with the wall at 0, at 9 and at 19 is identical on
  all three tables, and no ball enters the strip at any setting. Where Extreme Sports'
  lower line draws a left border it draws it at `x = 0..3`, at the table edge. On Law 'n
  Justice and BabeWatch the lower-level region a served ball can reach does not touch
  the left of the table at all, so the knob was inert for them from the start.
  `tests/ball-physics.test.ts` keeps both halves of this as regression tests so the wall
  cannot come back by feel. **[disk]**
- **The one remaining stranding site is a post on Extreme Sports, and it is a device.**
  Law 'n Justice's top-left bowl used to be this entry, and it is gone with `arch-exit`
  (above). What is left is `(50,432)` on Extreme Sports: a ball balanced on the crown of
  something round. It was two write-offs in seventy-five balls; with the census player
  swinging once per approach rather than cradling, it is currently **zero in ninety** —
  the site is still there in the geometry and a ball placed on it still balances, but
  nothing now puts a ball there. Free
  lower-line centres there are `[20-20] [28-76]` at `y = 432` and `[30-46] [54-74]` one
  row down, so the ball is resting on top of a post with nothing beneath it. A real
  machine's coil clears one — and the machine now does exactly that: the ball search
  fires the measured slingshot coil at a still ball up to `BALL_SEARCH_PULSES` times
  before it writes it off, alternating direction, which is the half of the mechanism
  this reconstruction had always described and never built. With that, with the
  surface-ID map driving the physics and with the engine's own level hand-offs applied,
  the ninety-game aggressive census writes off **zero** balls on all three tables and
  completes 90 of 90 games on each, against 9.0% / 2.0% / 1.1% before. **[closed]**
- **All three shooter lanes are measured, and they are not identical.** Free ball
  centres are `x = 321..324` on Law 'n Justice, `321..323` on BabeWatch and `322..324` on
  Extreme Sports, with lane walls at `310..312 / 333..335`, `310..312 / 332..335` and
  `310..313 / 333..335`. The floor is on row `561` on all three, which is the strongest
  single piece of evidence that the lane is one shared cabinet part. The other two lanes
  used to be Law 'n Justice's marked `assumed`; the assumption was a pixel out on
  Extreme Sports. **[disk]**
- **A shove does not reach a ball on level 1.** The measured consequence of letting it:
  a ball coasting the arch carries about 48 Q10 per tick and the nudge impulse is 2048,
  so one shove replaced the shot rather than perturbing it — the ball crossed the (then
  fabricated) arch exit row at `v = (-1406,1364)` instead of `v = (-61,35)`, cleared the
  funnel entirely and wedged in the spiral. Shoving the other way drove it
  back up the arch so it never finished the shot at all. A habitrail is a tube; the
  flattening to two dimensions is what gave the ball sideways room it does not have.
  **[inferred]**
- **The ball search watches a box, not a pixel.** Comparing the whole-pixel position
  against the previous tick's made the search defeatable by any disturbance more
  frequent than its own window: with a nudge every 700 ticks a ball wedged at `(86,155)`
  is shoved at most seven pixels and re-settles about 200 ticks later, so its clock
  reached exactly 493 of the 500 it needs and was reset, over and over, for eighteen
  thousand consecutive ticks — `ballsServed` stalled on ball one and the game could not
  end. Nudging every 400 ticks held it under 70. The clock now runs while every live
  ball stays inside a box one ball radius across, held for the whole window. Measured on
  thirty games: wedged balls never leave that box, and the longest a legitimately moving
  ball stays inside one is 208 ticks on the arch crawl and 205 anywhere else.
  **[inferred]**
- Which *odd* index carries which wall behaviour (plain wall, rubber, slingshot,
  ramp edge, gate, hole). **[open]**

## Per-table behaviour

This section used to be entirely **[src]**. It is now partly measured. The mode
inventories, the award values and the strings are in
[`RULES_SPEC.md`](RULES_SPEC.md) §4–§6; only the parity-relevant summary is here.

Shared and now settled **[disk]**: scores are 6-byte packed BCD (12 digits);
end-of-ball bonus = `BONUS × multiplier` and **tilting forfeits it entirely**; the combo
bonus is **1,000,000 per combo on all three tables**; the bonus multiplier ladder is
`X2/X4/X6/X8/X10` on Law 'n Justice and BabeWatch but only `X2/X3/X4/X5` on Extreme
Sports.

**The big remaining gap, stated plainly:** 337 award records with exact values were
recovered, but **nothing connects an award record to a trigger** — not to a material
index, a lamp, a switch or a coordinate. The values cannot be wired in until that link
exists. `RULES_SPEC.md` §9 recommends breakpointing the engine's three award primitives
under emulation as the cheapest way to get it.

### Law 'n Justice

- **17 scoring missions — REFUTED.** The mission dispatch is **8 entries** (data
  `0x3112`, stride 12, op `0x0009`), all eight matched to their on-screen announce text
  by a 7/7 byte-identical-template match plus a 1/1 reverse-pointer lookup. There is no
  17-entry structure anywhere in any of the three table modules; Law 'n Justice's only
  near-miss is a 16-entry mode-object array whose preceding NULL is the award array's
  terminator. Themes: riot control, bomb defusal, hostage rescue, drug bust, prisoner
  return, arson, hover chase, street clear-out. **[disk]**
- Police chases, jailbreaks and hostage situations. **CONFIRMED** **[disk]**
- Locking balls feeds multiball — 4-step ladder `1..4 MORE FOR M-BALL`. **CONFIRMED,
  DECODED AND IMPLEMENTED** — tiers of 2/3/4/5 jail locks, multiball at ladder ids
  2/5/9/14 (2-ball twice, then 3-ball), wrap 5, gated on the jail lamp the SHOOT
  JAIL targets light; see "Defining feature: multiball". **[disk]**. Locking
  *criminals* also feeding it is **[open]**.
- **A sub-game played on the score panel — REFUTED for this table.** No such strings
  exist in Law 'n Justice. The claim is true of **BabeWatch** (the jukebox), so the
  source appears to have attributed it to the wrong table. **[disk]**
- Ramps and transport channels; upper-level ramp shots noted as difficult. **[src]**,
  corroborated independently by the collision maps above.
- No stopper post between the flippers, and side drains that are easy to hit — a
  layout characteristic, not a bug, and parity means reproducing it. **[src]**
- 123 award records recovered with exact values, including a 15M→50M ladder in 5M steps
  and eight 100,000,000 awards. **[disk]** — but see the trigger gap above.
- Jackpot values, mission timers, what advances each mission. **[open]**

### BabeWatch

- **Five modes, named: GYM, SURF, BURGER, CASINO, BABE HUNT** — one contiguous block of
  message records at data `0x40D0`, splitting 3 + 2 by font index, with BURGER and
  CASINO the two gated behind 3 and 4 ball locks. **[disk]**
- Casino and gym venues; a race. **CONFIRMED** — `THE CASINO IS OPEN`/`IS CLOSED`,
  `GYM MODE ENABLED`, `RACE ENABLED` with a 5-step gear ladder `2ND`–`6TH GEAR`.
  **[disk]**
- A chat-up sequence driven by hitting targets — `BABE HUNT` exists as a mode with a
  5-record award group; the target-driven mechanic is **[open]**.
- Multiple independent routes to raise the bonus multiplier. **CONFIRMED** — the
  `X2..X10` ladder plus an independent `MILLIONS ENABLED` / `ALL WHITE TARGETS` /
  `ENABLED FOR 1 MILLION` route. **[disk]**
- Multiplier lanes near the top of the playfield. **[open]** — position not established.
- A music-selection feature. **CONFIRMED** — `PICK A SONG`, `JUKEBOX`,
  `CHOOSE LEFT RIGHT`, `SELECT WITH RETURN`, three titles. This is also the score-panel
  sub-game. **[disk]**
- Ball-lock ladder award values: **5M/100k · 10M/250k · 15M/500k · 20M/1M · 25M/5M** —
  the cleanest object in the excavation, a 1:2:3:4:5 score progression. **[disk]**
- Mode entry conditions for the four lock multiballs are **DECODED AND
  IMPLEMENTED**: the per-game lock ladder (tiers of 1/2/3/4 counted locks →
  SHOW YOUR MUSCLES 2-ball / SURF THEM WAVES 3-ball / HAVE A BURGER DUDE 2-ball
  / MONEY HUNT 3-ball, wrap 10), with the selectable jackpot missions arming
  each tier via `SET_COUNT` 0/1/3/6 and relighting the lock lamps. **[disk]**
  Other mode timers and jackpot rules stay **[open]**.

### Extreme Sports

- Free-fall, bungee, cliff-diving and off-piste modes. **CONFIRMED** — all four present
  by name, with 15 mode objects total. **[disk]**
- Distinctive bonus rule: the bonus counts **up** while its timer counts **down**.
  **MECHANISM CONFIRMED** — engine `0x6334` services add-direction and subtract-direction
  BCD ramps from one list on one tick, selected by bit 0 of object`+0x01`, so an
  up-ramping bonus and a down-ramping timer are literally the same loop on the same
  frame. **Which ramp object is the bonus is [open].** **[disk]**
- An "Iron Man" mode described as a **four-ball** multiball. **REFUTED as literally
  four balls.** The engine's ball array is three objects long and the multiball opcode
  refuses any count above three outright (see "Defining feature: multiball"), so
  whatever Iron Man is, this engine cannot put four balls on the playfield. No literal
  4 is used as a ball count anywhere either — settled twice over now: every
  `BALLS_UP_TO` operand in Extreme Sports' 324 exported scripts is 3, and the raw
  `seg04` byte scan (`00 1B 00 xx`) contains no operand 4 — the mode object is
  referenced by exactly four award records, and that is an inference from record
  counts rather than a decoded constant. The table's own menu blurb says "Iron Man
  **Races**". What the mode actually does remains **[open]**.
- Extreme Sports carries **no lock or multiball string at all** in `Table003.seg04` —
  60 printable strings, none matching lock/multi/ball N/kick/saucer/hole — yet its zone
  list has **two type-4 capture devices**, one per level, at (249,159)-(269,179) on
  level 0 and (65,10)-(105,50) on level 1, both awarding 250,000. So the devices are
  there and the wording is not. **[disk]** Its lock capture scripts (36/37) are now
  read: they `AWARD` a batch of gated elements — including effect-**17** records
  whose `+$34` points straight at an event record (the shape that would
  `MODE_START` Iron Man and EXTREMIST) — and always `PUSH` the ball back out. The
  effect-17 handler is **not decoded**, so in this port an ES lock is a scoring
  eject and no lock multiball is reconstructed in its place. **[open]**
- Named awards: **`GET THE SUPER` / `IRON MAN JACKPOT` confirmed**; **no "Maniac Skier"
  string exists** — the nearest are the four ski-trick names `SPLIT`, `DUFFY`, `KOSAK`,
  `LOOP` and `GO OFF PISTE MANIA FOR` / `WHITE POWDER JACKPOT`. **[disk]**
- Combo scoring from ramp shots in quick succession. **[open]** — the combo bonus
  constant is known (1,000,000 each) but no combo *window* was found.
- ~~Defaults to twice the nudge tolerance of the other tables.~~ **CORRECTED.** Its tilt
  sensitivity is 100, identical to the others. What differs is option record 6: **10
  seconds of ball-save grace instead of 5**. **[disk]**
- Its bonus multiplier caps at **×5**, where the other two reach **×10**. **[disk]**
- 98 award records recovered, the richest set of the three, including a 6-step
  5M→50M ramp ladder and six 25,000,000/1,000,000 `EXTREMIST` awards. **[disk]**
- Rates, ceilings, combo windows. **[open]**

## Known original defects

Parity means deciding about these deliberately rather than by accident:

- Graphical glitches during multiball, reported as worst on BabeWatch. **[src]**
- Inconsistent flipper response — the ball sometimes leaving at an unexpected
  angle. **[src]** — and there is now a mechanism to point at. The measured impulse
  (see *The flipper IMPULSE* above) fires along the contact normal with a fixed `8/M`
  slice of drag along the bat's face, where `M` is the pivot distance at three quarters
  scale. That deflection is `atan(8/13) ≈ 32°` at the boss and `atan(8/34) ≈ 13°` at the
  tip, so where on the bat a ball is caught swings the shot by twenty degrees — and the
  contact normal itself is quantised to one of eight octants for the gate. Whether the
  reported complaint is this or something else is **[open]**, but it is no longer a
  behaviour without a candidate cause.

Both are candidates for a "faithful / fixed" toggle rather than silent correction.

## The drawn bat and the colliding bat were two different objects (2026-08)

The fourth play-test report read, verbatim: *"still missing flippers on the first board,
flippers look good on the 2nd 2 boards but dont work correctly, ball goes through them when
flipping."* The second half is closed here. The first half could not be reproduced and is
recorded as open at the bottom of this section.

**What was wrong.** The sprite round made the DRAWING truthful — the bats are the disk's own
pose bank, blitted at the record's pivot — while proving the SIMULATION byte-identical. That
was reported as a success and was in fact the defect: the drawn bat moved onto the disk's
real geometry and the colliding bat stayed on the reconstruction's inferred approximation.
They became two objects. Three errors, in rising order of size:

1. **Pivot row.** The records put every lower pivot on row 556; the simulation collided on
   an inferred 558, from the free ball-centre span on the map. Two rows, and one table's
   column was out too: Law 'n Justice's left pivot is 86 against the inferred 84.
2. **Rest bearing.** The records rest at pose 10 / pose 50 — exactly 30° below horizontal.
   The simulation rested at a chosen 152 of 2048, 26.72°. 3.28° of error.
3. **The bat's own thickness, which nobody had flagged.** `FLIPPER_BOSS_RADIUS_PIXELS = 5`
   was documented as "the largest inscribed disc. Measured." It is not. Rasterising the
   shipped pose bank gives the profile outright: the blade is **15 px across at the boss,
   8 px from the pivot's axis**, holding to along 6 and then stepping down to 4 px at along
   44, with 46 px of drawn blade and a further 8 px of hub behind the pivot. The constant
   came in at the initial commit, long before `flipdat1.bin` was decoded, and was never
   revised.

**What it did.** Measured over the drawn pixels of all 64 shipped poses, forward of the
pivot: **9,980 of 32,154 — 31.0% of the bat the player can see — had no collision behind
them.** Against the filmed original's own pixels the collision face sat a mean **4.83 px**
(max 9) BELOW the face being drawn, at every point of every stroke, on all six lower bats.
A ball resting on the flipper the player could see was above anything that could stop it.
The direct measurement: put a ball touching the outer face of the drawn bat at eleven points
along each of the nine bats, sweep the bat from rest, and ask whether the physics registers
anything — **67 of 99 sample points registered NO CONTACT AT ALL**, including all eleven on
BabeWatch's and Extreme Sports' upper bats. That is the operator's "ball goes through them",
and it is now **0 of 99**. `tests/flippers.test.ts` asserts it.

**The safeguard that did not fire.** A test asserted that the inferred pivots and the disk's
agreed *to within two pixels*. They did. Two pixels of PIVOT agreement says nothing about
FACE agreement, and two pixels is enough for a ball to fall through a flipper. It has been
replaced by an assertion that there is only one source: `FLIPPER_RECORDS` against the
shipped `flipper-bats.json`, field for field, by equality, with no tolerance anywhere; plus
"every drawn pixel of every pose is inside the collision capsule"; plus the drawn-face
contact test above. `movingSpritePlacements` now blits each pose against the SIMULATION's
pivot rather than the record's, so the picture is hung on whatever the physics collides
with, by construction.

**What the film says, because it outranks both.** Blitting each shipped rest pose at the
record's pivot and counting pixels that disagree with the filmed AGA original leaves 0, 8,
10, 0, 0 and 0 disagreements on the six lower bats and ZERO sprite-only pixels; at the
inferred pivot the same count is 176–270. A ±4 px sweep of the pivot bottoms out at exactly
(0,0) on all six. Sweeping the rest bearing, 30° leaves 0 sprite-only pixels and 27° leaves
51. **[disk]/[film]**

**The collision body, and what it is not.** boss 8, tip 4, taper start 6, axis length 44,
with the round cap carrying the last two drawn columns — 31,909 of 32,154 drawn pixels
(99.24%) inside the capsule, worst excursion 1.44 px. The residue is the hand-drawn poses'
own wander: each of the 64 was drawn separately and their perpendicular centres range over
−1.57..+1.49 rather than sitting at a constant offset, so no single capsule fits all of them
exactly. The 8 px hub BEHIND the pivot is deliberately not part of the blade — the original
draws it over the end of the inlane guide rail — and `touchAt`'s clamp of `along` to 0 is
what keeps it out. The one place the body still overlaps painted geometry is Extreme Sports'
upper bat, 9 pixels at (181–184, 201–203), because the original draws that bat over its own
ramp scenery; the six lower bats overlap at most ONE pixel each, the guide tip exactly
`bossRadius` from the pivot. All of it is pinned to the pixel by test.

**What legitimately moved.** Every impulse: `flipperImpulseRadius` indexes the original's
64×64 table with whole pixels from the pivot, so moving the pivot two rows changes `dy` for
every contact, and the wider boss moves the nearest possible contact from 13 px to 16. The
census below is re-run against it.

**NOT REPRODUCED: "missing flippers on the first board".** "The first board" is Law 'n
Justice (`TABLE_IDS[0]`, `SHELL_TABLES[0]`, guarded at module load). Three independent
read-only investigations failed to make any bat fail to draw: two headless through
`renderGame()` with a software `OffscreenCanvas` — attract, table-loaded, every tick of the
serve, ball in play, flippers held, the bottom stop, the film's own window row, multiball
reframe, tilt, game-over and table revisits — and one driving the shipped page in a real
Chrome with real key events, real `requestAnimationFrame` and the player's own route through
the menus, for 40 s on each table plus a revisit to the first: **1,524 canvas samples, zero
fallback markers, zero blank bat boxes**, and Law 'n Justice's lower bats measured 4,708
device pixels of sprite-layer contribution against BabeWatch's 4,696. Its bats are on screen
89.1% of ticks, MORE than either other table's. The property is now pinned anyway
(`tests/moving-sprites.test.ts`, "the bats a player actually sees"): all three bats draw, at
the pixel the original draws them, in every state a real game passes through on all three
tables. The two candidate readings that remain are (a) the operator means the behaviour —
Law 'n Justice's left bat was the only bat in the game 2 px out in BOTH axes, so its
flippers really did do the least — or (b) a stopped clock, which is the one condition that
leaves a player looking at a flipper-less table indefinitely: the camera resets to the TOP
of the playfield at `startGame` (the filmed serve snap) and HOLDS there while nothing ticks,
and a backgrounded tab runs no `requestAnimationFrame`. **[open]**

## Census baseline — at the measured flipper, camera and tilt (2026-08)

The first full census after the invented flipper/camera/tilt were replaced by the
measured models, and the current baseline for every future comparison. **Every
figure below is at the 40,000-tick budget** (`scripts/aggressive-census.mts`,
90 games/table, plunge holds 8..97, bat cadences 17..30, nudge every 700 ticks)
unless it says otherwise; a rate is only comparable against another rate at the
same budget.

- **Completions: 90/90 on all three tables, zero stalls.** A separate whole-game
  probe at the same budget with a nudge every 400 ticks completed 270/270.
  **Re-measured after the decoded lock ladder landed: still 90/90 on all three,
  write-offs still 0.0% / 0.0% / 0.0%** (LnJ 270 ends, BW 277, ES 270 — all real
  drains, same 40,000-tick budget). **[measured]**
- **Write-offs: 0.0% / 0.0% / 0.0%** (Law 'n Justice 288 ends, BabeWatch 270,
  Extreme Sports 279 — all real drains). The census as first run read BW at 0.4%:
  one deterministic strand at `(220,289)` level 0, hold 25 / cadence 20 — a
  replacement ball settling in the physical bottom of the `lower-bowl` saucer
  while the saucer held ball 1, refused by capture (the engine's own
  occupied-means-ignore at `0x5536`) and unreachable by gravity, ramp drive or the
  slingshot pulses (kicked 30 px out, rolled straight back, twice). Fixed in
  `runBallSearch`: a still ball inside an occupied saucer is swallowed to the
  trough as an owed serve — the decoded `$68` semantics, saucer balls leave via
  the trough and return from the plunger lane — instead of being pulsed and
  written off. After the fix the same census slice reads 0.0% with LnJ/ES
  figures unchanged to the ball. **[measured]**
- **Determinism holds:** hold-40 games run twice per table give byte-identical
  tick-state digest chains and scores (measured again after the decoded lock
  ladder landed: LnJ `4267ffb2` / 1,265,000; BW `7f805169` / 265,000; ES
  `72d524d7` / 205,000 — digests from the ladder-census harness, not comparable
  to the pre-ladder hash values; the identity of the two runs is the claim).
- **Missions and multiball at the measured energies, WITH THE DECODED LADDER
  (re-measured 2026-08 at the same 40,000-tick budget, 90 games/table, holds
  8..97).** Missions started LnJ 50, ES 37, BW 7; locks LnJ 126, BW 10, ES 36;
  multiball starts **BW 6 (in 6/90 games), LnJ 0, ES 0**; max simultaneous
  balls BW 2 (its first-tier multiball IS two-ball), LnJ/ES 1. Three shifts
  against the pre-ladder baseline, each with its reason: **BabeWatch went 0 → 6
  multiballs**, because the decoded rule is its first counted lock — the
  headline defect of the previous census is closed by the decode, not by
  tuning. **Law 'n Justice went 19 → 0**, and that is measured-beats-
  reconstructed working as intended: the old 19 were counterfeit ("any two
  saucers held"), while the decoded rule needs the SHOOT JAIL targets to light
  the jail lamp and then two captures of the jail saucer — the one lock
  rectangle the census player has never reached at the measured flipper
  energies (0 entries in the 30-game reachability census). A player who can
  shoot the jail gets the decoded 2-ball mode; the census player cannot, and
  parity means keeping the rule, not the count. **LnJ missions went 87 → 50**
  because lighting the jail lamp no longer hijacks the invented mission
  selector (element 26 is now the decoded multiball lamp, not a mode-arm shot —
  see `armElements` in table-modes.ts); ES missions went 29 → 37 as its
  effect-6 count ladders now queue their launcher scripts. **[measured]**
- **Scores (mean / median / max):** LnJ 1,673,000 / 860,000 / 15,545,000;
  BW 330,722 / 265,000 / 2,690,000; ES 609,167 / 380,000 / 9,810,000. The
  previously quoted 20.9M/11.4M/11.3M came from an unrecorded harness and is
  **not budget-comparable**; at this budget LnJ leads by ~3× as before, but ES
  now outscores BW (their old gap was 1%, within noise).
- **The four-ball question is settled — no.** No shipped script asks for more
  than three and the engine could not grant it; full derivation under "Defining
  feature: multiball". `Iron Man`, whatever it is, is not four live balls.
- **Tilt under the shipped rule** (record 3 per key PRESS, decay 4/tick, trips
  at 200): two nudges can never tilt (196 max), a third inside about half a
  second does (measured 100/160/220 at 10-tick spacing, identical on all three
  tables). At census cadences — one nudge per 700 or 400 ticks — the table
  tilted 0 times in 540 games, so census play is tilt-neutral.

## Census after the geometry was unified (2026-08)

**Budget, stated with the figures because a rate is only comparable against another rate at
the same budget:** `scripts/aggressive-census.mts`, **40,000 ticks a game, 90 games a table,
3 balls a game, 270 ball ends a table**, plunge holds 8..97, both bats tapped for 3 ticks on
a cycling 17..30 tick cadence, nudge left every 700 ticks. Both columns are the same
instrument, run back to back on the same machine: `921151b` in a pristine worktree against
the same commit with only the flipper geometry changed.

| | HEAD `921151b` | one geometry | why |
|---|---|---|---|
| **Law 'n Justice** completed | 90/90 | 90/90 | — |
| write-offs | 0 of 270 (0.0%) | 0 of 270 (0.0%) | all 270 ends are real drains both sides |
| score median | 365,000 | **487,500** | +33.6% |
| score max | 3,050,000 | 3,245,000 | +6.4% |
| ball-1 median | 47,500 | **100,000** | +110% |
| zero-score games | 4/90 | 4/90 | — |
| **BabeWatch** completed | 90/90 | 90/90 | — |
| write-offs | 0.0% | 0.0% | — |
| score median | 155,000 | **190,000** | +22.6% |
| score max | 1,722,340 | **2,585,000** | +50.1% |
| distinct scores | 42 | 58 | more of the table is being reached |
| **Extreme Sports** completed | 90/90 | 90/90 | — |
| write-offs | 0.0% | 0.0% | — |
| score median | 162,500 | **242,500** | +49.2% |
| score max | 7,455,000 | 4,220,000 | −43.4%, one lucky game lost |
| distinct scores | 48 | 63 | — |

**The medians rise on all three tables and that is the expected direction, not a
regression.** The census player taps the bats on a fixed cadence; before the change, one
approach in three arrived at a bat whose collision face was 4.83 px below the face being
drawn and took no impulse at all. The same player now connects, so the ball stays in play
longer and reaches more of the table — Law 'n Justice's ball-1 median doubles, and the
distinct-score count rises on the two tables where it had been narrow. Extreme Sports' max
falls because its old 7.46M was a single outlier game; its median rises by half.

**Nothing moved that should not have.** 90/90 completions and 0.0% write-offs on all three
tables, both sides, all 810 ball-ends real drains. The drain mouth barely moved: the
tip-to-tip separation at rest goes 34.6 px to 35.1.

**The picture did not move at all.** The film comparison re-run on the same three windows
(playfield rows 370–597, columns 0–326, at 2x, 894,672 pixels) gives **99.15% agreement,
byte-identical to `921151b`**: Law 'n Justice 98.45%, BabeWatch 99.86%, Extreme Sports
99.13%, with 0 of 298,224 pixels differing between the two renders on every table. That is
the expected result and it is the point — the drawn bat was already on the record's pivot;
this change moved the SIMULATION onto it. Differing pixels inside the bat boxes: 4, 0, 8, 0,
24 and 8 of 6,144 each, so the bats remain absent from the difference list.

## How the open items get closed

In rough dependency order.

Four of the original five are now **closed**: the `Table00N.bin` container structure
(`TSL!` solved), the per-table collision/material map (recovered, decoded, shipped), the
option semantics (all seven records, `RULES_SPEC.md` §3), and the multiball camera
switch (it is option record 7).

Item 1 as previously written — "read the `.mnu` menu definitions, closes the option
labels" — is **answered NO**. All three `.mnu` files are decompressed; they hold the
table-select artwork, the table name, a two-line blurb and `Press ESC to exit.`, and no
option label text exists anywhere in the release. The option *semantics* were closed a
different way, from the consuming code.

What remains:

1. **Link award records to triggers.** The single biggest gap: 337 award records with
   exact values and no keys. Nothing maps an award index to a material index, a lamp or a
   switch. Do **not** adopt the "material = index + 32" annotation that appears in one
   prior report — it is unsupported (`RULES_SPEC.md` §7).
2. **Recover the wall-behaviour constants** — closes which odd material index is rubber,
   slingshot, plain wall or ramp edge. Note that the slot-4 modules turned out to contain
   almost no code, so this is an engine question, not a per-table one.
2a. **The lock-ladder residues** (the dispatch itself is closed — award effect 6):
   trace award effect **17** (Extreme Sports' lock-fed multiball goes through it —
   its handler is entry 17 of the dispatch table at `0x5D0E`); locate the site that
   lights the lock lamps at game start and whatever resets the per-game ladder
   counters (both are candidates for the per-table NATIVE init through opcode 20's
   handler `0x5E00`, which jumps into slot-6 code that has not been disassembled);
   and export the per-device eject vectors at device `+$06..$0D` so a `PUSH` eject
   can kick the ball out of the saucer in place instead of routing it through the
   trough.
3. **Observe the original under emulation**, and instrument it. Breakpointing
   `main.seg00` `0x6BCC` / `0x6BEE` / `0x6B96` and logging `a3` on every call yields
   (award record → game event) pairs directly, which is exactly item 1. This is now the
   recommended route for everything still open: mode timers, combo windows, hurry-up
   rates, ball counts per mode, and whether the panel appends zeros to stored award
   digits. **Static analysis has reached its practical limit for the rules.**
4. **Find the loader** that writes `$2352`–`$236E` — it is not in `main.seg00` and no
   other `main.segNN` contains code.
5. Fill both documents in, replacing **[open]** with **[disk]** or an observation
   reference, before the corresponding rules are written.

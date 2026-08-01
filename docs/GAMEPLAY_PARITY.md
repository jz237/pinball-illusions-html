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
  and three-ball multiballs are both expressible; which one a given table asks for is
  per-table script data and is still **[open]**. A locked ball is released by opcode
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
  script data and the script streams have not been located. **[open]**
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

**Implemented**, in `src/game/ball-locks.ts` and the lock section of
`src/browser/game-loop.ts`. The ten decoded capture rectangles, capture, freeze,
release-to-serve-queue, the three-ball ceiling and the top-up are all as above. Two
things are **reconstruction and are labelled as such in the code**: that two balls
locked lights multiball (BabeWatch's own string `LOCK 2 BALLS 4 M-BALL`, and the only
value that fills the three-ball ceiling without exceeding it), and that a capture
which leaves nothing rolling buys the player a replacement ball. Balls the machine
owes itself are auto-launched after half a second, because a player already flipping
two balls cannot also be winding a spring; a ball the *player* was given is never
auto-launched.

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
| 3 | **Camera follow divisor** — `divs.w` on (ball Y − camera Y − dead zone) | 1–7 | 5 | `$E88(a5)` | **was [open] — closed** |
| 4 | **Tilt sensitivity** — units added per nudge frame against a hard-coded threshold of 200 | 0–200 | 100 | `$E8A(a5)` | **was [open] — closed** |
| 5 | **Lateral lean** — sideways (X) acceleration bias | −3…+3 | 0 | `$E8C(a5)` | was "table slope" — it is the other axis |
| 6 | **Timed ball-save grace, in whole seconds** (× `GfxBase.VBlankFrequency` → a frame countdown) | 0–10 | 5 (**Extreme Sports 10**) | `$E8E(a5)` | **was "nudges before tilt" — refuted** |
| 7 | **View / screen mode**: 0 = always narrow, 1 = always wide, 2 = narrow, script may switch to wide | 0–2 | 2 | `$E90(a5)` | **was "max multiballs" — refuted** |

Consequences worth restating:

- **Nudge tolerance is record 4, and it is identical on all three tables (100).** Extreme
  Sports' "double tolerance" was record 6 — it gets **10 seconds of ball save, not 10
  nudges**. The claim under *Extreme Sports* below is corrected accordingly.
- **Players are not an option.** They are chosen with F1–F8 at start
  (`PRESS ENTER OR F1-F8 TO BEGIN PLAY`); the 8-entry player array at `$DC6(a5)` is never
  sourced from the `.opt`. Multiplayer is sequential, not simultaneous. **[src]/[disk]**
- **Record 7 is the option behind the in-game `F9 FOR LO-RES` / `F10 FOR HI-RES` keys**,
  and it is the multiball camera switch that this document has been calling **[src]**:
  wide shows ~462 of the 600 playfield rows, narrow ~230, exactly 2×. Which of the two
  the game calls "LO-RES" is still **[open]**.

**There is no options screen in this release and the option labels do not exist as text
anywhere in the shipped data** — established by exhaustive search, not merely unfound
(`RULES_SPEC.md` §3). The only menu descriptor in the program has three items: `Tables`,
`Exit`, `Info`. **Any option label in this reconstruction is the project's own invention
and must be documented as such.** The semantics are facts; the words are not. **[disk]**

## Physical layout

- Three flippers per table. **[src]**
- Bumpers, ball traps, ramps, multi-level playfields. **[src]**
- Vertically scrolling playfield in normal play; full-screen hi-res during multiball. **[src]**
- Nudge with a tilt penalty for overuse. **[src]**
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
  **[inferred]**
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
  machine's coil clears one; this reconstruction has no device layer. Budgeted rather
  than hidden — `tests/plays.test.ts` measures the rate and holds it at 5% on every
  table, down from 35% on Law 'n Justice. Slot 4's per-8x8 acceleration field and a
  device layer are the documented right answers. **[open]**
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
- Locking balls feeds multiball — 4-step ladder `1..4 MORE FOR M-BALL`. **CONFIRMED**
  **[disk]**. Locking *criminals* also feeding it is **[open]**.
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
- Mode entry conditions, timers, jackpot rules. **[open]**

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
  4 is used as a ball count anywhere either; the mode object is referenced by exactly
  four award records, and that is an inference from record counts rather than a decoded
  constant. The table's own menu blurb says "Iron Man **Races**". What the mode
  actually does remains **[open]**.
- Extreme Sports carries **no lock or multiball string at all** in `Table003.seg04` —
  60 printable strings, none matching lock/multi/ball N/kick/saucer/hole — yet its zone
  list has **two type-4 capture devices**, one per level, at (249,159)-(269,179) on
  level 0 and (65,10)-(105,50) on level 1, both awarding 250,000. So the devices are
  there and the wording is not. **[disk]**
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
  angle. **[src]**

Both are candidates for a "faithful / fixed" toggle rather than silent correction.

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

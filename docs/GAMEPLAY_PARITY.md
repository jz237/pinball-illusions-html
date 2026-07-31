# Gameplay parity spec — Pinball Illusions

The target behaviour this reimplementation is measured against. Every claim is tagged:

- **[disk]** — measured from the operator's own disks (see `DISK_ANALYSIS.md`)
- **[src]** — from published secondary sources (reviews, retrospectives, encyclopaedic entries)
- **[open]** — not yet established; must be observed before it is implemented

Secondary sources contradict each other on several points. Where they do, the disk
wins, and unresolved conflicts are recorded rather than papered over.

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

- Sources disagree on the ceiling: some say up to three balls, others up to six.
  The `.opt` record that plausibly caps simultaneous multiballs has maximum 2 with
  default 2, which is a count of *multiball events* rather than balls. **[open]**
- The display switches to a high-resolution full-screen mode while multiball is
  active so every ball stays visible; toggleable by the player. **[src]**
- Multiball is entered by locking balls, per table. **[open]**

Engineering consequence: the simulation must be N-ball from the start — ball list,
ball-to-ball collision, per-ball state, drain handling while others remain live, and
a camera policy that changes when ball count exceeds one. Retrofitting this later
would mean rewriting the physics core.

## Options

Seven per-table settings, defaults measured from `table00N.opt`. **[disk]**
Labels for records 3, 4 and 7 are inferred and are **[open]** until the `.mnu` menu
definitions are read.

| # | Setting | Range | Default | Confidence |
|---:|---|---|---:|---|
| 1 | Balls per game | 3–5 | 3 | measured; matches published description |
| 2 | Players | up to 8 | 4 | measured |
| 3 | *unidentified* | 0–7 | 5 | **[open]** |
| 4 | *percentage scalar* | 0–200 | 100 | **[open]** |
| 5 | Table slope | −3…+3 | 0 | measured; signed and centred |
| 6 | Nudges before tilt | 0–10 | 5 | measured — **Extreme Sports defaults to 10** |
| 7 | *max multiballs* | 0–2 | 2 | **[open]** |

Multiplayer is sequential, not simultaneous. **[src]**

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
- Law 'n Justice has an open top border: rows `y = 0..19` carry no bit-0 line, so a
  ball can drift above the top arch across the full width. This is a map property
  needing a **virtual wall at `y < 26`** (safe — connectivity stays intact; `y >= 30`
  breaks the plunger feed), not a physics bug. BabeWatch and Extreme Sports do not
  need it. **[disk]**
- Which *odd* index carries which wall behaviour (plain wall, rubber, slingshot,
  ramp edge, gate, hole). **[open]**

## Per-table behaviour

Everything below is from secondary sources and is indicative only — enough to know
what mechanisms must exist, not enough to implement scoring. Concrete values require
observation of the original.

### Law 'n Justice

- Reported as having 17 scoring missions built around police chases, jailbreaks and
  hostage situations. **[src]**
- Locking criminals and locking balls both feed multiball. **[src]**
- Ramps and transport channels; upper-level ramp shots noted as difficult. **[src]**
- A sub-game played on the score panel, aimed with the flippers. **[src]**
- No stopper post between the flippers, and side drains that are easy to hit — a
  layout characteristic, not a bug, and parity means reproducing it. **[src]**
- Mission list, scoring, jackpot values. **[open]**

### BabeWatch

- Venues include a casino and a gym; activities include a race and a
  chat-up sequence driven by hitting targets. **[src]**
- Multiple independent routes to raise the bonus multiplier. **[src]**
- Multiplier lanes sit near the top of the playfield. **[src]**
- A music-selection feature lets the player choose the table music. **[src]**
- Multiplier values, mode structure, scoring. **[open]**

### Extreme Sports

- Free-fall, bungee, cliff-diving and off-piste modes. **[src]**
- Distinctive bonus rule: the bonus counts **up** while its timer counts **down**, so
  collecting late is worth far more. This is a real mechanical difference from the
  other two tables and needs its own model. **[src]**
- An "Iron Man" mode described as a four-ball multiball with combo scoring from
  ramp shots in quick succession. **[src]**
- Named awards reported: a Maniac Skier jackpot and a Super Iron Man jackpot. **[src]**
- Defaults to twice the nudge tolerance of the other tables. **[disk]**
- Rates, ceilings, combo windows. **[open]**

## Known original defects

Parity means deciding about these deliberately rather than by accident:

- Graphical glitches during multiball, reported as worst on BabeWatch. **[src]**
- Inconsistent flipper response — the ball sometimes leaving at an unexpected
  angle. **[src]**

Both are candidates for a "faithful / fixed" toggle rather than silent correction.

## How the open items get closed

In rough dependency order:

Two of the original five are now **closed**: the `Table00N.bin` container structure
(the `TSL!` format is solved) and the per-table collision/material map (recovered,
decoded, shipped). What remains:

1. Read the `.mnu` menu definitions — closes the option labels.
2. Recover the wall-behaviour constants from the slot 4 per-table code — closes which
   odd material index is rubber, slingshot, plain wall or ramp edge.
3. Observe the original running, for timings, scoring, mode flow and the multiball
   camera switch.
4. Fill this document in, replacing **[open]** with **[disk]** or an observation
   reference, before the corresponding rules are written.

/**
 * THE INTRO'S GLUE, proven the way the touch deck's is: everything between
 * the shipped asset files and the first frame on the shell canvas.
 *
 * The Loading-logo round shipped a decoded, gated, manifest-claimed asset
 * that never appeared on screen because nobody tested the call path. This
 * file is that lesson applied to the intro, in four layers:
 *
 *  1. THE SHIPPED ASSETS validate against their own manifest: digests,
 *     stream boundaries re-walked byte for byte with the player's own opcode
 *     rules, fade tables in range, copper lists tiling their segment exactly.
 *  2. THE RIGHTS GATE knows the new class: `check-public-build.mjs` is run as
 *     a child process against a fixture build and must (a) refuse it without
 *     authorization, (b) pass it with, (c) REFUSE it again when a single byte
 *     of a shipped binary is flipped, when a claimed file is missing, and
 *     when an unclaimed `.bin` appears. The mandated tamper test, durable.
 *  3. THE PLAYER HANDLE advances on the fixed 50 Hz clock whatever the
 *     animation-frame rate, presents through the injected canvas surfaces,
 *     letterboxes 4:3 into portrait and landscape canvases, skips on demand
 *     exactly once, and hands off at the scripted exit.
 *  4. THE BOOT WIRING in `main.ts` — construction before the first frame,
 *     the fire-skip routes, the frame-loop branch, the door held back — is
 *     asserted against the shipped source the same way the dom-harness
 *     builds its fixture from the shipped `index.html`: renaming or removing
 *     the glue fails here rather than silently unhooking the show.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  INTRO_PREROLL_T,
  attachIntro,
  introFireKey,
  introManifestFrom,
  loadIntroAssets,
} from "../src/browser/intro.js";
import type { IntroAssets, IntroHost } from "../src/browser/intro.js";
import type { TableArtFetch } from "../src/game/table-art.js";

const INTRO_DIR = fileURLToPath(new URL("../public/generated/shell/intro/", import.meta.url));
const GUARD = fileURLToPath(new URL("../scripts/check-public-build.mjs", import.meta.url));
const MAIN_TS = fileURLToPath(new URL("../src/main.ts", import.meta.url));

const exported = existsSync(`${INTRO_DIR}intro.json`);

function loadShippedAssets(): IntroAssets {
  const manifest = introManifestFrom(
    JSON.parse(readFileSync(`${INTRO_DIR}intro.json`, "utf8")) as unknown,
  );
  return {
    manifest,
    data: new Uint8Array(readFileSync(`${INTRO_DIR}intro-data.bin`)),
    copper: new Uint8Array(readFileSync(`${INTRO_DIR}intro-copper.bin`)),
  };
}

// ---------------------------------------------------------------------------
// 1. The shipped assets against their manifest
// ---------------------------------------------------------------------------

describe.skipIf(!exported)("the shipped intro assets", () => {
  it("match the digests and sizes their manifest claims", () => {
    const { manifest } = loadShippedAssets();
    expect(manifest.data).toHaveLength(2);
    for (const entry of manifest.data) {
      const bytes = readFileSync(`${INTRO_DIR}${entry.file}`);
      expect(bytes.length, entry.file).toBe(entry.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex"), entry.file).toBe(entry.sha256);
    }
    expect(manifest.provenance?.sourceClass).toBe("disk-derived-intro");
    expect(manifest.provenance?.authorizationRequired).toBe(true);
  });

  it("carries the decoded script: 193 entries, 176 animation steps, the exit", () => {
    const { manifest } = loadShippedAssets();
    expect(manifest.script).toHaveLength(193);
    const first = manifest.script[0];
    expect(first).toEqual([1, manifest.ops.intEnable]);
    const last = manifest.script[manifest.script.length - 1];
    expect(last).toEqual([2892, manifest.ops.exit]);
    const anims = manifest.script.filter(([, op]) => op === manifest.ops.anim);
    expect(anims).toHaveLength(176);
  });

  it("streams re-walk boundary-exact under the three-opcode format", () => {
    const { manifest, data } = loadShippedAssets();
    // The player's own unpacker rules, applied as a walker: every stream must
    // end exactly where the next begins, and single-image streams must write
    // exactly their advertised byte count with no skips.
    const walk = (at: number): { end: number; written: number; skipped: number } => {
      let src = at;
      const groups = ((data[src] ?? 0) << 8 | (data[src + 1] ?? 0)) + 1;
      src += 2;
      let written = 0;
      let skipped = 0;
      for (let group = 0; group < groups; group += 1) {
        const control = data[src] ?? 0;
        src += 1;
        if (control === 0) {
          skipped += (data[src] ?? 0) << 8 | (data[src + 1] ?? 0);
          src += 2;
        } else if ((control & 0x80) !== 0) {
          const run = (control & 0x7f) + 1;
          src += run;
          written += run;
        } else {
          src += 1;
          written += control;
        }
      }
      expect(src).toBeLessThanOrEqual(data.length);
      return { end: src, written, skipped };
    };
    const streams = manifest.streams;
    for (let index = 0; index < streams.length; index += 1) {
      const stream = streams[index];
      if (stream === undefined) continue;
      const nextAt = index + 1 < streams.length ? (streams[index + 1]?.at ?? data.length) : data.length;
      if (stream.frames !== undefined) {
        let at = stream.at;
        for (let frame = 0; frame < stream.frames; frame += 1) at = walk(at).end;
        expect(at, stream.name).toBe(nextAt);
      } else {
        const result = walk(stream.at);
        expect(result.end, stream.name).toBe(nextAt);
        expect(result.written, stream.name).toBe(stream.unpackedBytes);
        expect(result.skipped, stream.name).toBe(0);
      }
    }
  });

  it("fade tables stay inside the palette block and the copper segment", () => {
    const { manifest, copper } = loadShippedAssets();
    expect(manifest.fades).toHaveLength(12);
    for (const table of manifest.fades) {
      expect(table.repeats).toBe(16);
      expect(table.quads.length).toBeGreaterThan(0);
      for (const [src, dst, step, count] of table.quads) {
        expect(step).toBe(4);
        expect(src + 2 * count).toBeLessThanOrEqual(manifest.paletteBlockEnd ?? 0x1c0);
        expect(dst + step * count).toBeLessThanOrEqual(copper.length);
      }
    }
  });

  it("the eight copper lists tile the copper segment exactly", () => {
    const { manifest, copper } = loadShippedAssets();
    expect(manifest.lists).toHaveLength(8);
    let expected = 0;
    for (const list of manifest.lists) {
      expect(list.at).toBe(expected);
      let at = list.at;
      for (;;) {
        expect(at + 4).toBeLessThanOrEqual(copper.length);
        const first = ((copper[at] ?? 0) << 8) | (copper[at + 1] ?? 0);
        const second = ((copper[at + 2] ?? 0) << 8) | (copper[at + 3] ?? 0);
        at += 4;
        if (first === 0xffff && second === 0xfffe) break;
      }
      expected = at;
    }
    expect(expected).toBe(copper.length);
  });

  it("loads through the fetch path, and refuses a truncated binary", async () => {
    const diskFetch: TableArtFetch = (url) => {
      const name = url.slice(url.lastIndexOf("/") + 1);
      const path = `${INTRO_DIR}${name}`;
      if (!existsSync(path)) {
        return Promise.resolve({
          ok: false,
          status: 404,
          statusText: "not on disk",
          arrayBuffer: () => Promise.reject(new Error("missing")),
        });
      }
      const bytes = readFileSync(path);
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: () =>
          Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
      });
    };
    const assets = await loadIntroAssets(diskFetch);
    expect(assets.data.length).toBe(assets.manifest.data[0]?.byteLength);
    expect(assets.copper.length).toBe(assets.manifest.data[1]?.byteLength);

    const truncating: TableArtFetch = async (url) => {
      const response = await diskFetch(url);
      if (!url.endsWith(".bin")) return response;
      return {
        ...response,
        arrayBuffer: async () => (await response.arrayBuffer()).slice(0, 100),
      };
    };
    await expect(loadIntroAssets(truncating)).rejects.toThrow(/bytes, manifest says/);
  });
});

// ---------------------------------------------------------------------------
// 2. The rights gate: authorization, claims, and the tamper test
// ---------------------------------------------------------------------------

const fixtures: string[] = [];

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function guardFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "intro-guard-"));
  fixtures.push(dir);
  cpSync(INTRO_DIR, join(dir, "generated", "shell", "intro"), { recursive: true });
  return dir;
}

function runGuard(dir: string, authorized: boolean): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [GUARD, dir], {
    encoding: "utf8",
    env: {
      ...process.env,
      PINBALL_ILLUSIONS_DERIVED_AUTHORIZED: authorized ? "1" : "",
    },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe.skipIf(!exported)("the rights gate over the intro class", () => {
  it("refuses the assets without authorization, passes them with it", () => {
    const dir = guardFixture();
    const refused = runGuard(dir, false);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain("disk-derived asset(s) present");
    expect(refused.output).toContain("intro animation");

    const passed = runGuard(dir, true);
    expect(passed.status).toBe(0);
    expect(passed.output).toContain("authorized derived asset(s)");
  });

  it("REFUSES the build when one byte of a shipped binary is flipped", () => {
    const dir = guardFixture();
    const target = join(dir, "generated", "shell", "intro", "intro-data.bin");
    const bytes = readFileSync(target);
    bytes[100_000] = (bytes[100_000] ?? 0) ^ 0x01;
    writeFileSync(target, bytes);
    const result = runGuard(dir, true);
    expect(result.status).toBe(1);
    expect(result.output).toContain("does not match");
  });

  it("refuses a manifest whose claimed binary is missing", () => {
    const dir = guardFixture();
    rmSync(join(dir, "generated", "shell", "intro", "intro-copper.bin"));
    const result = runGuard(dir, true);
    expect(result.status).toBe(1);
    expect(result.output).toContain("not in the build");
  });

  it("refuses a stray .bin nothing claims — the scan covers binaries now", () => {
    const dir = guardFixture();
    writeFileSync(join(dir, "generated", "shell", "intro", "mystery.bin"), Buffer.from([1, 2, 3]));
    const result = runGuard(dir, true);
    expect(result.status).toBe(1);
    expect(result.output).toContain("media file with no manifest");
  });
});

// ---------------------------------------------------------------------------
// 3. The player handle over injected surfaces
// ---------------------------------------------------------------------------

interface DrawCall {
  readonly dx: number;
  readonly dy: number;
  readonly dw: number;
  readonly dh: number;
}

interface FakePresentation {
  host: IntroHost;
  readonly draws: DrawCall[];
  puts: number;
  doneCalls: number;
  canvas: { width: number; height: number };
}

function fakePresentation(width = 672, height = 512): FakePresentation {
  const record: FakePresentation = {
    host: null as unknown as IntroHost,
    draws: [],
    puts: 0,
    doneCalls: 0,
    canvas: { width, height },
  };
  const surfaceContext = {
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: () => {
      record.puts += 1;
    },
  };
  const targetContext = {
    fillStyle: "",
    imageSmoothingEnabled: false,
    fillRect: () => undefined,
    drawImage: (
      _surface: unknown,
      _sx: number,
      _sy: number,
      _sw: number,
      _sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ) => {
      record.draws.push({ dx, dy, dw, dh });
    },
  };
  record.host = {
    context: targetContext as unknown as CanvasRenderingContext2D,
    canvas: record.canvas as unknown as HTMLCanvasElement,
    surface: (w, h) =>
      ({ width: w, height: h, getContext: () => surfaceContext }) as unknown as HTMLCanvasElement,
    onDone: () => {
      record.doneCalls += 1;
    },
  };
  return record;
}

describe.skipIf(!exported)("the intro handle", () => {
  it("pre-rolls the loader-time lead-in so the show opens on the fade-in", () => {
    const p = fakePresentation();
    const handle = attachIntro(loadShippedAssets(), p.host);
    expect(handle.t()).toBe(INTRO_PREROLL_T);
    expect(handle.done()).toBe(false);
  });

  it("advances at 50 Hz whatever the animation-frame rate", () => {
    const p = fakePresentation();
    const handle = attachIntro(loadShippedAssets(), p.host, 0);
    handle.frame(0); // seeds the clock
    expect(handle.t()).toBe(0);
    // A 60 Hz second's worth of frames...
    for (let i = 1; i <= 60; i += 1) handle.frame(i * (1000 / 60));
    expect(handle.t()).toBe(50);
    // ...and a 144 Hz second lands on exactly the same count.
    for (let i = 1; i <= 144; i += 1) handle.frame(1000 + i * (1000 / 144));
    expect(handle.t()).toBe(100);
    // The picture was presented (letterboxed) on every frame, and the
    // offscreen was refreshed at most once per changed 50 Hz frame.
    expect(p.draws.length).toBe(60 + 144 + 1);
    expect(p.puts).toBeGreaterThan(0);
    expect(p.puts).toBeLessThanOrEqual(101);
  });

  it("letterboxes 4:3 into landscape and portrait canvases alike", () => {
    const landscape = fakePresentation(1008, 768);
    attachIntro(loadShippedAssets(), landscape.host).frame(0);
    // 1008x768 is 4:3 wanting 1024 wide: height-limited, 1024 -> 1008 wide
    // would overflow... min(1008/640, 768/480) = 1.575 -> 1008 x 756.
    expect(landscape.draws[0]).toEqual({ dx: 0, dy: 6, dw: 1008, dh: 756 });

    const portrait = fakePresentation(390, 297);
    attachIntro(loadShippedAssets(), portrait.host).frame(0);
    // A phone-shaped stage after fitCanvas: width-limited, 390 x 293, bars
    // above and below — the picture never distorts and never overflows.
    const draw = portrait.draws[0];
    expect(draw).toBeDefined();
    if (draw === undefined) return;
    expect(draw.dw).toBe(390);
    expect(draw.dh).toBe(Math.round(480 * (390 / 640)));
    expect(draw.dx).toBe(0);
    expect(draw.dy).toBe((297 - draw.dh) >> 1);
    expect(draw.dh).toBeLessThanOrEqual(297);
  });

  it("skips on demand: onDone exactly once, then inert", () => {
    const p = fakePresentation();
    const handle = attachIntro(loadShippedAssets(), p.host);
    handle.frame(0);
    handle.frame(20);
    expect(p.doneCalls).toBe(0);
    handle.skip();
    expect(handle.done()).toBe(true);
    expect(p.doneCalls).toBe(1);
    handle.skip();
    const drawsAfter = p.draws.length;
    handle.frame(40);
    expect(p.doneCalls).toBe(1);
    expect(p.draws.length).toBe(drawsAfter);
  });

  it("hands off by itself when the script exits", () => {
    const p = fakePresentation();
    // Pre-roll deep into the credits so the run to the exit stays cheap: the
    // whole show is 4446 frames and the pixel gate already walks all of them.
    const handle = attachIntro(loadShippedAssets(), p.host, 4400);
    handle.frame(0);
    let time = 0;
    let frames = 0;
    while (!handle.done() && frames < 200) {
      time += 100; // 5 ticks a frame, within the catch-up clamp
      handle.frame(time);
      frames += 1;
    }
    expect(handle.done()).toBe(true);
    expect(p.doneCalls).toBe(1);
    expect(handle.t()).toBe(4446);
  });

  it("pause holds the clock; resume does not bank the gap", () => {
    const p = fakePresentation();
    const handle = attachIntro(loadShippedAssets(), p.host, 0);
    handle.frame(0);
    for (let i = 1; i <= 5; i += 1) handle.frame(i * 20);
    expect(handle.t()).toBe(5);
    handle.pause();
    handle.resume();
    // Ten minutes pass while paused-and-resumed; the first frame back must
    // not fast-forward the show.
    handle.frame(600_000);
    expect(handle.t()).toBe(5);
    handle.frame(600_020);
    expect(handle.t()).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// The fire-input contract
// ---------------------------------------------------------------------------

describe("introFireKey", () => {
  it("counts the original's fire inputs: flippers, launch, Enter", () => {
    for (const code of ["ShiftLeft", "ShiftRight", "KeyZ", "Slash", "KeyA", "Semicolon", "Space", "ArrowDown", "Enter", "NumpadEnter"]) {
      expect(introFireKey({ code }), code).toBe(true);
    }
  });

  it("lets every non-fire key through: pause, nudge, mute, letters", () => {
    for (const code of ["Escape", "KeyP", "KeyX", "ArrowUp", "Backquote", "KeyQ", "F9"]) {
      expect(introFireKey({ code }), code).toBe(false);
    }
  });

  it("falls back to key names for events without codes", () => {
    expect(introFireKey({ key: " " })).toBe(true);
    expect(introFireKey({ key: "Enter" })).toBe(true);
    expect(introFireKey({ key: "p" })).toBe(false);
    expect(introFireKey({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. The boot wiring in main.ts, read from the shipped source
// ---------------------------------------------------------------------------

describe("the boot wiring", () => {
  const source = readFileSync(MAIN_TS, "utf8");

  it("constructs the intro before the first frame and lands on the door", () => {
    // The load is awaited inside boot() ahead of requestAnimationFrame, and
    // completion nulls the handle so the next frame paints the door.
    expect(source).toContain("await loadIntroAssets()");
    expect(source).toContain("intro = attachIntro(assets");
    expect(source).toContain("intro = null");
    // A ?table= deep link boots straight to its game, no show.
    expect(source).toMatch(/if \(bootTable === null\) \{\s*\n\s*try \{\s*\n\s*const assets = await loadIntroAssets/);
  });

  it("drives the player from the frame loop on the paused shell clock", () => {
    expect(source).toContain("intro?.frame(timeMs)");
    expect(source).toMatch(/if \(intro !== null\) \{\s*\n\s*if \(!shellClock\.paused\) shellClock\.pause\(\)/);
    // The door is not consulted while the intro owns the screen.
    expect(source).toContain("if (intro === null) door?.refresh(");
  });

  it("routes every fire input to skip: keys, pointer, gamepad", () => {
    expect(source).toContain("if (introFireKey(keyEvent)");
    expect(source).toMatch(/pointerdown[\s\S]{0,400}intro\.skip\(\)/);
    expect(source).toMatch(/pad\.buttons\.some[\s\S]{0,80}intro\.skip\(\)/);
  });

  it("pauses with the page and resumes without banking the absence", () => {
    expect(source).toMatch(/suspendPage[\s\S]{0,600}intro\?\.pause\(\)/);
    expect(source).toMatch(/resumePage[\s\S]{0,400}intro\?\.resume\(\)/);
  });
});

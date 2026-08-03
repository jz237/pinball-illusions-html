#!/usr/bin/env node
// Refuses a build that contains preservation media, Amiga executables, private
// filesystem paths, or credentials. Runs as the last step of `npm run build`.
//
// The original disks are the operator's own property and are read locally for
// analysis only. Nothing derived from them belongs in a shipped artifact; this
// script is the mechanical check that keeps that true even when someone forgets.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname, dirname } from "node:path";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

const root = process.argv[2];
if (!root || !existsSync(root)) {
  console.error(`guard:public — build directory not found: ${root ?? "(none)"}`);
  process.exit(1);
}

const FORBIDDEN_EXT = new Set([
  ".ipf", ".adf", ".dsk", ".rom", ".lha", ".lzx", ".mod", ".exe", ".slave", ".ilbm",
]);

// Leading bytes that identify preservation containers and Amiga binaries.
const FORBIDDEN_SIGNATURES = [
  { name: "CAPS/IPF disk image", bytes: [0x43, 0x41, 0x50, 0x53] },
  { name: "Amiga HUNK executable", bytes: [0x00, 0x00, 0x03, 0xf3] },
  { name: "PowerPacker payload", bytes: [0x50, 0x50, 0x32, 0x30] },
  { name: "LHA archive", bytes: [0x2d, 0x6c, 0x68] },
];

const FORBIDDEN_TEXT = [
  { name: "Windows drive path", re: /[A-Za-z]:\\{1,2}(Users|Projects)\\/ },
  { name: "UNC path", re: /\\\\[A-Za-z0-9_-]+\\[A-Za-z0-9_$-]+/ },
  { name: "file:// URL", re: /file:\/\/\// },
  { name: "preservation directory", re: /_pinball_research|PinballIllusions_Disk/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "fal API key", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{16,}\b/ },
  { name: "private key block", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const TEXT_EXT = new Set([
  ".js", ".mjs", ".cjs", ".css", ".html", ".json", ".map", ".svg", ".txt", ".webmanifest",
]);

// Raster images cannot carry provenance inside themselves, so every one of them
// has to be accounted for by a manifest. See the artwork block near the bottom.
const IMAGE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".tif", ".tiff",
]);

// Neither can a sound file, and a recording is a heavier rights question than a
// picture: these are the machine's own speech callouts. Same rule, same digests.
const AUDIO_EXT = new Set([".wav", ".ogg", ".mp3", ".flac", ".m4a", ".aac", ".opus"]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

const violations = [];

for await (const file of walk(root)) {
  const rel = relative(root, file);
  const ext = extname(file).toLowerCase();

  if (FORBIDDEN_EXT.has(ext)) {
    violations.push(`${rel}: forbidden extension ${ext}`);
    continue;
  }

  const { size } = await stat(file);
  if (size === 901120 || size === 1049612) {
    violations.push(`${rel}: size ${size} matches a raw Amiga disk image`);
  }

  const buf = await readFile(file);
  for (const sig of FORBIDDEN_SIGNATURES) {
    if (buf.length >= sig.bytes.length && sig.bytes.every((b, i) => buf[i] === b)) {
      violations.push(`${rel}: leading bytes identify ${sig.name}`);
    }
  }

  if (TEXT_EXT.has(ext)) {
    const text = buf.toString("utf8");
    for (const rule of FORBIDDEN_TEXT) {
      if (rule.re.test(text)) violations.push(`${rel}: contains ${rule.name}`);
    }
  }
}

// Disk-derived assets are permitted, but only deliberately. The maps are
// functional collision geometry and the artwork is the playfield picture, both
// decoded from the operator's own disks, and shipping either is an explicit
// decision rather than something that happens because a file was copied into
// public/.
//
// A JSON document declares its own class in a `sourceClass` field, so the maps
// and the art manifests are found by scanning text. A PNG cannot: there is
// nowhere in it to put a provenance block that this script could trust. So the
// artwork is gated through its manifest, and — because a gate you can walk
// around is not a gate — every raster image in the build must be claimed by a
// manifest and match the digest that manifest records. An image nobody claims is
// a violation whether or not the authorization variable is set: an unaccounted
// picture in a build derived from someone's disks is exactly the thing this
// script exists to stop.
const AUTHORIZATION_ENV = "PINBALL_ILLUSIONS_DERIVED_AUTHORIZED";
const DERIVED_MARKERS = [
  { class: "disk-derived-collision-geometry", noun: "collision map" },
  { class: "disk-derived-playfield-artwork", noun: "playfield artwork" },
  { class: "disk-derived-ramp-acceleration", noun: "ramp drive" },
  { class: "disk-derived-scoring-devices", noun: "device and award table" },
  { class: "disk-derived-mode-scripts", noun: "mission and mode bytecode" },
  { class: "disk-derived-lamp-overlays", noun: "lamp overlay" },
  // The two moving sprites. Both ship their pixels INSIDE the JSON — three
  // packed bitplanes a pose for the bats, 289 palette-index bytes for the ball —
  // so neither needs a MEDIA_MARKERS entry: there is no raster file beside them
  // for the "media file with no manifest" rule to catch. If either ever ships a
  // PNG atlas instead, it needs a MEDIA_MARKERS entry on the same class plus a
  // claim() branch naming the file and its sha256.
  { class: "disk-derived-flipper-sprites", noun: "flipper bat sprite" },
  { class: "disk-derived-ball-sprite", noun: "ball sprite" },
  { class: "disk-derived-panel-animations", noun: "score panel animation" },
  { class: "disk-derived-audio", noun: "sound effect" },
  { class: "disk-derived-shell-artwork", noun: "shell artwork" },
  // The LOADING logo: five bitplanes and a 32-colour copper palette, and the
  // only shell picture that does NOT live in menudata.bin — it is loaded before
  // any table package, so it ships as its own manifest plus one PNG through the
  // single-image branch rather than joining the shell-artwork images[] array.
  { class: "disk-derived-loading-logo", noun: "loading logo" },
  // The front-end module. It ships as a decoded document plus one WAV per live
  // instrument, each digest-claimed through the samples[] branch below — never
  // as a `.mod`, which FORBIDDEN_EXT still refuses and should go on refusing.
  { class: "disk-derived-shell-music", noun: "front-end music" },
  // The in-game modules: each table's own two SNT! banks, decoded the same
  // way and shipped the same way — a document per table plus digest-claimed
  // instrument WAVs, and never a `.mod`.
  { class: "disk-derived-table-music", noun: "in-game music" },
  // The HD (4x) presentation set. Every one of these is derived from assets
  // already in the classes above by a deterministic local upscale
  // (scripts/hd-pipeline.mjs), which changes NOTHING about custody: art
  // derived from the disk artwork is still disk-derived, so each ships behind
  // the same authorization gate, as a PNG claimed by its own manifest through
  // the single-image branch below. The flipper and ball sprites' native
  // classes ship pixels inside JSON; these HD variants are precisely the
  // "PNG atlas instead" case the comment above anticipates.
  { class: "disk-derived-playfield-artwork-hd", noun: "HD playfield artwork" },
  { class: "disk-derived-lamp-overlays-hd", noun: "HD lamp patch atlas" },
  { class: "disk-derived-ball-sprite-hd", noun: "HD ball sprite" },
  { class: "disk-derived-flipper-sprites-hd", noun: "HD flipper bat atlas" },
];

/** Manifest classes that must account for the binary files they ship beside. */
const MEDIA_MARKERS = new Map([
  ["disk-derived-playfield-artwork", { noun: "playfield artwork", extensions: IMAGE_EXT }],
  ["disk-derived-audio", { noun: "sound effect", extensions: AUDIO_EXT }],
  ["disk-derived-shell-artwork", { noun: "shell artwork", extensions: IMAGE_EXT }],
  ["disk-derived-loading-logo", { noun: "loading logo", extensions: IMAGE_EXT }],
  ["disk-derived-shell-music", { noun: "front-end music", extensions: AUDIO_EXT }],
  ["disk-derived-table-music", { noun: "in-game music", extensions: AUDIO_EXT }],
  ["disk-derived-playfield-artwork-hd", { noun: "HD playfield artwork", extensions: IMAGE_EXT }],
  ["disk-derived-lamp-overlays-hd", { noun: "HD lamp patch atlas", extensions: IMAGE_EXT }],
  ["disk-derived-ball-sprite-hd", { noun: "HD ball sprite", extensions: IMAGE_EXT }],
  ["disk-derived-flipper-sprites-hd", { noun: "HD flipper bat atlas", extensions: IMAGE_EXT }],
]);

/** Classes whose manifest claims exactly one raster through an `image` field. */
const SINGLE_IMAGE_CLASSES = new Set([
  "disk-derived-playfield-artwork",
  "disk-derived-playfield-artwork-hd",
  "disk-derived-lamp-overlays-hd",
  "disk-derived-ball-sprite-hd",
  "disk-derived-flipper-sprites-hd",
  "disk-derived-loading-logo",
]);

/** Tolerates both `"sourceClass":"x"` and the spaced form a formatter might emit. */
function declaresClass(text, sourceClass) {
  return new RegExp(`"sourceClass"\\s*:\\s*"${sourceClass}"`).test(text);
}

const derived = [];
/** rel path of a media file -> { manifest, sha256, noun } that claims it. */
const claimed = new Map();
const media = [];

/** Records one manifest's claim on one file, or a violation explaining why not. */
function claim(rel, name, digest, noun, what) {
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/.test(name)) {
    violations.push(`${rel}: ${what} does not name its file`);
    return;
  }
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
    violations.push(`${rel}: ${what} ${name} carries no sha256 digest`);
    return;
  }
  const target = join(dirname(rel), name);
  if (claimed.has(target)) {
    violations.push(`${rel}: ${target} is already claimed by ${claimed.get(target).manifest}`);
    return;
  }
  claimed.set(target, { manifest: rel, sha256: digest, noun });
}

for await (const file of walk(root)) {
  const rel = relative(root, file);
  const ext = extname(file).toLowerCase();

  if (IMAGE_EXT.has(ext) || AUDIO_EXT.has(ext)) media.push({ rel, file, ext });
  if (ext !== ".json") continue;

  const text = await readFile(file, "utf8");
  const marker = DERIVED_MARKERS.find((m) => declaresClass(text, m.class));
  if (marker === undefined) continue;
  derived.push({ rel, noun: marker.noun });

  // A manifest that ships media beside it must account for every piece of it.
  const media_marker = MEDIA_MARKERS.get(marker.class);
  if (media_marker === undefined) continue;
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    violations.push(`${rel}: declares disk-derived ${media_marker.noun} but is not valid JSON`);
    continue;
  }
  if (SINGLE_IMAGE_CLASSES.has(marker.class)) {
    claim(rel, doc?.image?.file, doc?.image?.sha256, media_marker.noun, `${media_marker.noun} manifest`);
    continue;
  }
  if (marker.class === "disk-derived-shell-artwork") {
    const shellImages = Array.isArray(doc?.images) ? doc.images : null;
    if (shellImages === null) {
      violations.push(`${rel}: shell artwork manifest carries no images array`);
      continue;
    }
    for (const image of shellImages) {
      claim(rel, image?.file, image?.sha256, media_marker.noun, "shell artwork manifest");
    }
    continue;
  }
  // The fall-through: both audio classes — the tables' sound effects and the
  // shell's module instruments — ship a `samples: [{file, sha256}]` array, so
  // one branch claims both. A new audio class only has to use that shape.
  const samples = Array.isArray(doc?.samples) ? doc.samples : null;
  if (samples === null) {
    violations.push(`${rel}: audio manifest carries no samples array`);
    continue;
  }
  for (const sample of samples) {
    claim(rel, sample?.file, sample?.sha256, media_marker.noun, "audio manifest");
  }
}

// Every media file must be claimed, and must be the file that was claimed.
for (const { rel, file } of media) {
  const held = claimed.get(rel);
  if (held === undefined) {
    violations.push(
      `${rel}: media file with no manifest — nothing in this build says where it came from`,
    );
    continue;
  }
  const actual = createHash("sha256").update(await readFile(file)).digest("hex");
  if (actual !== held.sha256) {
    violations.push(
      `${rel}: sha256 ${actual.slice(0, 16)} does not match the ${held.sha256.slice(0, 16)} ` +
        `recorded in ${held.manifest}`,
    );
    continue;
  }
  derived.push({ rel, noun: held.noun });
}

// A manifest that ships without its media is a broken build, not a safe one.
for (const [target, held] of claimed) {
  if (!media.some((entry) => entry.rel === target)) {
    violations.push(`${held.manifest}: claims ${target}, which is not in the build`);
  }
}

if (derived.length > 0 && process.env[AUTHORIZATION_ENV] !== "1") {
  console.error(
    `guard:public — REFUSING BUILD: ${derived.length} disk-derived asset(s) present ` +
      `without ${AUTHORIZATION_ENV}=1`,
  );
  for (const d of derived) console.error(`  - ${d.rel} (${d.noun})`);
  console.error(
    `\n  These are collision geometry and playfield artwork decoded from the original ` +
      `disks. Set ${AUTHORIZATION_ENV}=1 to confirm you intend to publish them.`,
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(`guard:public — REFUSING BUILD, ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

const note = derived.length > 0 ? `, ${derived.length} authorized derived asset(s)` : "";
console.log(`guard:public — clean (${root}${note})`);

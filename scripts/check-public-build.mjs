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
];

/** Tolerates both `"sourceClass":"x"` and the spaced form a formatter might emit. */
function declaresClass(text, sourceClass) {
  return new RegExp(`"sourceClass"\\s*:\\s*"${sourceClass}"`).test(text);
}

const derived = [];
/** rel path of an image -> { manifest, sha256 } that claims it. */
const claimed = new Map();
const images = [];

for await (const file of walk(root)) {
  const rel = relative(root, file);
  const ext = extname(file).toLowerCase();

  if (IMAGE_EXT.has(ext)) images.push({ rel, file });
  if (ext !== ".json") continue;

  const text = await readFile(file, "utf8");
  const marker = DERIVED_MARKERS.find((m) => declaresClass(text, m.class));
  if (marker === undefined) continue;
  derived.push({ rel, noun: marker.noun });

  // An artwork manifest must also account for the image it ships beside.
  if (marker.class !== "disk-derived-playfield-artwork") continue;
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    violations.push(`${rel}: declares disk-derived artwork but is not valid JSON`);
    continue;
  }
  const name = doc?.image?.file;
  const digest = doc?.image?.sha256;
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/.test(name)) {
    violations.push(`${rel}: artwork manifest does not name its image in image.file`);
    continue;
  }
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
    violations.push(`${rel}: artwork manifest ${name} carries no sha256 digest`);
    continue;
  }
  const target = join(dirname(rel), name);
  if (claimed.has(target)) {
    violations.push(`${rel}: ${target} is already claimed by ${claimed.get(target).manifest}`);
    continue;
  }
  claimed.set(target, { manifest: rel, sha256: digest });
}

// Every image must be claimed, and must be the image that was claimed.
for (const { rel, file } of images) {
  const claim = claimed.get(rel);
  if (claim === undefined) {
    violations.push(
      `${rel}: raster image with no manifest — nothing in this build says where it came from`,
    );
    continue;
  }
  const actual = createHash("sha256").update(await readFile(file)).digest("hex");
  if (actual !== claim.sha256) {
    violations.push(
      `${rel}: sha256 ${actual.slice(0, 16)} does not match the ${claim.sha256.slice(0, 16)} ` +
        `recorded in ${claim.manifest}`,
    );
    continue;
  }
  derived.push({ rel, noun: "playfield artwork" });
}

// A manifest that ships without its image is a broken build, not a safe one.
for (const [target, claim] of claimed) {
  if (!images.some((image) => image.rel === target)) {
    violations.push(`${claim.manifest}: claims ${target}, which is not in the build`);
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

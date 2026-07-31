#!/usr/bin/env node
// Refuses a build that contains preservation media, Amiga executables, private
// filesystem paths, or credentials. Runs as the last step of `npm run build`.
//
// The original disks are the operator's own property and are read locally for
// analysis only. Nothing derived from them belongs in a shipped artifact; this
// script is the mechanical check that keeps that true even when someone forgets.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { existsSync } from "node:fs";

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

// Disk-derived collision geometry is permitted, but only deliberately. The maps
// are functional geometry decoded from the operator's own disks — no artwork,
// audio or executable code — and shipping them is an explicit decision rather
// than something that happens because a file was copied into public/.
const AUTHORIZATION_ENV = "PINBALL_ILLUSIONS_DERIVED_AUTHORIZED";
const DERIVED_MARKER = '"sourceClass":"disk-derived-collision-geometry"';

const derived = [];
for await (const file of walk(root)) {
  if (extname(file).toLowerCase() !== ".json") continue;
  const text = await readFile(file, "utf8");
  if (text.includes(DERIVED_MARKER) || text.includes(DERIVED_MARKER.replaceAll('"', '" '))) {
    derived.push(relative(root, file));
  }
}

if (derived.length > 0 && process.env[AUTHORIZATION_ENV] !== "1") {
  console.error(
    `guard:public — REFUSING BUILD: ${derived.length} disk-derived map(s) present ` +
      `without ${AUTHORIZATION_ENV}=1`,
  );
  for (const d of derived) console.error(`  - ${d}`);
  console.error(
    `\n  These are collision geometry decoded from the original disks. Set ` +
      `${AUTHORIZATION_ENV}=1 to confirm you intend to publish them.`,
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(`guard:public — REFUSING BUILD, ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

const note = derived.length > 0 ? `, ${derived.length} authorized derived map(s)` : "";
console.log(`guard:public — clean (${root}${note})`);

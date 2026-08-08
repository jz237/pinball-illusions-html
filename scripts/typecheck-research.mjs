#!/usr/bin/env node
// TYPECHECK THE RESEARCH PROBES — the thing that was checking them was nothing.
//
// `tsconfig.json` covers `src`, `tests` and `scripts`. The forty-one `.mts`
// harnesses under `../research/` were covered by no configuration at all, and
// every one of them imports signatures straight out of `game/src`. A rename in
// `src` broke them silently and the breakage surfaced only the next time
// somebody happened to run that probe — in a project whose entire evidence base
// IS those probes. The first run of this check found **127 errors in 25 files**;
// 102 of those were the two archived driver directories that ran from
// `game/scripts/` and were moved afterwards (excluded by name and by reason in
// `tsconfig.research.json`), and the remaining **25 were live drift in 10
// probes**, including the panel gate's own film tool and a trace column that had
// been writing the word "undefined" for its whole life.
//
// WHY THIS IS A SCRIPT AND NOT JUST `tsc -p`: `../research/` is the operator's
// local working tree and is NOT in this git repository. A clean checkout has
// nothing to point the config at, so `npm run build` must not depend on it. This
// says out loud which of the two situations it is in, because a check that
// quietly passes when its corpus is missing is the shape this project has
// already caught nine tests wearing (`audio.test.ts`'s shell-music fixture) and
// is not going to grow a tenth.
//
//   node scripts/typecheck-research.mjs            skip loudly if absent
//   node scripts/typecheck-research.mjs --require   fail if absent
//
// Exit: 0 clean or (skipped without --require) | 1 errors | 2 tree absent under
// --require.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GAME = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESEARCH = resolve(GAME, "..", "research");
const CONFIG = join(GAME, "tsconfig.research.json");
const required = process.argv.includes("--require");

if (!existsSync(RESEARCH)) {
  const note = `research typecheck: SKIPPED — ${RESEARCH} is not present in this tree`;
  if (required) {
    console.error(`${note}, and --require was given`);
    process.exit(2);
  }
  console.log(`${note}. It is not in this repository; nothing was checked.`);
  process.exit(0);
}

console.log(`research typecheck: ${CONFIG} over ${RESEARCH}`);
// `node node_modules/typescript/bin/tsc`, NOT `node_modules/.bin/tsc.cmd` under
// `shell: true`. This project lives at "D:\Projects\Pinball Illusions\", and a
// shell invocation of a space-bearing path splits at the space — which is
// exactly what the first version of this file did, and it reported "FAILED"
// while running nothing at all. No shell, no quoting, no hazard.
const tsc = join(GAME, "node_modules", "typescript", "bin", "tsc");
if (!existsSync(tsc)) {
  console.error(`research typecheck: typescript is not installed at ${tsc}`);
  process.exit(1);
}
const run = spawnSync(process.execPath, [tsc, "-p", CONFIG, "--noEmit"], {
  cwd: GAME,
  stdio: "inherit",
});
if (run.error !== undefined && run.error !== null) {
  console.error(`research typecheck: could not run ${tsc}: ${run.error.message}`);
  process.exit(1);
}
const code = run.status ?? 1;
console.log(code === 0 ? "research typecheck: clean" : "research typecheck: FAILED");
process.exit(code);

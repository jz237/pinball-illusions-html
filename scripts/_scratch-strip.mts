// Scratch: free ball-centre runs on both collision lines down the far-left
// strip of Law 'n Justice, to see whether the upper line offers a way past the
// posts that seal the lower one.
import { readFileSync } from "node:fs";
import { parseTableMapDocument } from "../src/game/table-map.js";
import { upperLevelViewFor } from "../src/game/playfield-levels.js";
import { PROBE_RING } from "../src/game/collision-probe.js";
import { isLevel0Solid } from "../src/game/materials.js";
import type { TableMap, TableMapDocument } from "../src/game/contracts.js";

const map = parseTableMapDocument(
  JSON.parse(
    readFileSync("public/generated/tables/law-n-justice.map.json", "utf8"),
  ) as TableMapDocument,
);
const upper = upperLevelViewFor(map);

function freeAt(view: TableMap, x: number, y: number): boolean {
  for (let i = 0; i < PROBE_RING.size; i += 1) {
    const ox = PROBE_RING.dx[i] ?? 0;
    const oy = PROBE_RING.dy[i] ?? 0;
    if (isLevel0Solid(view.materialAt(x + ox, y + oy))) return false;
  }
  return !isLevel0Solid(view.materialAt(x, y));
}

function runs(view: TableMap, y: number, lo: number, hi: number): string {
  const out: string[] = [];
  let start = -1;
  for (let x = lo; x <= hi; x += 1) {
    const free = freeAt(view, x, y);
    if (free && start < 0) start = x;
    if (!free && start >= 0) {
      out.push(`${start}-${x - 1}`);
      start = -1;
    }
  }
  if (start >= 0) out.push(`${start}-${hi}`);
  return out.length === 0 ? "none" : out.join(",");
}

const LO = 0;
const HI = 45;
for (let y = 200; y <= 410; y += 2) {
  const l0 = runs(map, y, LO, HI);
  const l1 = runs(upper, y, LO, HI);
  console.log(`y=${String(y).padStart(3)}  L0 ${l0.padEnd(22)}  L1 ${l1}`);
}

import { describe, it } from "vitest";
import { shippedShellMusic } from "./shell-music-fixture.js";
import { renderSongStream } from "../src/audio/song-stream.js";
import { createTrackerPlayer, stepTracker } from "../src/audio/tracker.js";
describe("probe4", () => {
  it("measures", async () => {
    const a = await shippedShellMusic();
    if (a === null) { console.log("NO ASSET"); return; }
    const s = renderSongStream(a.song, a.voices);
    console.log("PROBE durationMs", s.durationMs, "ticks", s.durationMs / 20, "restartMs", s.restartMs, "commands", s.commands.length);
    // walk from order 1 to the B jump
    const p = createTrackerPlayer(a.song, 1);
    let ticks = 0;
    const marks: string[] = [];
    let prev = -1;
    for (let i = 0; i < 40000; i += 1) {
      if (p.tick === 0 && p.row === 0 && p.order !== prev) { marks.push(`${p.order}@${ticks}`); prev = p.order; }
      stepTracker(p); ticks += 1;
      if (p.order === 1 && p.row === 0 && p.tick === 0 && ticks > 10) break;
    }
    console.log("PROBE loop from order1:", ticks, "ticks");
    console.log("PROBE marks", marks.join(" "));
    console.log("PROBE effects present:", JSON.stringify([...new Set(a.song.patterns.flat().flat().filter(c=>!(c.effect===0&&c.param===0)).map(c=>c.effect===0xe?`E${(c.param>>4).toString(16)}`:c.effect.toString(16)))].sort()));
  });
});

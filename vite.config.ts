import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Vitest defaults to 5 seconds, and this suite has cases that legitimately
    // take four: `flippers.test.ts`'s "sweeps every bat through open playfield
    // at every point of the stroke" walks three tables x three bats x every
    // stroke position against the real 336x600 collision map, and
    // `moving-sprites.test.ts` composites and re-scans full frames. Those are
    // real work, not slow code, and they were flaking against the default under
    // parallel load. This raises the CLOCK ONLY: no assertion is relaxed, and a
    // case that genuinely hangs still fails.
    testTimeout: 30_000,
  },
});

/**
 * The shipped front-end module, loaded off disk for the node suite.
 *
 * The asset only exists in a tree where `scripts/export-shell-music.mjs` has
 * been run against the operator's own disks, so every consumer treats a null as
 * "skip": a checkout with no authorized assets still runs the whole suite.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadShellMusic } from "../src/audio/shell-music.js";
import type { ShellMusicAsset, ShellMusicFetch } from "../src/audio/shell-music.js";
import { SYNTHESIZED_BANK } from "../src/audio/tracker-output.js";

const SHELL_DIR = fileURLToPath(new URL("../public/generated/shell/", import.meta.url));

export const shellMusicExported = existsSync(`${SHELL_DIR}shell-music.json`);

const diskFetch: ShellMusicFetch = (url) => {
  const path = `${SHELL_DIR}${url.slice(url.lastIndexOf("/") + 1)}`;
  if (!existsSync(path)) {
    return Promise.resolve({
      ok: false,
      status: 404,
      statusText: "Not Found",
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
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

let cached: ShellMusicAsset | null | undefined;

export async function shippedShellMusic(): Promise<ShellMusicAsset | null> {
  if (cached === undefined) cached = shellMusicExported ? await loadShellMusic(diskFetch, "") : null;
  return cached;
}

/**
 * A tiny asset on the SYNTHESIZED bank, for the controller's own tests.
 *
 * The shell-music controller's job is phase handling, muting and storage, none
 * of which cares which song it is given. Handing it a two-row fixture keeps
 * those tests independent of whether the disk assets are exported in this
 * checkout, and exercises the bank parameter with a bank that is not the disk's.
 */
export function syntheticShellMusicAsset(): ShellMusicAsset {
  return {
    song: {
      title: "fixture",
      initialSpeed: 6,
      initialTempo: 125,
      restart: 0,
      // Two orders, because `renderSongStream` detects the wrap by the order
      // index going backwards and a one-order song never lets it.
      orders: [0, 0],
      patterns: [
        Array.from({ length: 64 }, (_, row) => [
          row % 16 === 0
            ? { note: 25, instrument: 1, effect: 0, param: 0 }
            : { note: 0, instrument: 0, effect: 0, param: 0 },
          { note: 0, instrument: 0, effect: 0, param: 0 },
          { note: 0, instrument: 0, effect: 0, param: 0 },
          { note: 0, instrument: 0, effect: 0, param: 0 },
        ]),
      ],
      instruments: [{ id: 1, finetune: 0, volume: 64 }],
    },
    voices: { 1: "pulse50" },
    bank: SYNTHESIZED_BANK,
    liveInstruments: [1],
  };
}

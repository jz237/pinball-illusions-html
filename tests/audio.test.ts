/**
 * The sound layer: the manifest, the priority channel, and the promise that
 * none of it can reach the simulation.
 *
 * The last one is the important test in this file. Everything else is a
 * convenience; a reconstruction whose replays stop matching because a sample
 * decoded a frame later is broken in a way no amount of correct mixing fixes.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { TableAudioDocument, TableId } from "../src/game/contracts.js";
import { PAULA_MAX_VOLUME, parseTableAudioDocument } from "../src/game/table-audio.js";
import type { AudioSample, TableAudio } from "../src/game/table-audio.js";
import {
  createAudioBank,
  loadAudioBank,
  playAward,
  playSample,
  playTick,
  setMuted,
} from "../src/browser/audio.js";
import type { AudioBank, AudioHost } from "../src/browser/audio.js";
import type { Award } from "../src/game/scoring.js";
import {
  createGame,
  debugSnapshot,
  runTicks,
  startGame,
} from "../src/browser/game-loop.js";
import type { InputSource } from "../src/browser/game-loop.js";
import { IDLE_SNAPSHOT } from "../src/browser/input.js";
import { mapFor } from "./table-fixtures.js";

function documentFor(tableId: TableId): TableAudioDocument {
  const url = new URL(`../public/generated/tables/${tableId}.audio.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as TableAudioDocument;
}

function audioFor(tableId: TableId): TableAudio {
  return parseTableAudioDocument(documentFor(tableId));
}

// ---------------------------------------------------------------------------
// A fake audio device
// ---------------------------------------------------------------------------

interface FakeNode {
  connect(target: unknown): void;
}

class FakeHost implements AudioHost {
  currentTime = 0;
  state = "running";
  readonly destination = {} as AudioNode;
  readonly started: { buffer: unknown; gain: number }[] = [];
  stops = 0;

  createBufferSource(): AudioBufferSourceNode {
    const host = this;
    let gainOf = 1;
    const node = {
      buffer: null as unknown,
      connect(target: unknown) {
        const holder = target as { gain?: { value: number } };
        if (holder.gain !== undefined) gainOf = holder.gain.value;
      },
      start() {
        host.started.push({ buffer: node.buffer, gain: gainOf });
      },
      stop() {
        host.stops += 1;
      },
    };
    return node as unknown as AudioBufferSourceNode;
  }

  createGain(): GainNode {
    const node: FakeNode & { gain: { value: number } } = {
      gain: { value: 1 },
      connect() {
        /* the destination is a sink in this fake */
      },
    };
    return node as unknown as GainNode;
  }

  async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    return { length: data.byteLength } as unknown as AudioBuffer;
  }

  async resume(): Promise<void> {
    this.state = "running";
  }
}

/** Serves the real WAVs off disk, so the bank under test holds the real bytes. */
function diskFetch() {
  return async (url: string) => {
    const name = url.slice(url.lastIndexOf("/") + 1);
    const file = new URL(`../public/generated/tables/${name}`, import.meta.url);
    const bytes = readFileSync(file);
    return {
      ok: true,
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  };
}

async function bankFor(tableId: TableId): Promise<AudioBank> {
  const bank = createAudioBank(new FakeHost(), audioFor(tableId));
  await loadAudioBank(bank, diskFetch());
  return bank;
}

const award = (id: string): Award => ({ source: "device", id, score: 0, bonus: 0, repeat: false });

// ---------------------------------------------------------------------------

describe("the shipped sound manifests", () => {
  it("parse, and every sample is the file the manifest says it is", () => {
    for (const tableId of TABLE_IDS) {
      const audio = audioFor(tableId);
      expect(audio.samples.length, `${tableId} has no samples`).toBeGreaterThan(0);
      for (const sample of audio.samples) {
        const file = new URL(`../public/generated/tables/${sample.file}`, import.meta.url);
        const bytes = readFileSync(file);
        expect(createHash("sha256").update(bytes).digest("hex"), `${sample.file}`).toBe(
          sample.sha256,
        );
        // 44 bytes of RIFF header plus the PCM the record declares.
        expect(bytes.length).toBe(44 + sample.bytes);
        expect(bytes.toString("latin1", 0, 4)).toBe("RIFF");
        expect(bytes.readUInt32LE(24), `${sample.file} rate`).toBe(sample.rate);
        expect(bytes.readUInt16LE(34), `${sample.file} bit depth`).toBe(8);
      }
    }
  });

  it("writes each sample at the PAL rate its Paula period asks for", () => {
    // 3546895 / period, and the period is an exact ProTracker entry. The two
    // together are what make this a pitch rather than a guess; see the exporter.
    for (const tableId of TABLE_IDS) {
      for (const sample of audioFor(tableId).samples) {
        expect(sample.rate).toBe(Math.round(3546895 / sample.period));
        expect(sample.volume).toBeLessThanOrEqual(PAULA_MAX_VOLUME);
      }
    }
  });

  it("binds only things the scoring layer can actually award", () => {
    // The key IS the award id. If these two ever drift apart the sound simply
    // stops happening, silently, which is the kind of bug that survives for
    // months — so the shape is asserted.
    for (const tableId of TABLE_IDS) {
      const audio = audioFor(tableId);
      let bound = 0;
      for (const id of [
        ...Array.from({ length: 224 }, (_, i) => `device-${i + 32}`),
        ...Array.from({ length: 6 }, (_, i) => `bumper-${i + 16}`),
        ...Array.from({ length: 10 }, (_, i) => `slingshot-${i + 22}`),
      ]) {
        if (audio.sampleForAward(id) !== null) bound += 1;
      }
      expect(bound, `${tableId} binds no device, bumper or slingshot sound`).toBeGreaterThan(0);
      expect(audio.sampleForAward("nothing-at-all")).toBeNull();
    }
  });

  it("labels the kind-5 samples as inferred rather than decoded", () => {
    // The (bank, instrument) resolver is not in main.seg00. Extreme Sports' lane
    // chime is resolved by inference and the manifest has to say so.
    const kinds = new Set(
      TABLE_IDS.flatMap((tableId) => audioFor(tableId).samples).map(
        (sample) => `${sample.kind}:${sample.provenance}`,
      ),
    );
    expect(kinds.has("sample:decoded")).toBe(true);
    for (const kind of kinds) {
      expect(["sample:decoded", "instrument:inferred"]).toContain(kind);
    }
  });
});

describe("the sound manifest parser refuses", () => {
  const mutate = (change: (doc: Record<string, unknown>) => void): TableAudioDocument => {
    const doc = JSON.parse(JSON.stringify(documentFor("law-n-justice"))) as Record<string, unknown>;
    change(doc);
    return doc as unknown as TableAudioDocument;
  };

  it("a document with the wrong schema", () => {
    expect(() => parseTableAudioDocument(mutate((doc) => { doc["schema"] = "no"; }))).toThrow(/schema/);
  });

  it("a sample with no digest", () => {
    expect(() =>
      parseTableAudioDocument(mutate((doc) => { (doc["samples"] as { sha256: string }[])[0]!.sha256 = ""; })),
    ).toThrow(/sha256/);
  });

  it("a volume Paula could not hold", () => {
    expect(() =>
      parseTableAudioDocument(mutate((doc) => { (doc["samples"] as { volume: number }[])[0]!.volume = 65; })),
    ).toThrow(/volume/);
  });

  it("a trigger naming a sample that is not there", () => {
    expect(() =>
      parseTableAudioDocument(mutate((doc) => { (doc["triggers"] as { sample: number }[])[0]!.sample = 99; })),
    ).toThrow(/trigger/);
  });
});

describe("the effect channel", () => {
  it("plays a bound award and gives it Paula's own volume", async () => {
    const bank = await bankFor("law-n-justice");
    const host = bank.host as FakeHost;
    const sample = bank.audio.samples.find((one) => one.priority > 0) as AudioSample;
    expect(playSample(bank, sample)).toBe(true);
    expect(host.started.length).toBe(1);
    expect(host.started[0]?.gain).toBeCloseTo(sample.volume / PAULA_MAX_VOLUME, 6);
  });

  it("refuses to let a quieter event interrupt a louder one", async () => {
    // `$779E`: `cmp.w $2(a1),d7 / bcs skip` — strictly lower priority is dropped
    // while the current effect is still sounding, and an equal one gets through.
    const bank = await bankFor("babewatch");
    const host = bank.host as FakeHost;
    const loud = [...bank.audio.samples].sort((a, b) => b.priority - a.priority)[0] as AudioSample;
    const quiet = [...bank.audio.samples].sort((a, b) => a.priority - b.priority)[0] as AudioSample;
    expect(loud.priority).toBeGreaterThan(quiet.priority);

    expect(playSample(bank, loud)).toBe(true);
    expect(playSample(bank, quiet)).toBe(false);
    expect(playSample(bank, loud)).toBe(true);
    expect(host.started.length).toBe(2);

    // Once it has finished, anything may start.
    host.currentTime = bank.channel.until + 1;
    expect(playSample(bank, quiet)).toBe(true);
  });

  it("plays nothing at all while muted, and stops what was sounding", async () => {
    const bank = await bankFor("law-n-justice");
    const host = bank.host as FakeHost;
    const sample = bank.audio.samples[0] as AudioSample;
    playSample(bank, sample);
    setMuted(bank, true);
    expect(host.stops).toBeGreaterThan(0);
    expect(playSample(bank, sample)).toBe(false);
    setMuted(bank, false);
    expect(playSample(bank, sample)).toBe(true);
  });

  it("plays nothing for an award nothing is bound to", async () => {
    const bank = await bankFor("law-n-justice");
    expect(playAward(bank, award("device-255"))).toBe(false);
  });

  it("survives a sample that will not load", async () => {
    const bank = createAudioBank(new FakeHost(), audioFor("law-n-justice"));
    await loadAudioBank(bank, async () => ({ ok: false, async arrayBuffer() { return new ArrayBuffer(0); } }));
    expect(bank.failed.size).toBe(bank.audio.samples.length);
    expect(playSample(bank, bank.audio.samples[0] as AudioSample)).toBe(false);
  });
});

describe("audio cannot reach the simulation", () => {
  it("plays a real game's ticks and changes nothing about it", () => {
    // The contract in one assertion. The same game is run twice from the same
    // start; the second run has the whole sound layer hanging off every tick.
    // The two must finish byte-identical.
    const idle = (): InputSource => ({ sample: () => IDLE_SNAPSHOT });

    const silent = createGame(mapFor("law-n-justice"), { ballsPerGame: 3 });
    startGame(silent);
    runTicks(silent, idle(), 3_000);

    const loud = createGame(mapFor("law-n-justice"), { ballsPerGame: 3 });
    startGame(loud);
    const bank = createAudioBank(new FakeHost(), audioFor("law-n-justice"));
    // Buffers on purpose, so `playSample` really runs rather than bailing out on
    // a missing one: the point is that the WORK happening changes nothing.
    for (const sample of bank.audio.samples) {
      bank.buffers.set(sample.index, { length: sample.bytes } as unknown as AudioBuffer);
    }
    for (const report of runTicks(loud, idle(), 3_000)) playTick(bank, report);

    expect(JSON.stringify(debugSnapshot(loud))).toBe(JSON.stringify(debugSnapshot(silent)));
  });
});

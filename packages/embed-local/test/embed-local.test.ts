import { describe, it, expect } from "vitest";
import { LocalEmbedder, type FeatureExtractor } from "../src/index.js";

/** Returns a vector encoding the input's index, so ordering bugs are detectable. */
function fakeExtractor(calls: string[][]): FeatureExtractor {
  return async (texts) => {
    calls.push([...texts]);
    return { tolist: () => texts.map((t) => [t.length, 0, 0]) };
  };
}

describe("LocalEmbedder", () => {
  it("returns one vector per input", async () => {
    const e = new LocalEmbedder({ extractor: fakeExtractor([]) });
    expect(await e.embed(["a", "bb", "ccc"])).toHaveLength(3);
  });

  it("preserves input order across batch boundaries", async () => {
    const e = new LocalEmbedder({ batchSize: 2, extractor: fakeExtractor([]) });
    const texts = ["a", "bb", "ccc", "dddd", "eeeee"];
    const out = await e.embed(texts);
    // First component is the input length, so order is verifiable.
    expect(out.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
  });

  it("splits into batches of the configured size", async () => {
    const calls: string[][] = [];
    const e = new LocalEmbedder({ batchSize: 2, extractor: fakeExtractor(calls) });
    await e.embed(["a", "b", "c", "d", "e"]);
    expect(calls.map((c) => c.length)).toEqual([2, 2, 1]);
  });

  it("returns an empty array without invoking the model", async () => {
    const calls: string[][] = [];
    const e = new LocalEmbedder({ extractor: fakeExtractor(calls) });
    expect(await e.embed([])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("throws rather than returning a short result if the model misbehaves", async () => {
    const broken: FeatureExtractor = async () => ({ tolist: () => [[1, 0, 0]] });
    const e = new LocalEmbedder({ extractor: broken });
    await expect(e.embed(["a", "b"])).rejects.toThrow(/expected 2 vectors/);
  });

  it("declares its dimensions", () => {
    expect(new LocalEmbedder().dimensions).toBe(384);
    expect(new LocalEmbedder({ dimensions: 768 }).dimensions).toBe(768);
  });
});

import type { Clock, Embedder, Evidence, Synthesizer, SynthesisResult } from "../../src/index.js";

export class FakeClock implements Clock {
  constructor(private t: Date) {}
  now(): Date { return new Date(this.t); }
  advance(seconds: number): void { this.t = new Date(this.t.getTime() + seconds * 1000); }
}

export class FakeEmbedder implements Embedder {
  readonly dimensions = 3;
  private map = new Map<string, number[]>();
  register(text: string, vector: number[]): void { this.map.set(text, vector); }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.map.get(t) ?? [1, 0, 0]);
  }
}

export class FakeSynthesizer implements Synthesizer {
  buildCalls = 0;
  patchCalls = 0;
  failBuild = false;
  failPatch = false;
  confidence = 0.9;

  async build(question: string, evidence: Evidence[]): Promise<SynthesisResult> {
    this.buildCalls++;
    if (this.failBuild) throw new Error("synthesizer unavailable");
    return {
      content: `digest of ${evidence.length} items for: ${question}`,
      claims: evidence.map((e) => ({ text: e.content, evidence_ids: [e.id] })),
      confidence: this.confidence,
      gaps: [],
      tokens_used: 1000,
    };
  }

  async patch(obj: { content: string }, changed: Evidence[], removed: string[]): Promise<SynthesisResult> {
    this.patchCalls++;
    if (this.failPatch) throw new Error("synthesizer unavailable");
    return {
      content: `${obj.content} [patched +${changed.length} -${removed.length}]`,
      claims: changed.map((e) => ({ text: e.content, evidence_ids: [e.id] })),
      confidence: this.confidence,
      gaps: [],
      tokens_used: 120,
    };
  }
}

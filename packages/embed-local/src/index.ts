import type { Embedder } from "@knowy/core";

/**
 * The subset of a transformers.js feature-extraction pipeline we depend on.
 * Injectable so tests can exercise batching and ordering without loading a model.
 */
export type FeatureExtractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

export interface LocalEmbedderOptions {
  /** Hugging Face model id. bge-small-en-v1.5 is 384-dim and strong for its size. */
  model?: string;
  dimensions?: number;
  /** Inputs per forward pass. Larger is faster but uses more memory. */
  batchSize?: number;
  /** Injected for tests; loaded lazily from transformers.js when omitted. */
  extractor?: FeatureExtractor;
}

/**
 * Embedder that runs entirely in-process — no API key, no per-token cost, and no third
 * party in the data path. That last point is a requirement for enterprises that cannot
 * send document text to an external service, not merely a cost saving.
 */
export class LocalEmbedder implements Embedder {
  readonly dimensions: number;
  private readonly model: string;
  private readonly batchSize: number;
  private extractor: FeatureExtractor | undefined;
  private loading: Promise<FeatureExtractor> | undefined;

  constructor(opts: LocalEmbedderOptions = {}) {
    this.model = opts.model ?? "Xenova/bge-small-en-v1.5";
    this.dimensions = opts.dimensions ?? 384;
    this.batchSize = opts.batchSize ?? 32;
    this.extractor = opts.extractor;
  }

  private async load(): Promise<FeatureExtractor> {
    if (this.extractor !== undefined) return this.extractor;
    // Concurrent callers must share one load; the model is ~130MB.
    this.loading ??= (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const pipe = await pipeline("feature-extraction", this.model, { dtype: "fp32" });
      return pipe as unknown as FeatureExtractor;
    })();
    this.extractor = await this.loading;
    return this.extractor;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extract = await this.load();
    const out: number[][] = [];
    // Batched, but appended in input order — a reordered result would silently pair every
    // embedding with the wrong text, and nothing downstream would obviously catch it.
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const res = await extract(batch, { pooling: "mean", normalize: true });
      out.push(...res.tolist());
    }
    if (out.length !== texts.length) {
      throw new Error(`embed: expected ${texts.length} vectors, got ${out.length}`);
    }
    return out;
  }
}

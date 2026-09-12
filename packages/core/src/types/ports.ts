import type {
  Evidence, Fingerprint, IndexCapabilities, SearchOpts, SearchQuery,
} from "./evidence.js";
import type { Claim, IntelligenceObject } from "./object.js";

export interface RawEvidenceIndex {
  search(query: SearchQuery, opts: SearchOpts): Promise<Evidence[]>;
  /** Fetch specific evidence by id. The patch tier needs changed content, not a query. */
  fetch(ids: string[]): Promise<Evidence[]>;
  /** null = known gone or never existed. An absent key = could not answer (spec §7.3). */
  fingerprint(ids: string[]): Promise<Map<string, Fingerprint | null>>;
  capabilities(): IndexCapabilities;
}

export interface ScoredObject {
  object: IntelligenceObject;
  score: number;
}

export interface SimilarOpts {
  topK: number;
  minScore: number;
  tags?: string[];
}

export interface InvalidateSelector {
  ids?: string[];
  source_uris?: string[];
  tags?: string[];
  all?: boolean;
}

export interface ObjectStore {
  get(tenantId: string, id: string, version?: number): Promise<IntelligenceObject | null>;
  put(obj: IntelligenceObject): Promise<void>;
  searchSimilar(tenantId: string, vec: number[], opts: SimilarOpts): Promise<ScoredObject[]>;
  invalidate(tenantId: string, selector: InvalidateSelector): Promise<number>;
  markVerified(tenantId: string, id: string, at: string): Promise<void>;
}

export interface SynthesisResult {
  content: string;
  claims: Claim[];
  confidence: number;
  gaps: string[];
  tokens_used: number;
}

export interface Synthesizer {
  build(question: string, evidence: Evidence[]): Promise<SynthesisResult>;
  patch(
    obj: IntelligenceObject,
    changed: Evidence[],
    removed: string[],
  ): Promise<SynthesisResult>;
}

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

export interface Clock {
  now(): Date;
}

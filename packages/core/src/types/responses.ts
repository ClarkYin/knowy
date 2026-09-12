import type { Claim } from "./object.js";

export type Tier = "cached" | "verified" | "patched" | "rebuilt";
export type FreshnessMode = "cached" | "verified" | "fresh";

export interface Savings {
  baseline_tokens: number;
  actual_tokens: number;
  saved_tokens: number;
  baseline_is_estimate: boolean;
}

export interface Citation {
  evidence_id: string;
  source_uri: string;
}

export interface AskRequest {
  tenant_id: string;
  question: string;
  granted_permissions: string[];
  freshness?: FreshnessMode;
  tags?: string[];
}

export interface AskResponse {
  answer: { content: string; claims: Claim[]; citations: Citation[] };
  object_id: string;
  object_version: number;
  tier: Tier;
  stale: boolean;
  degraded: boolean;
  confidence: number;
  gaps: string[];
  savings: Savings;
  latency_ms: number;
}

import type { EvidenceRef } from "./evidence.js";

export interface Claim {
  text: string;
  evidence_ids: string[];
}

export interface Accounting {
  build_tokens: number;
  baseline_tokens: number;
  serve_tokens: number;
}

export interface IntelligenceObject {
  id: string;
  tenant_id: string;
  scope: "query" | "topic";
  canonical_question: string;
  content: string;
  claims: Claim[];
  confidence: number;
  gaps: string[];
  embedding: number[];
  tags: string[];
  acl: string[];
  acl_complete: boolean;
  evidence: EvidenceRef[];
  built_at: string;
  last_verified_at: string | null;
  invalidated_at: string | null;
  ttl_seconds: number;
  version: number;
  supersedes: string | null;
  accounting: Accounting;
}

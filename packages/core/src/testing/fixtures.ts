import type { Evidence, EvidenceRef } from "../types/evidence.js";
import type { IntelligenceObject } from "../types/object.js";

export function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: "ev-1",
    content: "Refunds are processed within 5 business days.",
    source_uri: "confluence://policies/refunds",
    content_hash: "h1",
    acl: ["group:support"],
    score: 0.91,
    ...overrides,
  };
}

export function makeEvidenceRef(overrides: Partial<EvidenceRef> = {}): EvidenceRef {
  return {
    id: "ev-1",
    hash: "h1",
    source_uri: "confluence://policies/refunds",
    acl: ["group:support"],
    retrieved_at: "2026-09-12T00:00:00.000Z",
    ...overrides,
  };
}

export function makeObject(overrides: Partial<IntelligenceObject> = {}): IntelligenceObject {
  return {
    id: "obj-1",
    tenant_id: "acme",
    scope: "query",
    canonical_question: "How long do refunds take?",
    content: "Refunds complete within 5 business days.",
    claims: [{ text: "Refunds complete within 5 business days.", evidence_ids: ["ev-1"] }],
    confidence: 0.9,
    gaps: [],
    embedding: [0.1, 0.2, 0.3],
    tags: ["policy"],
    acl: ["group:support"],
    acl_complete: true,
    evidence: [makeEvidenceRef()],
    built_at: "2026-09-12T00:00:00.000Z",
    last_verified_at: null,
    invalidated_at: null,
    ttl_seconds: 86400,
    version: 1,
    supersedes: null,
    accounting: { build_tokens: 1200, baseline_tokens: 4800, serve_tokens: 400 },
    ...overrides,
  };
}

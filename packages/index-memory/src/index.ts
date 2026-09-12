import {
  cosine,
  type Evidence,
  type Fingerprint,
  type IndexCapabilities,
  type RawEvidenceIndex,
  type SearchOpts,
  type SearchQuery,
} from "@knowy/core";
// IndexRecord lives with the conformance suite; the import is type-only, so it erases.
import type { IndexRecord } from "@knowy/core/testing";

interface Row extends IndexRecord {
  tenantId: string;
}

export class MemoryIndex implements RawEvidenceIndex {
  private rows = new Map<string, Row>();
  private failing = new Set<string>();

  async seed(tenantId: string, records: IndexRecord[]): Promise<void> {
    for (const r of records) {
      this.rows.set(r.evidence.id, { tenantId, evidence: { ...r.evidence }, embedding: r.embedding });
    }
  }

  async setHash(id: string, hash: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.evidence.content_hash = hash;
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async failFor(ids: string[]): Promise<void> {
    for (const id of ids) this.failing.add(id);
  }

  async search(query: SearchQuery, opts: SearchOpts): Promise<Evidence[]> {
    const granted = opts.granted === undefined ? null : new Set(opts.granted);
    return [...this.rows.values()]
      .filter((r) => r.tenantId === opts.tenantId)
      .filter((r) => granted === null || r.evidence.acl.every((t) => granted.has(t)))
      .map((r) => ({ ...r.evidence, score: cosine(query.vector, r.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.topK);
  }

  async fetch(ids: string[]): Promise<Evidence[]> {
    return ids.flatMap((id) => {
      const row = this.rows.get(id);
      return row ? [{ ...row.evidence }] : [];
    });
  }

  async fingerprint(ids: string[]): Promise<Map<string, Fingerprint | null>> {
    const out = new Map<string, Fingerprint | null>();
    for (const id of ids) {
      if (this.failing.has(id)) continue; // omitted key => unknown
      const row = this.rows.get(id);
      out.set(
        id,
        row ? { id, content_hash: row.evidence.content_hash, acl: row.evidence.acl } : null,
      );
    }
    return out;
  }

  capabilities(): IndexCapabilities {
    return { acl: true, hashing: "native" };
  }
}

import {
  cosine,
  type IntelligenceObject,
  type InvalidateSelector,
  type ObjectStore,
  type ScoredObject,
  type SimilarOpts,
} from "@knowy/core";

const key = (tenantId: string, id: string, version: number) => `${tenantId}/${id}@${version}`;

export class MemoryObjectStore implements ObjectStore {
  private rows = new Map<string, IntelligenceObject>();

  private versionsOf(tenantId: string, id: string): IntelligenceObject[] {
    return [...this.rows.values()]
      .filter((o) => o.tenant_id === tenantId && o.id === id)
      .sort((a, b) => b.version - a.version);
  }

  private latestPerId(tenantId: string): IntelligenceObject[] {
    const best = new Map<string, IntelligenceObject>();
    for (const o of this.rows.values()) {
      if (o.tenant_id !== tenantId) continue;
      const seen = best.get(o.id);
      if (!seen || o.version > seen.version) best.set(o.id, o);
    }
    return [...best.values()];
  }

  async get(tenantId: string, id: string, version?: number): Promise<IntelligenceObject | null> {
    if (version !== undefined) return this.rows.get(key(tenantId, id, version)) ?? null;
    return this.versionsOf(tenantId, id)[0] ?? null;
  }

  async put(obj: IntelligenceObject): Promise<void> {
    this.rows.set(key(obj.tenant_id, obj.id, obj.version), { ...obj });
  }

  async searchSimilar(
    tenantId: string,
    vec: number[],
    opts: SimilarOpts,
  ): Promise<ScoredObject[]> {
    return this.latestPerId(tenantId)
      .filter((o) => opts.tags === undefined || opts.tags.some((t) => o.tags.includes(t)))
      .map((o) => ({ object: o, score: cosine(vec, o.embedding) }))
      .filter((s) => s.score >= opts.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.topK);
  }

  async invalidate(tenantId: string, selector: InvalidateSelector): Promise<number> {
    const at = new Date().toISOString();
    let touched = 0;
    for (const o of this.latestPerId(tenantId)) {
      const hit =
        selector.all === true ||
        (selector.ids?.includes(o.id) ?? false) ||
        (selector.tags?.some((t) => o.tags.includes(t)) ?? false) ||
        (selector.source_uris?.some((u) => o.evidence.some((e) => e.source_uri === u)) ?? false);
      if (!hit) continue;
      this.rows.set(key(tenantId, o.id, o.version), { ...o, invalidated_at: at });
      touched++;
    }
    return touched;
  }

  async markVerified(tenantId: string, id: string, at: string): Promise<void> {
    const latest = this.versionsOf(tenantId, id)[0];
    if (!latest) return;
    this.rows.set(key(tenantId, id, latest.version), { ...latest, last_verified_at: at });
  }
}

import type { Evidence } from "../types/evidence.js";
import type { IntelligenceObject } from "../types/object.js";
import type { KnowyConfig } from "../types/config.js";
import type { AskRequest, AskResponse, FreshnessMode, Tier } from "../types/responses.js";
import type {
  Clock, Embedder, InvalidateSelector, ObjectStore, RawEvidenceIndex,
  Synthesizer, SynthesisResult,
} from "../types/ports.js";
import { validateObject } from "../object/validate.js";
import { needsFingerprintCheck } from "../freshness/ttl.js";
import { diffEvidence } from "../freshness/diff.js";
import { planRefresh, type RefreshPlan } from "../freshness/planner.js";
import { passesCoverage } from "../gates/coverage.js";
import { aclUnion, isPermitted } from "../gates/permission.js";
import { baselineFromEvidence, computeSavings, estimateTokens } from "../accounting/savings.js";

export class FreshnessUnavailableError extends Error {}

export interface AcmDeps {
  index: RawEvidenceIndex;
  store: ObjectStore;
  synthesizer: Synthesizer;
  embedder: Embedder;
  config: KnowyConfig;
  clock: Clock;
  newId: () => string;
}

export class AgentContextManager {
  constructor(protected readonly deps: AcmDeps) {}

  async ask(req: AskRequest): Promise<AskResponse> {
    const { store, embedder, index, config, clock } = this.deps;
    const startedAt = clock.now().getTime();
    const requested: FreshnessMode = req.freshness ?? "verified";

    const qvec = (await embedder.embed([req.question]))[0];
    if (qvec === undefined) throw new Error("embedder returned no vector");

    const candidates =
      requested === "fresh"
        ? []
        : await store.searchSimilar(req.tenant_id, qvec, {
            topK: config.discovery_top_k,
            minScore: config.discovery_min_score,
            ...(req.tags === undefined ? {} : { tags: req.tags }),
          });

    for (const candidate of candidates) {
      const obj = candidate.object;
      if (!isPermitted({ object: obj, granted: req.granted_permissions, config }).pass) continue;
      if (!passesCoverage({ matchScore: candidate.score, object: obj, config }).pass) continue;

      const now = clock.now();
      let diff = null;
      if (needsFingerprintCheck({ object: obj, now, requested })) {
        try {
          const fps = await index.fingerprint(obj.evidence.map((e) => e.id));
          diff = diffEvidence(obj.evidence, fps);
        } catch (cause) {
          if (config.on_stale_error === "fail") {
            throw new FreshnessUnavailableError(`cannot verify freshness of ${obj.id}`, { cause });
          }
          return this.serve({
            object: obj, tier: "cached", stale: true, degraded: false,
            actualTokens: obj.accounting.serve_tokens, baselineIsEstimate: true, startedAt,
          });
        }
      }

      const plan = planRefresh({ object: obj, diff, now, requested, config });

      if (plan.tier === "cached") {
        return this.serve({
          object: obj, tier: "cached", stale: false, degraded: false,
          actualTokens: obj.accounting.serve_tokens, baselineIsEstimate: true, startedAt,
        });
      }
      if (plan.tier === "verified") {
        const at = now.toISOString();
        await store.markVerified(req.tenant_id, obj.id, at);
        return this.serve({
          object: { ...obj, last_verified_at: at }, tier: "verified", stale: false,
          degraded: false, actualTokens: obj.accounting.serve_tokens,
          baselineIsEstimate: true, startedAt,
        });
      }
      if (plan.tier === "patched") {
        return this.applyPatch({ object: obj, plan, req, qvec, startedAt });
      }
      return this.rebuild({ req, qvec, existing: obj, startedAt });
    }

    return this.rebuild({ req, qvec, existing: null, startedAt });
  }

  /**
   * Explicit refresh. `auto` still takes the cheap patch tier where it applies, so
   * "give me fresh data" is usually not a full re-synthesis (spec §7.2).
   */
  async refresh(input: {
    tenant_id: string;
    object_id: string;
    granted_permissions: string[];
    mode?: "auto" | "rebuild";
  }): Promise<AskResponse> {
    const { store, index, embedder, config, clock } = this.deps;
    const startedAt = clock.now().getTime();

    const object = await store.get(input.tenant_id, input.object_id);
    if (object === null) throw new Error(`object not found: ${input.object_id}`);

    const permission = isPermitted({ object, granted: input.granted_permissions, config });
    if (!permission.pass) throw new Error(`permission denied: ${permission.reason}`);

    const req: AskRequest = {
      tenant_id: input.tenant_id,
      question: object.canonical_question,
      granted_permissions: input.granted_permissions,
      ...(object.tags.length > 0 ? { tags: object.tags } : {}),
    };
    const qvec = (await embedder.embed([object.canonical_question]))[0];
    if (qvec === undefined) throw new Error("embedder returned no vector");

    if (input.mode === "rebuild") {
      return this.rebuild({ req, qvec, existing: object, startedAt });
    }

    const now = clock.now();
    let diff = null;
    try {
      const fps = await index.fingerprint(object.evidence.map((e) => e.id));
      diff = diffEvidence(object.evidence, fps);
    } catch (cause) {
      throw new FreshnessUnavailableError(`cannot verify freshness of ${object.id}`, { cause });
    }

    // An explicit refresh always verifies, so the invalidation flag has served its
    // purpose and must not force a rebuild on top of a clean diff.
    const plan = planRefresh({
      object: { ...object, invalidated_at: null }, diff, now, requested: "verified", config,
    });

    if (plan.tier === "verified") {
      const at = now.toISOString();
      await store.markVerified(input.tenant_id, object.id, at);
      return this.serve({
        object: { ...object, last_verified_at: at, invalidated_at: null },
        tier: "verified", stale: false, degraded: false,
        actualTokens: object.accounting.serve_tokens, baselineIsEstimate: true, startedAt,
      });
    }
    if (plan.tier === "patched") {
      return this.applyPatch({ object, plan, req, qvec, startedAt });
    }
    return this.rebuild({ req, qvec, existing: object, startedAt });
  }

  async invalidate(tenantId: string, selector: InvalidateSelector): Promise<number> {
    return this.deps.store.invalidate(tenantId, selector);
  }

  protected async rebuild(input: {
    req: AskRequest; qvec: number[]; existing: IntelligenceObject | null; startedAt: number;
  }): Promise<AskResponse> {
    const { req, qvec, existing, startedAt } = input;
    const { index, store, synthesizer, config, clock } = this.deps;

    const evidence = await index.search(
      { text: req.question, vector: qvec },
      {
        tenantId: req.tenant_id,
        topK: config.retrieval_k,
        granted: req.granted_permissions,
        ...(req.tags === undefined ? {} : { tags: req.tags }),
      },
    );
    const baseline = baselineFromEvidence(evidence);

    // No accessible evidence is a legitimate answer, not a failure. Synthesizing from
    // nothing would invent content, and storing it would violate the object invariants.
    if (evidence.length === 0) return this.serveEmpty(startedAt);

    let result: SynthesisResult;
    try {
      result = await synthesizer.build(req.question, evidence);
    } catch {
      return this.serveDegraded(evidence, baseline, startedAt);
    }

    const now = clock.now();
    const iso = now.toISOString();
    const object: IntelligenceObject = {
      id: existing?.id ?? this.deps.newId(),
      tenant_id: req.tenant_id,
      scope: "query",
      canonical_question: req.question,
      content: result.content,
      claims: result.claims,
      confidence: result.confidence,
      gaps: result.gaps,
      embedding: qvec,
      tags: req.tags ?? [],
      acl: aclUnion(evidence),
      acl_complete: index.capabilities().acl,
      evidence: evidence.map((e) => ({
        id: e.id, hash: e.content_hash, source_uri: e.source_uri, acl: e.acl, retrieved_at: iso,
      })),
      built_at: iso,
      last_verified_at: null,
      invalidated_at: null,
      ttl_seconds: config.default_ttl_seconds,
      version: (existing?.version ?? 0) + 1,
      supersedes: existing === null ? null : `${existing.id}@${existing.version}`,
      accounting: {
        build_tokens: result.tokens_used,
        baseline_tokens: baseline,
        serve_tokens: estimateTokens(result.content),
      },
    };

    validateObject(object);
    // A lost cache write must not fail the request (spec §14) — the answer is already good.
    await store.put(object).catch(() => undefined);
    return this.serve({
      object, tier: "rebuilt", stale: false, degraded: false,
      actualTokens: result.tokens_used + object.accounting.serve_tokens,
      baselineIsEstimate: false, startedAt,
    });
  }

  protected async applyPatch(input: {
    object: IntelligenceObject; plan: RefreshPlan; req: AskRequest;
    qvec: number[]; startedAt: number;
  }): Promise<AskResponse> {
    const { object, plan, req, qvec, startedAt } = input;
    const { index, store, synthesizer, clock } = this.deps;

    const changed = await index.fetch(plan.patchEvidenceIds);
    const returned = new Set(changed.map((e) => e.id));
    // Anything we asked for and did not get back is gone, whatever the fingerprint said.
    const removed = [
      ...plan.removedEvidenceIds,
      ...plan.patchEvidenceIds.filter((id) => !returned.has(id)),
    ];

    const kept = object.evidence.filter((r) => !removed.includes(r.id) && !returned.has(r.id));
    if (kept.length + changed.length === 0) {
      return this.rebuild({ req, qvec, existing: object, startedAt });
    }

    let result: SynthesisResult;
    try {
      result = await synthesizer.patch(object, changed, removed);
    } catch {
      return this.rebuild({ req, qvec, existing: object, startedAt });
    }

    const iso = clock.now().toISOString();
    const evidence = [
      ...kept,
      ...changed.map((e) => ({
        id: e.id, hash: e.content_hash, source_uri: e.source_uri, acl: e.acl, retrieved_at: iso,
      })),
    ];

    const next: IntelligenceObject = {
      ...object,
      content: result.content,
      claims: result.claims,
      confidence: result.confidence,
      gaps: result.gaps,
      acl: aclUnion(evidence),
      evidence,
      built_at: iso,
      last_verified_at: null,
      invalidated_at: null,
      version: object.version + 1,
      supersedes: `${object.id}@${object.version}`,
      accounting: {
        ...object.accounting,
        build_tokens: result.tokens_used,
        serve_tokens: estimateTokens(result.content),
      },
    };

    validateObject(next);
    await store.put(next).catch(() => undefined);
    return this.serve({
      object: next, tier: "patched", stale: false, degraded: false,
      actualTokens: result.tokens_used + next.accounting.serve_tokens,
      baselineIsEstimate: true, startedAt,
    });
  }

  protected serve(input: {
    object: IntelligenceObject; tier: Tier; stale: boolean; degraded: boolean;
    actualTokens: number; baselineIsEstimate: boolean; startedAt: number;
  }): AskResponse {
    const { object } = input;
    return {
      answer: {
        content: object.content,
        claims: object.claims,
        citations: object.evidence.map((e) => ({ evidence_id: e.id, source_uri: e.source_uri })),
      },
      object_id: object.id,
      object_version: object.version,
      tier: input.tier,
      stale: input.stale,
      degraded: input.degraded,
      confidence: object.confidence,
      gaps: object.gaps,
      savings: computeSavings({
        baselineTokens: object.accounting.baseline_tokens,
        actualTokens: input.actualTokens,
        baselineIsEstimate: input.baselineIsEstimate,
      }),
      latency_ms: this.deps.clock.now().getTime() - input.startedAt,
    };
  }

  /** Nothing in the index is both relevant and readable by this caller. */
  protected serveEmpty(startedAt: number): AskResponse {
    return {
      answer: { content: "", claims: [], citations: [] },
      object_id: "",
      object_version: 0,
      tier: "rebuilt",
      stale: false,
      degraded: false,
      confidence: 0,
      gaps: ["no evidence accessible to this caller"],
      savings: computeSavings({ baselineTokens: 0, actualTokens: 0, baselineIsEstimate: false }),
      latency_ms: this.deps.clock.now().getTime() - startedAt,
    };
  }

  /** Synthesis failed. Return raw evidence so the agent still works, clearly flagged. */
  protected serveDegraded(
    evidence: Evidence[],
    baseline: number,
    startedAt: number,
  ): AskResponse {
    return {
      answer: {
        content: evidence.map((e) => e.content).join("\n\n"),
        claims: [],
        citations: evidence.map((e) => ({ evidence_id: e.id, source_uri: e.source_uri })),
      },
      object_id: "",
      object_version: 0,
      tier: "rebuilt",
      stale: false,
      degraded: true,
      confidence: 0,
      gaps: ["synthesis unavailable; raw evidence returned"],
      savings: computeSavings({
        baselineTokens: baseline, actualTokens: baseline, baselineIsEstimate: false,
      }),
      latency_ms: this.deps.clock.now().getTime() - startedAt,
    };
  }
}

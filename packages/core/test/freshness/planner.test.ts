import { describe, it, expect } from "vitest";
import { planRefresh } from "../../src/freshness/planner.js";
import { diffEvidence } from "../../src/freshness/diff.js";
import { makeObject, makeEvidenceRef } from "../../src/testing/fixtures.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Fingerprint } from "../../src/types/evidence.js";

const fp = (id: string, hash: string): Fingerprint => ({ id, content_hash: hash, acl: [] });
const NOW = new Date("2026-09-12T00:30:00.000Z");
const config = DEFAULT_CONFIG;

const refs = ["a", "b", "c", "d", "e"].map((id) => makeEvidenceRef({ id, hash: `h-${id}` }));
const obj = makeObject({
  evidence: refs,
  claims: [],
  built_at: "2026-09-12T00:00:00.000Z",
  last_verified_at: null,
  ttl_seconds: 3600,
});

const allFresh = new Map(refs.map((r) => [r.id, fp(r.id, r.hash)]));

function diffWithChanged(ids: string[]) {
  const map = new Map(allFresh);
  for (const id of ids) map.set(id, fp(id, `${id}-v2`));
  return diffEvidence(refs, map);
}

describe("planRefresh", () => {
  it("rebuilds when the caller demands fresh, however clean the diff", () => {
    const plan = planRefresh({
      object: obj, diff: diffEvidence(refs, allFresh), now: NOW, requested: "fresh", config,
    });
    expect(plan.tier).toBe("rebuilt");
    expect(plan.reason).toMatch(/requested fresh/);
  });

  it("rebuilds when no candidate object was found", () => {
    const plan = planRefresh({ object: null, diff: null, now: NOW, requested: "verified", config });
    expect(plan.tier).toBe("rebuilt");
  });

  it("rebuilds an invalidated object even when every hash still matches", () => {
    const dead = makeObject({ ...obj, invalidated_at: "2026-09-12T00:10:00.000Z" });
    const plan = planRefresh({
      object: dead, diff: diffEvidence(refs, allFresh), now: NOW, requested: "verified", config,
    });
    expect(plan.tier).toBe("rebuilt");
    expect(plan.reason).toMatch(/invalidated/);
  });

  it("serves cached without a diff when cached mode is inside the TTL", () => {
    const plan = planRefresh({ object: obj, diff: null, now: NOW, requested: "cached", config });
    expect(plan.tier).toBe("cached");
  });

  it("verifies when nothing churned", () => {
    const plan = planRefresh({
      object: obj, diff: diffEvidence(refs, allFresh), now: NOW, requested: "verified", config,
    });
    expect(plan.tier).toBe("verified");
    expect(plan.patchEvidenceIds).toEqual([]);
  });

  it("verifies a TTL-expired object whose sources all still match", () => {
    const later = new Date("2026-09-12T09:00:00.000Z");
    const plan = planRefresh({
      object: obj, diff: diffEvidence(refs, allFresh), now: later, requested: "verified", config,
    });
    expect(plan.tier).toBe("verified");
  });

  it("patches when churn sits at or below the threshold", () => {
    const plan = planRefresh({
      object: obj, diff: diffWithChanged(["b", "c"]), now: NOW, requested: "verified", config,
    });
    expect(plan.tier).toBe("patched");
    expect(plan.patchEvidenceIds).toEqual(["b", "c"]);
  });

  it("rebuilds when churn exceeds the threshold", () => {
    const plan = planRefresh({
      object: obj, diff: diffWithChanged(["a", "b", "c"]), now: NOW, requested: "verified", config,
    });
    expect(plan.tier).toBe("rebuilt");
    expect(plan.reason).toMatch(/exceeds threshold/);
  });

  it("routes deleted evidence to removedEvidenceIds and unknown to the patch set", () => {
    const map = new Map<string, Fingerprint | null>(allFresh);
    map.set("a", null);
    map.delete("b");
    const plan = planRefresh({
      object: obj, diff: diffEvidence(refs, map), now: NOW, requested: "verified", config,
    });
    expect(plan.tier).toBe("patched");
    expect(plan.removedEvidenceIds).toEqual(["a"]);
    expect(plan.patchEvidenceIds).toEqual(["b"]);
  });

  it("rebuilds rather than guessing when a diff was required but absent", () => {
    const plan = planRefresh({ object: obj, diff: null, now: NOW, requested: "verified", config });
    expect(plan.tier).toBe("rebuilt");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { MemoryIndex } from "@knowy/index-memory";
import { MemoryObjectStore } from "@knowy/store-memory";
import { AgentContextManager, FreshnessUnavailableError } from "../../src/acm/context-manager.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { FakeClock, FakeEmbedder, FakeSynthesizer } from "./doubles.js";
import type { AskRequest } from "../../src/types/responses.js";

const QUESTION = "How long do refunds take?";

function evidence(id: string, acl: string[] = []) {
  return {
    evidence: {
      id, content: "x".repeat(2400), source_uri: `confluence://${id}`,
      content_hash: `h-${id}`, acl, score: 0,
    },
    embedding: [1, 0, 0],
  };
}

describe("AgentContextManager.ask", () => {
  let index: MemoryIndex;
  let store: MemoryObjectStore;
  let synthesizer: FakeSynthesizer;
  let embedder: FakeEmbedder;
  let clock: FakeClock;
  let acm: AgentContextManager;
  let seq: number;

  const req = (over: Partial<AskRequest> = {}): AskRequest => ({
    tenant_id: "acme", question: QUESTION, granted_permissions: ["group:support"], ...over,
  });

  beforeEach(async () => {
    index = new MemoryIndex();
    store = new MemoryObjectStore();
    synthesizer = new FakeSynthesizer();
    embedder = new FakeEmbedder();
    clock = new FakeClock(new Date("2026-09-12T00:00:00.000Z"));
    seq = 0;
    await index.seed("acme", [
      evidence("a", ["group:support"]),
      evidence("b", ["group:support"]),
      evidence("c", ["group:support"]),
      evidence("d", ["group:support"]),
      evidence("public", []),
    ]);
    acm = new AgentContextManager({
      index, store, synthesizer, embedder,
      config: DEFAULT_CONFIG, clock, newId: () => `obj-${++seq}`,
    });
  });

  it("rebuilds on a cold miss and stores the object", async () => {
    const res = await acm.ask(req());
    expect(res.tier).toBe("rebuilt");
    expect(synthesizer.buildCalls).toBe(1);
    expect(res.object_version).toBe(1);
    expect(await store.get("acme", res.object_id)).not.toBeNull();
  });

  it("serves the second identical question from the object store at zero LLM cost", async () => {
    await acm.ask(req());
    const res = await acm.ask(req());
    expect(res.tier).toBe("verified");
    expect(synthesizer.buildCalls).toBe(1);
    expect(res.savings.saved_tokens).toBeGreaterThan(0);
    expect(res.savings.baseline_is_estimate).toBe(true);
  });

  it("skips the index entirely in cached mode inside the TTL", async () => {
    await acm.ask(req());
    await index.failFor(["a", "b", "c", "d", "public"]);
    const res = await acm.ask(req({ freshness: "cached" }));
    expect(res.tier).toBe("cached");
  });

  it("patches when one source of five changed", async () => {
    await acm.ask(req());
    await index.setHash("a", "h-a-v2");
    const res = await acm.ask(req());
    expect(res.tier).toBe("patched");
    expect(synthesizer.patchCalls).toBe(1);
    expect(synthesizer.buildCalls).toBe(1);
    expect(res.object_version).toBe(2);
    const stored = await store.get("acme", res.object_id);
    expect(stored!.supersedes).toBe(`${res.object_id}@1`);
  });

  it("rebuilds when churn exceeds the threshold", async () => {
    await acm.ask(req());
    await index.setHash("a", "h-a-v2");
    await index.setHash("b", "h-b-v2");
    await index.setHash("c", "h-c-v2");
    const res = await acm.ask(req());
    expect(res.tier).toBe("rebuilt");
    expect(synthesizer.buildCalls).toBe(2);
    expect(res.object_version).toBe(2);
  });

  it("forces a rebuild when the caller asks for fresh", async () => {
    await acm.ask(req());
    const res = await acm.ask(req({ freshness: "fresh" }));
    expect(res.tier).toBe("rebuilt");
    expect(synthesizer.buildCalls).toBe(2);
  });

  it("never serves a cached object to a caller lacking its ACL tags", async () => {
    const privileged = await acm.ask(req());
    const res = await acm.ask(req({ granted_permissions: [] }));
    expect(res.tier).toBe("rebuilt");
    expect(synthesizer.buildCalls).toBe(2);
    // The unprivileged answer is a fresh object built only from public evidence.
    expect(res.object_id).not.toBe(privileged.object_id);
    const rebuilt = await store.get("acme", res.object_id);
    expect(rebuilt!.acl).toEqual([]);
    expect(rebuilt!.evidence.map((e) => e.id)).toEqual(["public"]);
  });

  it("returns an empty, zero-confidence answer when no evidence is accessible", async () => {
    const empty = await acm.ask({
      tenant_id: "empty-tenant", question: "anything", granted_permissions: [],
    });
    expect(empty.confidence).toBe(0);
    expect(empty.gaps[0]).toMatch(/no evidence/i);
    expect(empty.object_id).toBe("");
    expect(synthesizer.buildCalls).toBe(0);
  });

  it("serves stale rather than failing when freshness cannot be verified", async () => {
    await acm.ask(req());
    index.fingerprint = async () => { throw new Error("index down"); };
    const res = await acm.ask(req());
    expect(res.stale).toBe(true);
    expect(res.tier).toBe("cached");
  });

  it("fails instead when the tenant configured on_stale_error: fail", async () => {
    await acm.ask(req());
    index.fingerprint = async () => { throw new Error("index down"); };
    const strictAcm = new AgentContextManager({
      index, store, synthesizer, embedder, clock, newId: () => "obj-x",
      config: { ...DEFAULT_CONFIG, on_stale_error: "fail" },
    });
    await expect(strictAcm.ask(req())).rejects.toBeInstanceOf(FreshnessUnavailableError);
  });

  it("degrades to raw evidence when synthesis fails, and stores nothing", async () => {
    synthesizer.failBuild = true;
    const res = await acm.ask(req());
    expect(res.degraded).toBe(true);
    expect(res.confidence).toBe(0);
    expect(res.answer.content).toContain("x".repeat(100));
    expect(await store.searchSimilar("acme", [1, 0, 0], { topK: 5, minScore: 0 })).toHaveLength(0);
  });

  it("still answers when the object store write fails", async () => {
    store.put = async () => { throw new Error("store down"); };
    const res = await acm.ask(req());
    expect(res.tier).toBe("rebuilt");
    expect(res.degraded).toBe(false);
    expect(res.answer.content).toContain("digest of");
  });

  it("does not serve an object whose confidence is below the gate", async () => {
    synthesizer.confidence = 0.3;
    await acm.ask(req());
    const res = await acm.ask(req());
    expect(res.tier).toBe("rebuilt");
    expect(synthesizer.buildCalls).toBe(2);
  });

  it("reports a verify hit as saving the whole baseline minus the digest", async () => {
    const cold = await acm.ask(req());
    const warm = await acm.ask(req());
    expect(warm.savings.baseline_tokens).toBe(cold.savings.baseline_tokens);
    expect(warm.savings.actual_tokens).toBeLessThan(cold.savings.actual_tokens);
  });
});

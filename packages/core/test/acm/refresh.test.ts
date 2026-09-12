import { describe, it, expect, beforeEach } from "vitest";
import { MemoryIndex } from "@knowy/index-memory";
import { MemoryObjectStore } from "@knowy/store-memory";
import { AgentContextManager } from "../../src/acm/context-manager.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { FakeClock, FakeEmbedder, FakeSynthesizer } from "./doubles.js";

const QUESTION = "How long do refunds take?";

function evidence(id: string) {
  return {
    evidence: {
      id, content: "x".repeat(2400), source_uri: `confluence://${id}`,
      content_hash: `h-${id}`, acl: ["group:support"], score: 0,
    },
    embedding: [1, 0, 0],
  };
}

describe("AgentContextManager.refresh and .invalidate", () => {
  let index: MemoryIndex;
  let store: MemoryObjectStore;
  let synthesizer: FakeSynthesizer;
  let acm: AgentContextManager;
  let objectId: string;

  const ask = { tenant_id: "acme", question: QUESTION, granted_permissions: ["group:support"] };

  beforeEach(async () => {
    index = new MemoryIndex();
    store = new MemoryObjectStore();
    synthesizer = new FakeSynthesizer();
    await index.seed("acme", [evidence("a"), evidence("b"), evidence("c"), evidence("d")]);
    acm = new AgentContextManager({
      index, store, synthesizer, embedder: new FakeEmbedder(),
      config: DEFAULT_CONFIG, clock: new FakeClock(new Date("2026-09-12T00:00:00.000Z")),
      newId: () => "obj-1",
    });
    objectId = (await acm.ask(ask)).object_id;
  });

  it("refresh in auto mode uses the cheap patch tier when only one source moved", async () => {
    await index.setHash("a", "h-a-v2");
    const res = await acm.refresh({
      tenant_id: "acme", object_id: objectId, granted_permissions: ["group:support"],
    });
    expect(res.tier).toBe("patched");
    expect(synthesizer.buildCalls).toBe(1);
  });

  it("refresh in auto mode still reports verified when nothing changed", async () => {
    const res = await acm.refresh({
      tenant_id: "acme", object_id: objectId, granted_permissions: ["group:support"],
    });
    expect(res.tier).toBe("verified");
    expect(synthesizer.patchCalls).toBe(0);
  });

  it("refresh in rebuild mode always pays for a full synthesis", async () => {
    const res = await acm.refresh({
      tenant_id: "acme", object_id: objectId,
      granted_permissions: ["group:support"], mode: "rebuild",
    });
    expect(res.tier).toBe("rebuilt");
    expect(synthesizer.buildCalls).toBe(2);
  });

  it("refresh refuses an object the caller may not read", async () => {
    await expect(
      acm.refresh({ tenant_id: "acme", object_id: objectId, granted_permissions: [] }),
    ).rejects.toThrow(/permission/i);
  });

  it("refresh throws on an unknown object id", async () => {
    await expect(
      acm.refresh({ tenant_id: "acme", object_id: "nope", granted_permissions: [] }),
    ).rejects.toThrow(/not found/i);
  });

  it("an invalidated object rebuilds on the next ask even though every hash matches", async () => {
    expect(await acm.invalidate("acme", { ids: [objectId] })).toBe(1);
    const res = await acm.ask(ask);
    expect(res.tier).toBe("rebuilt");
    expect(synthesizer.buildCalls).toBe(2);
  });

  it("invalidating by source uri reaches objects built from that source", async () => {
    expect(await acm.invalidate("acme", { source_uris: ["confluence://a"] })).toBe(1);
  });
});

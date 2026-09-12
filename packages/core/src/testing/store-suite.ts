import { describe, it, expect, beforeEach } from "vitest";
import type { ObjectStore } from "../index.js";
import { makeObject } from "./fixtures.js";

export function runStoreConformance(
  name: string,
  createStore: () => Promise<ObjectStore>,
): void {
  describe(`ObjectStore conformance: ${name}`, () => {
    let store: ObjectStore;

    beforeEach(async () => {
      store = await createStore();
    });

    it("round-trips an object", async () => {
      const obj = makeObject({ id: "o1" });
      await store.put(obj);
      expect((await store.get("acme", "o1"))!.content).toBe(obj.content);
    });

    it("returns null for an unknown id", async () => {
      expect(await store.get("acme", "missing")).toBeNull();
    });

    it("never returns another tenant's object", async () => {
      await store.put(makeObject({ id: "o1", tenant_id: "acme" }));
      expect(await store.get("other", "o1")).toBeNull();
    });

    it("returns the latest version when no version is requested", async () => {
      await store.put(makeObject({ id: "o1", version: 1, content: "v1" }));
      await store.put(makeObject({ id: "o1", version: 2, content: "v2" }));
      expect((await store.get("acme", "o1"))!.content).toBe("v2");
    });

    it("reads an explicit historical version", async () => {
      await store.put(makeObject({ id: "o1", version: 1, content: "v1" }));
      await store.put(makeObject({ id: "o1", version: 2, content: "v2" }));
      expect((await store.get("acme", "o1", 1))!.content).toBe("v1");
    });

    it("orders similarity results by descending score", async () => {
      await store.put(makeObject({ id: "near", embedding: [1, 0, 0] }));
      await store.put(makeObject({ id: "far", embedding: [0.6, 0.8, 0] }));
      const out = await store.searchSimilar("acme", [1, 0, 0], { topK: 5, minScore: 0 });
      expect(out.map((s) => s.object.id)).toEqual(["near", "far"]);
    });

    it("drops candidates below minScore", async () => {
      await store.put(makeObject({ id: "orthogonal", embedding: [0, 1, 0] }));
      const out = await store.searchSimilar("acme", [1, 0, 0], { topK: 5, minScore: 0.5 });
      expect(out).toHaveLength(0);
    });

    it("respects topK", async () => {
      await store.put(makeObject({ id: "a", embedding: [1, 0, 0] }));
      await store.put(makeObject({ id: "b", embedding: [0.99, 0.01, 0] }));
      const out = await store.searchSimilar("acme", [1, 0, 0], { topK: 1, minScore: 0 });
      expect(out).toHaveLength(1);
    });

    it("returns only the latest version from similarity search", async () => {
      await store.put(makeObject({ id: "o1", version: 1, embedding: [1, 0, 0] }));
      await store.put(makeObject({ id: "o1", version: 2, embedding: [1, 0, 0] }));
      const out = await store.searchSimilar("acme", [1, 0, 0], { topK: 5, minScore: 0 });
      expect(out).toHaveLength(1);
      expect(out[0]!.object.version).toBe(2);
    });

    it("invalidates by id and reports how many objects it touched", async () => {
      await store.put(makeObject({ id: "o1" }));
      expect(await store.invalidate("acme", { ids: ["o1"] })).toBe(1);
      expect((await store.get("acme", "o1"))!.invalidated_at).not.toBeNull();
    });

    it("invalidates by tag", async () => {
      await store.put(makeObject({ id: "o1", tags: ["policy"] }));
      await store.put(makeObject({ id: "o2", tags: ["pricing"] }));
      expect(await store.invalidate("acme", { tags: ["policy"] })).toBe(1);
      expect((await store.get("acme", "o2"))!.invalidated_at).toBeNull();
    });

    it("invalidates by source uri", async () => {
      await store.put(makeObject({ id: "o1" }));
      expect(await store.invalidate("acme", { source_uris: ["confluence://policies/refunds"] })).toBe(1);
    });

    it("markVerified extends the freshness window without creating a version", async () => {
      await store.put(makeObject({ id: "o1", version: 1 }));
      await store.markVerified("acme", "o1", "2026-09-13T00:00:00.000Z");
      const got = (await store.get("acme", "o1"))!;
      expect(got.last_verified_at).toBe("2026-09-13T00:00:00.000Z");
      expect(got.version).toBe(1);
    });
  });
}

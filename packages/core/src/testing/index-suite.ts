import { describe, it, expect, beforeEach } from "vitest";
import type { Evidence, RawEvidenceIndex } from "../index.js";

export interface IndexRecord {
  evidence: Evidence;
  embedding: number[];
}

export interface IndexHarness {
  index: RawEvidenceIndex;
  seed(tenantId: string, records: IndexRecord[]): Promise<void>;
  setHash(id: string, hash: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Make fingerprint() omit these ids, simulating a partial failure. */
  failFor(ids: string[]): Promise<void>;
}

const ev = (id: string, content: string, acl: string[] = []): Evidence => ({
  id, content, source_uri: `test://${id}`, content_hash: `h-${id}`, acl, score: 0,
});

export function runIndexConformance(
  name: string,
  createHarness: () => Promise<IndexHarness>,
): void {
  describe(`RawEvidenceIndex conformance: ${name}`, () => {
    let h: IndexHarness;

    beforeEach(async () => {
      h = await createHarness();
      await h.seed("acme", [
        { evidence: ev("a", "alpha"), embedding: [1, 0, 0] },
        { evidence: ev("b", "beta"), embedding: [0.9, 0.1, 0] },
        { evidence: ev("c", "gamma", ["group:finance"]), embedding: [0, 1, 0] },
      ]);
      await h.seed("other", [{ evidence: ev("z", "zeta"), embedding: [1, 0, 0] }]);
    });

    it("returns results ordered by descending score", async () => {
      const out = await h.index.search(
        { text: "alpha", vector: [1, 0, 0] },
        { tenantId: "acme", topK: 3 },
      );
      expect(out.map((e) => e.id)).toEqual(["a", "b", "c"]);
      expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
    });

    it("respects topK", async () => {
      const out = await h.index.search(
        { text: "alpha", vector: [1, 0, 0] },
        { tenantId: "acme", topK: 2 },
      );
      expect(out).toHaveLength(2);
    });

    it("never returns another tenant's evidence", async () => {
      const out = await h.index.search(
        { text: "zeta", vector: [1, 0, 0] },
        { tenantId: "acme", topK: 10 },
      );
      expect(out.map((e) => e.id)).not.toContain("z");
    });

    it("filters by caller permissions when granted is supplied", async () => {
      const out = await h.index.search(
        { text: "gamma", vector: [0, 1, 0] },
        { tenantId: "acme", topK: 10, granted: [] },
      );
      expect(out.map((e) => e.id)).not.toContain("c");
    });

    it("fetches evidence by id", async () => {
      const out = await h.index.fetch(["a", "c"]);
      expect(out.map((e) => e.id).sort()).toEqual(["a", "c"]);
      expect(out.find((e) => e.id === "a")!.content).toBe("alpha");
    });

    it("omits ids from fetch that no longer exist", async () => {
      await h.remove("a");
      expect(await h.index.fetch(["a", "b"])).toHaveLength(1);
    });

    it("fingerprints known ids with their current hash", async () => {
      const fps = await h.index.fingerprint(["a", "b"]);
      expect(fps.get("a")!.content_hash).toBe("h-a");
    });

    it("reflects a hash change in the fingerprint", async () => {
      await h.setHash("a", "h-a-v2");
      const fps = await h.index.fingerprint(["a"]);
      expect(fps.get("a")!.content_hash).toBe("h-a-v2");
    });

    it("maps a removed id to null, meaning known-gone", async () => {
      await h.remove("b");
      const fps = await h.index.fingerprint(["b"]);
      expect(fps.has("b")).toBe(true);
      expect(fps.get("b")).toBeNull();
    });

    it("maps an id that never existed to null as well", async () => {
      const fps = await h.index.fingerprint(["never"]);
      expect(fps.get("never")).toBeNull();
    });

    it("omits the key entirely when it cannot answer, meaning unknown", async () => {
      await h.failFor(["a"]);
      const fps = await h.index.fingerprint(["a", "b"]);
      expect(fps.has("a")).toBe(false);
      expect(fps.has("b")).toBe(true);
    });

    it("declares its capabilities", async () => {
      const caps = h.index.capabilities();
      expect(typeof caps.acl).toBe("boolean");
      expect(["native", "derived"]).toContain(caps.hashing);
    });
  });
}

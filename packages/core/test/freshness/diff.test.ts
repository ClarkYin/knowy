import { describe, it, expect } from "vitest";
import { diffEvidence } from "../../src/freshness/diff.js";
import { makeEvidenceRef } from "../../src/testing/fixtures.js";
import type { Fingerprint } from "../../src/types/evidence.js";

const fp = (id: string, hash: string): Fingerprint => ({ id, content_hash: hash, acl: [] });

const refs = [
  makeEvidenceRef({ id: "a", hash: "h-a" }),
  makeEvidenceRef({ id: "b", hash: "h-b" }),
  makeEvidenceRef({ id: "c", hash: "h-c" }),
  makeEvidenceRef({ id: "d", hash: "h-d" }),
];

describe("diffEvidence", () => {
  it("reports zero churn when every hash still matches", () => {
    const result = diffEvidence(refs, new Map(refs.map((r) => [r.id, fp(r.id, r.hash)])));
    expect(result.unchanged).toEqual(["a", "b", "c", "d"]);
    expect(result.churnRatio).toBe(0);
  });

  it("classifies a differing hash as changed", () => {
    const map = new Map(refs.map((r) => [r.id, fp(r.id, r.hash)]));
    map.set("b", fp("b", "h-b-v2"));
    const result = diffEvidence(refs, map);
    expect(result.changed).toEqual(["b"]);
    expect(result.churnRatio).toBe(0.25);
  });

  it("classifies an explicit null as deleted", () => {
    const map = new Map<string, Fingerprint | null>(refs.map((r) => [r.id, fp(r.id, r.hash)]));
    map.set("c", null);
    const result = diffEvidence(refs, map);
    expect(result.deleted).toEqual(["c"]);
    expect(result.churnRatio).toBe(0.25);
  });

  it("classifies a missing entry as unknown and counts it toward churn (spec §7.3)", () => {
    const map = new Map(refs.filter((r) => r.id !== "d").map((r) => [r.id, fp(r.id, r.hash)]));
    const result = diffEvidence(refs, map);
    expect(result.unknown).toEqual(["d"]);
    expect(result.unchanged).toEqual(["a", "b", "c"]);
    expect(result.churnRatio).toBe(0.25);
  });

  it("sums changed, deleted, and unknown into one churn ratio", () => {
    const map = new Map<string, Fingerprint | null>([
      ["a", fp("a", "h-a")],
      ["b", fp("b", "h-b-v2")],
      ["c", null],
    ]);
    const result = diffEvidence(refs, map);
    expect(result.total).toBe(4);
    expect(result.churnRatio).toBe(0.75);
  });

  it("treats an empty evidence set as fully churned rather than fully fresh", () => {
    expect(diffEvidence([], new Map()).churnRatio).toBe(1);
  });
});

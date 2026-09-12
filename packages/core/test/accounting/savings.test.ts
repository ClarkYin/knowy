import { describe, it, expect } from "vitest";
import { computeSavings, estimateTokens, baselineFromEvidence } from "../../src/accounting/savings.js";
import { makeEvidence } from "../../src/testing/fixtures.js";

describe("estimateTokens", () => {
  it("approximates four characters per token, rounding up", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("is zero for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("baselineFromEvidence", () => {
  it("sums the token cost of every raw chunk a naive retrieval would have sent", () => {
    const evidence = [
      makeEvidence({ id: "a", content: "x".repeat(400) }),
      makeEvidence({ id: "b", content: "x".repeat(800) }),
    ];
    expect(baselineFromEvidence(evidence)).toBe(300);
  });
});

describe("computeSavings", () => {
  it("reports the difference when serving is cheaper than raw retrieval", () => {
    const s = computeSavings({ baselineTokens: 4800, actualTokens: 400, baselineIsEstimate: true });
    expect(s.saved_tokens).toBe(4400);
    expect(s.baseline_is_estimate).toBe(true);
  });

  it("clamps to zero on a rebuild, which legitimately costs more than the baseline", () => {
    const s = computeSavings({ baselineTokens: 4800, actualTokens: 6000, baselineIsEstimate: false });
    expect(s.saved_tokens).toBe(0);
    expect(s.actual_tokens).toBe(6000);
  });

  it("counts a zero-token verify hit as saving the entire baseline", () => {
    const s = computeSavings({ baselineTokens: 4800, actualTokens: 0, baselineIsEstimate: true });
    expect(s.saved_tokens).toBe(4800);
  });
});

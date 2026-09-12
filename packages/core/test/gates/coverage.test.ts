import { describe, it, expect } from "vitest";
import { passesCoverage } from "../../src/gates/coverage.js";
import { makeObject } from "../../src/testing/fixtures.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";

const config = DEFAULT_CONFIG; // match_threshold 0.86, min_confidence 0.6

describe("passesCoverage", () => {
  it("passes when similarity and confidence both clear their thresholds", () => {
    const result = passesCoverage({
      matchScore: 0.91, object: makeObject({ confidence: 0.8 }), config,
    });
    expect(result.pass).toBe(true);
  });

  it("passes exactly at both thresholds", () => {
    const result = passesCoverage({
      matchScore: 0.86, object: makeObject({ confidence: 0.6 }), config,
    });
    expect(result.pass).toBe(true);
  });

  it("fails a near-miss similarity, naming the score and threshold", () => {
    const result = passesCoverage({
      matchScore: 0.85, object: makeObject({ confidence: 0.9 }), config,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("0.85");
    expect(result.reason).toContain("0.86");
  });

  it("fails a well-matched question when the object itself is low confidence", () => {
    const result = passesCoverage({
      matchScore: 0.99, object: makeObject({ confidence: 0.4 }), config,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/confidence/);
  });

  it("honours a caller-tuned threshold rather than the default", () => {
    const lenient = { ...config, match_threshold: 0.7 };
    const result = passesCoverage({
      matchScore: 0.75, object: makeObject({ confidence: 0.9 }), config: lenient,
    });
    expect(result.pass).toBe(true);
  });
});

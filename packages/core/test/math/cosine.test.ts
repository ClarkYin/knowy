import { describe, it, expect } from "vitest";
import { cosine } from "../../src/math/cosine.js";

describe("cosine", () => {
  it("is 1 for identical vectors", () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("ignores magnitude", () => {
    expect(cosine([2, 0], [8, 0])).toBeCloseTo(1);
  });

  it("is 0 when either vector is all zeros rather than dividing by zero", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it("throws on a dimension mismatch rather than silently truncating", () => {
    expect(() => cosine([1, 2], [1, 2, 3])).toThrow(/dimension/);
  });
});

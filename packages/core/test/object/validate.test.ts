import { describe, it, expect } from "vitest";
import { validateObject } from "../../src/object/validate.js";
import { makeObject } from "../../src/testing/fixtures.js";

describe("validateObject", () => {
  it("accepts a well-formed object", () => {
    expect(() => validateObject(makeObject())).not.toThrow();
  });

  it("rejects confidence outside 0..1", () => {
    expect(() => validateObject(makeObject({ confidence: 1.4 }))).toThrow(/confidence/);
    expect(() => validateObject(makeObject({ confidence: -0.1 }))).toThrow(/confidence/);
  });

  it("rejects an empty evidence set — an object with no evidence can never be verified", () => {
    expect(() => validateObject(makeObject({ evidence: [] }))).toThrow(/evidence/);
  });

  it("rejects a claim citing an evidence id the object does not hold", () => {
    const obj = makeObject({
      claims: [{ text: "unsupported", evidence_ids: ["not-in-evidence"] }],
    });
    expect(() => validateObject(obj)).toThrow(/not-in-evidence/);
  });

  it("rejects version below 1", () => {
    expect(() => validateObject(makeObject({ version: 0 }))).toThrow(/version/);
  });

  it("rejects an empty embedding", () => {
    expect(() => validateObject(makeObject({ embedding: [] }))).toThrow(/embedding/);
  });
});

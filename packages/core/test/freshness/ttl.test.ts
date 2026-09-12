import { describe, it, expect } from "vitest";
import { freshUntil, isWithinTtl, needsFingerprintCheck } from "../../src/freshness/ttl.js";
import { makeObject } from "../../src/testing/fixtures.js";

const BUILT = "2026-09-12T00:00:00.000Z";

describe("freshUntil", () => {
  it("measures from built_at when the object has never been verified", () => {
    const obj = makeObject({ built_at: BUILT, last_verified_at: null, ttl_seconds: 3600 });
    expect(freshUntil(obj).toISOString()).toBe("2026-09-12T01:00:00.000Z");
  });

  it("measures from last_verified_at once a verify hit has extended the window", () => {
    const obj = makeObject({
      built_at: BUILT,
      last_verified_at: "2026-09-12T05:00:00.000Z",
      ttl_seconds: 3600,
    });
    expect(freshUntil(obj).toISOString()).toBe("2026-09-12T06:00:00.000Z");
  });
});

describe("isWithinTtl", () => {
  const obj = makeObject({ built_at: BUILT, last_verified_at: null, ttl_seconds: 3600 });

  it("is true before expiry", () => {
    expect(isWithinTtl(obj, new Date("2026-09-12T00:59:59.000Z"))).toBe(true);
  });

  it("is false at and after expiry", () => {
    expect(isWithinTtl(obj, new Date("2026-09-12T01:00:00.000Z"))).toBe(false);
    expect(isWithinTtl(obj, new Date("2026-09-12T02:00:00.000Z"))).toBe(false);
  });
});

describe("needsFingerprintCheck", () => {
  const now = new Date("2026-09-12T00:30:00.000Z");
  const obj = makeObject({ built_at: BUILT, last_verified_at: null, ttl_seconds: 3600 });

  it("is false when there is no candidate object — a rebuild is already implied", () => {
    expect(needsFingerprintCheck({ object: null, now, requested: "verified" })).toBe(false);
  });

  it("is false when the caller demanded fresh — a rebuild is already implied", () => {
    expect(needsFingerprintCheck({ object: obj, now, requested: "fresh" })).toBe(false);
  });

  it("is false when the object was explicitly invalidated — a rebuild is already implied", () => {
    const dead = makeObject({ ...obj, invalidated_at: "2026-09-12T00:10:00.000Z" });
    expect(needsFingerprintCheck({ object: dead, now, requested: "verified" })).toBe(false);
  });

  it("is false in cached mode while the object is within its TTL", () => {
    expect(needsFingerprintCheck({ object: obj, now, requested: "cached" })).toBe(false);
  });

  it("is true in cached mode once the TTL has lapsed", () => {
    const later = new Date("2026-09-12T02:00:00.000Z");
    expect(needsFingerprintCheck({ object: obj, now: later, requested: "cached" })).toBe(true);
  });

  it("is true in verified mode even inside the TTL", () => {
    expect(needsFingerprintCheck({ object: obj, now, requested: "verified" })).toBe(true);
  });
});

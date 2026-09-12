import type { IntelligenceObject } from "../types/object.js";
import type { FreshnessMode } from "../types/responses.js";

/** Effective expiry: a verify hit extends the window without a new version (spec §11). */
export function freshUntil(obj: IntelligenceObject): Date {
  const base = new Date(obj.last_verified_at ?? obj.built_at);
  return new Date(base.getTime() + obj.ttl_seconds * 1000);
}

export function isWithinTtl(obj: IntelligenceObject, now: Date): boolean {
  return now.getTime() < freshUntil(obj).getTime();
}

/**
 * Whether the caller must pay for an index round-trip. False whenever the outcome is
 * already determined — no object, a forced rebuild, an invalidation, or a cached-mode
 * request still inside its TTL.
 */
export function needsFingerprintCheck(input: {
  object: IntelligenceObject | null;
  now: Date;
  requested: FreshnessMode;
}): boolean {
  const { object, now, requested } = input;
  if (object === null) return false;
  if (requested === "fresh") return false;
  if (object.invalidated_at !== null) return false;
  if (requested === "cached") return !isWithinTtl(object, now);
  return true;
}

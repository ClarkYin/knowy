import type { IntelligenceObject } from "../types/object.js";
import type { KnowyConfig } from "../types/config.js";
import type { GateResult } from "./result.js";

/** The ACL tags an object inherits from the evidence it was synthesized from (spec §8). */
export function aclUnion(evidence: readonly { acl: string[] }[]): string[] {
  return [...new Set(evidence.flatMap((e) => e.acl))].sort();
}

/**
 * Stops the object store becoming a permission-laundering machine (spec §8).
 * Conservative by construction: a caller with narrower permissions than the object's
 * evidence union gets a miss and a correctly-scoped rebuild. It can cause extra
 * misses; it cannot leak.
 */
export function isPermitted(input: {
  object: IntelligenceObject;
  granted: readonly string[];
  config: KnowyConfig;
}): GateResult {
  const { object, granted, config } = input;

  if (config.acl_mode === "tenant_only") {
    return { pass: true, reason: "acl_mode is tenant_only; tenant partition is the only boundary" };
  }
  if (!object.acl_complete) {
    return {
      pass: false,
      reason: "acl_complete is false and acl_mode is strict; the index could not report ACLs",
    };
  }
  const grantedSet = new Set(granted);
  const missing = object.acl.filter((tag) => !grantedSet.has(tag));
  if (missing.length > 0) {
    return { pass: false, reason: `caller is missing required acl tags: ${missing.join(", ")}` };
  }
  return { pass: true, reason: "caller holds every required acl tag" };
}

import type { IntelligenceObject } from "../types/object.js";
import type { KnowyConfig } from "../types/config.js";
import type { FreshnessMode, Tier } from "../types/responses.js";
import type { EvidenceDiff } from "./diff.js";
import { isWithinTtl } from "./ttl.js";

export interface RefreshPlan {
  tier: Tier;
  reason: string;
  /** Evidence to re-fetch and feed to Synthesizer.patch. */
  patchEvidenceIds: string[];
  /** Evidence that no longer exists and must be dropped from the object. */
  removedEvidenceIds: string[];
}

const NO_EVIDENCE = { patchEvidenceIds: [], removedEvidenceIds: [] };

/** Selects the cheapest tier that is still correct (spec §7). */
export function planRefresh(input: {
  object: IntelligenceObject | null;
  diff: EvidenceDiff | null;
  now: Date;
  requested: FreshnessMode;
  config: KnowyConfig;
}): RefreshPlan {
  const { object, diff, now, requested, config } = input;

  if (requested === "fresh") {
    return { tier: "rebuilt", reason: "caller requested fresh", ...NO_EVIDENCE };
  }
  if (object === null) {
    return { tier: "rebuilt", reason: "no candidate object", ...NO_EVIDENCE };
  }
  if (object.invalidated_at !== null) {
    return { tier: "rebuilt", reason: "object was invalidated", ...NO_EVIDENCE };
  }
  if (requested === "cached" && isWithinTtl(object, now)) {
    return { tier: "cached", reason: "within ttl, fingerprint check skipped", ...NO_EVIDENCE };
  }
  if (diff === null) {
    return { tier: "rebuilt", reason: "freshness could not be verified", ...NO_EVIDENCE };
  }
  if (diff.churnRatio === 0) {
    return { tier: "verified", reason: "all sources unchanged", ...NO_EVIDENCE };
  }
  if (diff.churnRatio <= config.churn_threshold) {
    return {
      tier: "patched",
      reason: `churn ${diff.churnRatio.toFixed(2)} within threshold ${config.churn_threshold}`,
      // Unknown fingerprints are re-fetched alongside known changes — fail-safe.
      patchEvidenceIds: [...diff.changed, ...diff.unknown],
      removedEvidenceIds: [...diff.deleted],
    };
  }
  return {
    tier: "rebuilt",
    reason: `churn ${diff.churnRatio.toFixed(2)} exceeds threshold ${config.churn_threshold}`,
    ...NO_EVIDENCE,
  };
}

import type { IntelligenceObject } from "../types/object.js";
import type { KnowyConfig } from "../types/config.js";
import type { GateResult } from "./result.js";

/**
 * Decides whether a discovered object actually answers the question asked.
 * A false hit — serving an object that does not — is the system's most damaging
 * failure mode (spec §15), so both signals must clear their thresholds.
 */
export function passesCoverage(input: {
  matchScore: number;
  object: IntelligenceObject;
  config: KnowyConfig;
}): GateResult {
  const { matchScore, object, config } = input;

  if (matchScore < config.match_threshold) {
    return {
      pass: false,
      reason: `match score ${matchScore} below match_threshold ${config.match_threshold}`,
    };
  }
  if (object.confidence < config.min_confidence) {
    return {
      pass: false,
      reason: `object confidence ${object.confidence} below min_confidence ${config.min_confidence}`,
    };
  }
  return { pass: true, reason: "coverage satisfied" };
}

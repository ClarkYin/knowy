import type { Evidence } from "../types/evidence.js";
import type { Savings } from "../types/responses.js";

/**
 * Provider-agnostic approximation at roughly four characters per token. Adapters that
 * receive real usage numbers from their provider should report those instead; this is
 * the fallback used for baselines, which are counterfactual and therefore never
 * measurable directly.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** What a naive top-k raw-chunk retrieval would have cost the agent's context window. */
export function baselineFromEvidence(evidence: readonly Evidence[]): number {
  return evidence.reduce((sum, e) => sum + estimateTokens(e.content), 0);
}

export function computeSavings(input: {
  baselineTokens: number;
  actualTokens: number;
  baselineIsEstimate: boolean;
}): Savings {
  const { baselineTokens, actualTokens, baselineIsEstimate } = input;
  return {
    baseline_tokens: baselineTokens,
    actual_tokens: actualTokens,
    // A rebuild pays retrieval and synthesis, so it can exceed the baseline. Reporting
    // a negative saving would be noise; the value shows up on subsequent hits instead.
    saved_tokens: Math.max(0, baselineTokens - actualTokens),
    baseline_is_estimate: baselineIsEstimate,
  };
}

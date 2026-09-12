import type { EvidenceRef, Fingerprint } from "../types/evidence.js";

export interface EvidenceDiff {
  unchanged: string[];
  changed: string[];
  deleted: string[];
  /** Fingerprint lookup returned nothing. Counted as churn — fail-safe (spec §7.3). */
  unknown: string[];
  total: number;
  churnRatio: number;
}

export function diffEvidence(
  refs: readonly EvidenceRef[],
  fingerprints: ReadonlyMap<string, Fingerprint | null>,
): EvidenceDiff {
  const unchanged: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  const unknown: string[] = [];

  for (const ref of refs) {
    if (!fingerprints.has(ref.id)) {
      unknown.push(ref.id);
      continue;
    }
    const found = fingerprints.get(ref.id);
    if (found === null || found === undefined) {
      deleted.push(ref.id);
    } else if (found.content_hash !== ref.hash) {
      changed.push(ref.id);
    } else {
      unchanged.push(ref.id);
    }
  }

  const total = refs.length;
  const churned = changed.length + deleted.length + unknown.length;
  return {
    unchanged,
    changed,
    deleted,
    unknown,
    total,
    // An object with no evidence can never be verified, so it is never fresh.
    churnRatio: total === 0 ? 1 : churned / total,
  };
}

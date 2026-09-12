import type { IntelligenceObject } from "../types/object.js";

export class ObjectInvariantError extends Error {}

export function validateObject(obj: IntelligenceObject): void {
  if (obj.confidence < 0 || obj.confidence > 1) {
    throw new ObjectInvariantError(`confidence must be within 0..1, got ${obj.confidence}`);
  }
  if (obj.evidence.length === 0) {
    throw new ObjectInvariantError("evidence must not be empty; freshness would be unverifiable");
  }
  if (obj.embedding.length === 0) {
    throw new ObjectInvariantError("embedding must not be empty; the object would be undiscoverable");
  }
  if (obj.version < 1) {
    throw new ObjectInvariantError(`version must be >= 1, got ${obj.version}`);
  }
  const known = new Set(obj.evidence.map((e) => e.id));
  for (const claim of obj.claims) {
    for (const id of claim.evidence_ids) {
      if (!known.has(id)) {
        throw new ObjectInvariantError(`claim cites unknown evidence id: ${id}`);
      }
    }
  }
}

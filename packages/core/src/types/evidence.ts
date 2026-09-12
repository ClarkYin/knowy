export interface Fingerprint {
  id: string;
  content_hash: string;
  acl: string[];
}

export interface Evidence {
  id: string;
  content: string;
  source_uri: string;
  content_hash: string;
  acl: string[];
  score: number;
}

export interface EvidenceRef {
  id: string;
  hash: string;
  source_uri: string;
  acl: string[];
  retrieved_at: string;
}

export interface SearchQuery {
  text: string;
  vector: number[];
}

export interface SearchOpts {
  tenantId: string;
  topK: number;
  tags?: string[];
  /** Caller permissions. The index must return only evidence these tags allow (spec §8). */
  granted?: readonly string[];
}

export interface IndexCapabilities {
  acl: boolean;
  hashing: "native" | "derived";
}

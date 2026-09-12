export interface KnowyConfig {
  match_threshold: number;
  discovery_top_k: number;
  discovery_min_score: number;
  min_confidence: number;
  churn_threshold: number;
  default_ttl_seconds: number;
  retrieval_k: number;
  acl_mode: "strict" | "tenant_only";
  on_stale_error: "serve_stale" | "fail";
  superseded_retention_days: number;
}

export const DEFAULT_CONFIG: KnowyConfig = {
  match_threshold: 0.86,
  discovery_top_k: 5,
  discovery_min_score: 0.82,
  min_confidence: 0.6,
  churn_threshold: 0.4,
  default_ttl_seconds: 86400,
  retrieval_k: 8,
  acl_mode: "strict",
  on_stale_error: "serve_stale",
  superseded_retention_days: 30,
};

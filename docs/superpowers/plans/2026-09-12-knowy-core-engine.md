# Knowy Core Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Knowy's Agent Context Manager and the pure decision engine behind it, running end-to-end over in-memory adapters, so a repeat question is answered from a stored intelligence object at zero LLM cost.

**Architecture:** A dependency-free `@knowy/core` package holds every interesting decision as a pure function over plain data — evidence diffing, refresh-tier selection, the coverage and permission gates, and token accounting. The Agent Context Manager composes those functions and four injected ports (`RawEvidenceIndex`, `ObjectStore`, `Synthesizer`, `Embedder`). In-memory implementations of those ports, validated by a shared conformance suite, make the whole system runnable and testable with no external infrastructure.

**Tech Stack:** TypeScript 5.6+ (strict, ESM), Node 22, pnpm workspaces, Vitest.

**Spec:** [docs/superpowers/specs/2026-09-12-knowy-design.md](../specs/2026-09-12-knowy-design.md)

**Covers:** Spec §17 milestones 1–4. Real adapters, the HTTP server, MCP, and Slack are Plans 2 and 3.

## Global Constraints

- **Package manager is pnpm.** Never `npm` or `yarn`. Use `pnpm add`, `pnpm -r build`, `pnpm dlx`.
- **`@knowy/core` performs no I/O.** No `fetch`, no `fs`, no `process.env`, no database client, no SDK import. Time enters through the injected `Clock` port only — never `new Date()` or `Date.now()` inside core logic. This is enforced by a lint test in Task 1.
- **TypeScript strict mode**, ESM only (`"type": "module"`), `"moduleResolution": "bundler"`.
- **TDD is mandatory.** Every task writes a failing test, watches it fail, implements the minimum, watches it pass, then commits. Never write implementation before its test.
- **Fail-safe toward freshness** (spec §7.3): anything unknown, errored, or missing counts as *changed*, never as unchanged.
- **Config defaults are fixed values** from spec §16 and must match exactly: `match_threshold 0.86`, `discovery_top_k 5`, `discovery_min_score 0.82`, `min_confidence 0.6`, `churn_threshold 0.4`, `default_ttl_seconds 86400`, `retrieval_k 8`, `acl_mode "strict"`, `on_stale_error "serve_stale"`, `superseded_retention_days 30`.
- **Commit after every task.** Conventional commit prefixes (`feat:`, `test:`, `chore:`).

---

## File Structure

```
knowy/
├─ package.json                       workspace root, scripts, devDeps
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ vitest.config.ts
├─ .github/workflows/ci.yml
└─ packages/
   ├─ core/
   │  ├─ package.json
   │  ├─ tsconfig.json
   │  ├─ src/
   │  │  ├─ index.ts                  public exports
   │  │  ├─ types/
   │  │  │  ├─ evidence.ts            Evidence, EvidenceRef, Fingerprint, SearchQuery
   │  │  │  ├─ object.ts              IntelligenceObject, Claim, Accounting
   │  │  │  ├─ config.ts              KnowyConfig, DEFAULT_CONFIG
   │  │  │  ├─ responses.ts           AskRequest, AskResponse, Savings, Tier
   │  │  │  └─ ports.ts               the four ports + Clock
   │  │  ├─ object/validate.ts        validateObject() invariants
   │  │  ├─ freshness/ttl.ts          freshUntil(), needsFingerprintCheck()
   │  │  ├─ freshness/diff.ts         diffEvidence()
   │  │  ├─ freshness/planner.ts      planRefresh()
   │  │  ├─ gates/coverage.ts         passesCoverage()
   │  │  ├─ gates/permission.ts       isPermitted()
   │  │  ├─ accounting/savings.ts     computeSavings(), estimateTokens()
   │  │  ├─ acm/context-manager.ts    AgentContextManager
   │  │  └─ testing/
   │  │     ├─ index-suite.ts         RawEvidenceIndex conformance suite
   │  │     ├─ store-suite.ts         ObjectStore conformance suite
   │  │     └─ fixtures.ts            makeObject(), makeEvidence() builders
   │  └─ test/                        mirrors src/
   ├─ index-memory/                   in-memory RawEvidenceIndex
   └─ store-memory/                   in-memory ObjectStore
```

`store-memory` is an addition to spec §13, which listed `index-memory` but omitted the
in-memory object store that §17 milestone 3 requires. Both are test/example
infrastructure and ship as real packages so the conformance suite runs against them in CI.

**Why these boundaries:** each file under `src/` holds one decision with one exported
function, so a task's test file maps one-to-one onto its implementation file, and the
ACM is the only place that composes them.

---

### Task 1: Workspace, core types, and object invariants

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.github/workflows/ci.yml`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`
- Create: `packages/core/src/types/evidence.ts`, `object.ts`, `config.ts`, `responses.ts`, `ports.ts`
- Create: `packages/core/src/object/validate.ts`, `packages/core/src/testing/fixtures.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/object/validate.test.ts`, `packages/core/test/purity.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: every type in `packages/core/src/types/`, `DEFAULT_CONFIG`, `validateObject(obj: unknown): asserts obj is IntelligenceObject`, and the fixture builders `makeObject(overrides?: Partial<IntelligenceObject>): IntelligenceObject` and `makeEvidence(overrides?: Partial<Evidence>): Evidence`. Every later task depends on these.

- [x] **Step 1: Initialise the workspace**

```bash
cd /Users/clarkyin/Development/knowy
pnpm init
```

Then replace the generated root `package.json` with:

```json
{
  "name": "knowy",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r exec tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/node": "^22.7.0"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
```

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  }
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    coverage: { provider: "v8", include: ["packages/*/src/**"] },
  },
});
```

Run `pnpm install`.

- [x] **Step 2: Create the core package shell**

`packages/core/package.json`:

```json
{
  "name": "@knowy/core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./testing": "./dist/testing/index.js"
  },
  "files": ["dist"],
  "scripts": { "build": "tsc -p tsconfig.json" }
}
```

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

- [x] **Step 3: Write the failing tests for object invariants and core purity**

`packages/core/test/object/validate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateObject } from "../../src/object/validate.js";
import { makeObject } from "../../src/testing/fixtures.js";

describe("validateObject", () => {
  it("accepts a well-formed object", () => {
    expect(() => validateObject(makeObject())).not.toThrow();
  });

  it("rejects confidence outside 0..1", () => {
    expect(() => validateObject(makeObject({ confidence: 1.4 }))).toThrow(/confidence/);
    expect(() => validateObject(makeObject({ confidence: -0.1 }))).toThrow(/confidence/);
  });

  it("rejects an empty evidence set — an object with no evidence can never be verified", () => {
    expect(() => validateObject(makeObject({ evidence: [] }))).toThrow(/evidence/);
  });

  it("rejects a claim citing an evidence id the object does not hold", () => {
    const obj = makeObject({
      claims: [{ text: "unsupported", evidence_ids: ["not-in-evidence"] }],
    });
    expect(() => validateObject(obj)).toThrow(/not-in-evidence/);
  });

  it("rejects version below 1", () => {
    expect(() => validateObject(makeObject({ version: 0 }))).toThrow(/version/);
  });

  it("rejects an empty embedding", () => {
    expect(() => validateObject(makeObject({ embedding: [] }))).toThrow(/embedding/);
  });
});
```

`packages/core/test/purity.test.ts` — this enforces the Global Constraint that core does no I/O:

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [
  /\bfetch\s*\(/,
  /from\s+["']node:fs["']/,
  /from\s+["']node:http/,
  /process\.env/,
  /\bnew Date\s*\(\s*\)/,
  /\bDate\.now\s*\(/,
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

describe("core purity", () => {
  it("contains no I/O or ambient clock access", () => {
    const offenders: string[] = [];
    for (const file of walk(join(import.meta.dirname, "../src"))) {
      const src = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) {
        if (pattern.test(src)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [x] **Step 4: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core`
Expected: FAIL — `Cannot find module '../../src/object/validate.js'`.

- [x] **Step 5: Write the type modules**

`packages/core/src/types/evidence.ts`:

```ts
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
```

`packages/core/src/types/object.ts`:

```ts
import type { EvidenceRef } from "./evidence.js";

export interface Claim {
  text: string;
  evidence_ids: string[];
}

export interface Accounting {
  build_tokens: number;
  baseline_tokens: number;
  serve_tokens: number;
}

export interface IntelligenceObject {
  id: string;
  tenant_id: string;
  scope: "query" | "topic";
  canonical_question: string;
  content: string;
  claims: Claim[];
  confidence: number;
  gaps: string[];
  embedding: number[];
  tags: string[];
  acl: string[];
  acl_complete: boolean;
  evidence: EvidenceRef[];
  built_at: string;
  last_verified_at: string | null;
  invalidated_at: string | null;
  ttl_seconds: number;
  version: number;
  supersedes: string | null;
  accounting: Accounting;
}
```

`packages/core/src/types/config.ts`:

```ts
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
```

`packages/core/src/types/responses.ts`:

```ts
import type { Claim } from "./object.js";

export type Tier = "cached" | "verified" | "patched" | "rebuilt";
export type FreshnessMode = "cached" | "verified" | "fresh";

export interface Savings {
  baseline_tokens: number;
  actual_tokens: number;
  saved_tokens: number;
  baseline_is_estimate: boolean;
}

export interface Citation {
  evidence_id: string;
  source_uri: string;
}

export interface AskRequest {
  tenant_id: string;
  question: string;
  granted_permissions: string[];
  freshness?: FreshnessMode;
  tags?: string[];
}

export interface AskResponse {
  answer: { content: string; claims: Claim[]; citations: Citation[] };
  object_id: string;
  object_version: number;
  tier: Tier;
  stale: boolean;
  degraded: boolean;
  confidence: number;
  gaps: string[];
  savings: Savings;
  latency_ms: number;
}
```

`packages/core/src/types/ports.ts`:

```ts
import type {
  Evidence, Fingerprint, IndexCapabilities, SearchOpts, SearchQuery,
} from "./evidence.js";
import type { Claim, IntelligenceObject } from "./object.js";

export interface RawEvidenceIndex {
  search(query: SearchQuery, opts: SearchOpts): Promise<Evidence[]>;
  /** Fetch specific evidence by id. The patch tier needs changed content, not a query. */
  fetch(ids: string[]): Promise<Evidence[]>;
  /** null = known gone or never existed. An absent key = could not answer (spec §7.3). */
  fingerprint(ids: string[]): Promise<Map<string, Fingerprint | null>>;
  capabilities(): IndexCapabilities;
}

export interface ScoredObject {
  object: IntelligenceObject;
  score: number;
}

export interface SimilarOpts {
  topK: number;
  minScore: number;
  tags?: string[];
}

export interface InvalidateSelector {
  ids?: string[];
  source_uris?: string[];
  tags?: string[];
  all?: boolean;
}

export interface ObjectStore {
  get(tenantId: string, id: string, version?: number): Promise<IntelligenceObject | null>;
  put(obj: IntelligenceObject): Promise<void>;
  searchSimilar(tenantId: string, vec: number[], opts: SimilarOpts): Promise<ScoredObject[]>;
  invalidate(tenantId: string, selector: InvalidateSelector): Promise<number>;
  markVerified(tenantId: string, id: string, at: string): Promise<void>;
}

export interface SynthesisResult {
  content: string;
  claims: Claim[];
  confidence: number;
  gaps: string[];
  tokens_used: number;
}

export interface Synthesizer {
  build(question: string, evidence: Evidence[]): Promise<SynthesisResult>;
  patch(
    obj: IntelligenceObject,
    changed: Evidence[],
    removed: string[],
  ): Promise<SynthesisResult>;
}

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

export interface Clock {
  now(): Date;
}
```

Note `markVerified` on `ObjectStore`: a verify-tier hit extends `last_verified_at`
without writing a new object version (spec §11).

- [x] **Step 6: Write the fixtures and the validator**

`packages/core/src/testing/fixtures.ts`:

```ts
import type { Evidence, EvidenceRef } from "../types/evidence.js";
import type { IntelligenceObject } from "../types/object.js";

export function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: "ev-1",
    content: "Refunds are processed within 5 business days.",
    source_uri: "confluence://policies/refunds",
    content_hash: "h1",
    acl: ["group:support"],
    score: 0.91,
    ...overrides,
  };
}

export function makeEvidenceRef(overrides: Partial<EvidenceRef> = {}): EvidenceRef {
  return {
    id: "ev-1",
    hash: "h1",
    source_uri: "confluence://policies/refunds",
    acl: ["group:support"],
    retrieved_at: "2026-09-12T00:00:00.000Z",
    ...overrides,
  };
}

export function makeObject(overrides: Partial<IntelligenceObject> = {}): IntelligenceObject {
  return {
    id: "obj-1",
    tenant_id: "acme",
    scope: "query",
    canonical_question: "How long do refunds take?",
    content: "Refunds complete within 5 business days.",
    claims: [{ text: "Refunds complete within 5 business days.", evidence_ids: ["ev-1"] }],
    confidence: 0.9,
    gaps: [],
    embedding: [0.1, 0.2, 0.3],
    tags: ["policy"],
    acl: ["group:support"],
    acl_complete: true,
    evidence: [makeEvidenceRef()],
    built_at: "2026-09-12T00:00:00.000Z",
    last_verified_at: null,
    invalidated_at: null,
    ttl_seconds: 86400,
    version: 1,
    supersedes: null,
    accounting: { build_tokens: 1200, baseline_tokens: 4800, serve_tokens: 400 },
    ...overrides,
  };
}
```

`packages/core/src/object/validate.ts`:

```ts
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
```

`packages/core/src/index.ts`:

```ts
export * from "./types/evidence.js";
export * from "./types/object.js";
export * from "./types/config.js";
export * from "./types/responses.js";
export * from "./types/ports.js";
export * from "./object/validate.js";
```

- [x] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: PASS — every test in this task's files green, and the full suite still green.

- [x] **Step 8: Add CI**

`.github/workflows/ci.yml`:

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
```

- [x] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: workspace, core types, and intelligence object invariants"
```

---

### Task 2: TTL window and the fingerprint-check decision

**Files:**
- Create: `packages/core/src/freshness/ttl.ts`
- Modify: `packages/core/src/index.ts` (add the export line)
- Test: `packages/core/test/freshness/ttl.test.ts`

**Interfaces:**
- Consumes: `IntelligenceObject`, `FreshnessMode` from Task 1; `makeObject` from `src/testing/fixtures.ts`.
- Produces: `freshUntil(obj: IntelligenceObject): Date`, `isWithinTtl(obj: IntelligenceObject, now: Date): boolean`, `needsFingerprintCheck(input: { object: IntelligenceObject | null; now: Date; requested: FreshnessMode }): boolean`. Tasks 4 and 9 use all three.

- [x] **Step 1: Write the failing test**

`packages/core/test/freshness/ttl.test.ts`:

```ts
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
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/test/freshness/ttl.test.ts`
Expected: FAIL — `Cannot find module '../../src/freshness/ttl.js'`.

- [x] **Step 3: Write the implementation**

`packages/core/src/freshness/ttl.ts`:

```ts
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
```

Add to `packages/core/src/index.ts`:

```ts
export * from "./freshness/ttl.js";
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: PASS — every test in this task's files green, and the full suite still green.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: TTL window and fingerprint-check decision"
```

---

### Task 3: Evidence diffing

**Files:**
- Create: `packages/core/src/freshness/diff.ts`
- Modify: `packages/core/src/index.ts` (add the export line)
- Test: `packages/core/test/freshness/diff.test.ts`

**Interfaces:**
- Consumes: `EvidenceRef`, `Fingerprint` from Task 1; `makeEvidenceRef` from fixtures.
- Produces: `EvidenceDiff` (`{ unchanged: string[]; changed: string[]; deleted: string[]; unknown: string[]; total: number; churnRatio: number }`) and `diffEvidence(refs: readonly EvidenceRef[], fingerprints: ReadonlyMap<string, Fingerprint | null>): EvidenceDiff`. Tasks 4 and 9 consume both.

- [x] **Step 1: Write the failing test**

`packages/core/test/freshness/diff.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { diffEvidence } from "../../src/freshness/diff.js";
import { makeEvidenceRef } from "../../src/testing/fixtures.js";
import type { Fingerprint } from "../../src/types/evidence.js";

const fp = (id: string, hash: string): Fingerprint => ({ id, content_hash: hash, acl: [] });

const refs = [
  makeEvidenceRef({ id: "a", hash: "h-a" }),
  makeEvidenceRef({ id: "b", hash: "h-b" }),
  makeEvidenceRef({ id: "c", hash: "h-c" }),
  makeEvidenceRef({ id: "d", hash: "h-d" }),
];

describe("diffEvidence", () => {
  it("reports zero churn when every hash still matches", () => {
    const result = diffEvidence(refs, new Map(refs.map((r) => [r.id, fp(r.id, r.hash)])));
    expect(result.unchanged).toEqual(["a", "b", "c", "d"]);
    expect(result.churnRatio).toBe(0);
  });

  it("classifies a differing hash as changed", () => {
    const map = new Map(refs.map((r) => [r.id, fp(r.id, r.hash)]));
    map.set("b", fp("b", "h-b-v2"));
    const result = diffEvidence(refs, map);
    expect(result.changed).toEqual(["b"]);
    expect(result.churnRatio).toBe(0.25);
  });

  it("classifies an explicit null as deleted", () => {
    const map = new Map<string, Fingerprint | null>(refs.map((r) => [r.id, fp(r.id, r.hash)]));
    map.set("c", null);
    const result = diffEvidence(refs, map);
    expect(result.deleted).toEqual(["c"]);
    expect(result.churnRatio).toBe(0.25);
  });

  it("classifies a missing entry as unknown and counts it toward churn (spec §7.3)", () => {
    const map = new Map(refs.filter((r) => r.id !== "d").map((r) => [r.id, fp(r.id, r.hash)]));
    const result = diffEvidence(refs, map);
    expect(result.unknown).toEqual(["d"]);
    expect(result.unchanged).toEqual(["a", "b", "c"]);
    expect(result.churnRatio).toBe(0.25);
  });

  it("sums changed, deleted, and unknown into one churn ratio", () => {
    const map = new Map<string, Fingerprint | null>([
      ["a", fp("a", "h-a")],
      ["b", fp("b", "h-b-v2")],
      ["c", null],
    ]);
    const result = diffEvidence(refs, map);
    expect(result.total).toBe(4);
    expect(result.churnRatio).toBe(0.75);
  });

  it("treats an empty evidence set as fully churned rather than fully fresh", () => {
    expect(diffEvidence([], new Map()).churnRatio).toBe(1);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/test/freshness/diff.test.ts`
Expected: FAIL — `Cannot find module '../../src/freshness/diff.js'`.

- [x] **Step 3: Write the implementation**

`packages/core/src/freshness/diff.ts`:

```ts
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
```

Add to `packages/core/src/index.ts`:

```ts
export * from "./freshness/diff.js";
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: PASS — every test in this task's files green, and the full suite still green.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: evidence fingerprint diffing with fail-safe unknown handling"
```

---

### Task 4: The refresh planner

**Files:**
- Create: `packages/core/src/freshness/planner.ts`
- Modify: `packages/core/src/index.ts` (add the export line)
- Test: `packages/core/test/freshness/planner.test.ts`

**Interfaces:**
- Consumes: `isWithinTtl` (Task 2), `EvidenceDiff` (Task 3), `KnowyConfig`/`DEFAULT_CONFIG`, `Tier`, `FreshnessMode`, `IntelligenceObject` (Task 1).
- Produces: `RefreshPlan` (`{ tier: Tier; reason: string; patchEvidenceIds: string[]; removedEvidenceIds: string[] }`) and `planRefresh(input: { object: IntelligenceObject | null; diff: EvidenceDiff | null; now: Date; requested: FreshnessMode; config: KnowyConfig }): RefreshPlan`. Task 9 consumes both.

- [x] **Step 1: Write the failing test**

`packages/core/test/freshness/planner.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { planRefresh } from "../../src/freshness/planner.js";
import { diffEvidence } from "../../src/freshness/diff.js";
import { makeObject, makeEvidenceRef } from "../../src/testing/fixtures.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Fingerprint } from "../../src/types/evidence.js";

const fp = (id: string, hash: string): Fingerprint => ({ id, content_hash: hash, acl: [] });
const NOW = new Date("2026-09-12T00:30:00.000Z");
const config = DEFAULT_CONFIG;

const refs = ["a", "b", "c", "d", "e"].map((id) => makeEvidenceRef({ id, hash: `h-${id}` }));
const obj = makeObject({
  evidence: refs,
  claims: [],
  built_at: "2026-09-12T00:00:00.000Z",
  last_verified_at: null,
  ttl_seconds: 3600,
});

const allFresh = new Map(refs.map((r) => [r.id, fp(r.id, r.hash)]));

function diffWithChanged(ids: string[]) {
  const map = new Map(allFresh);
  for (const id of ids) map.set(id, fp(id, `${id}-v2`));
  return diffEvidence(refs, map);
}

describe("planRefresh", () => {
  it("rebuilds when the caller demands fresh, however clean the diff", () => {
    const plan = planRefresh({
      object: obj, diff: diffEvidence(refs, allFresh), now: NOW, requested: "fresh", config,
    });
    expect(plan.tier).toBe("rebuilt");
    expect(plan.reason).toMatch(/requested fresh/);
  });

  it("rebuilds when no candidate object was found", () => {
    const plan = planRefresh({ object: null, diff: null, now: NOW, requested: "verified", config });
    expect(plan.tier).toBe("rebuilt");
  });

  it("rebuilds an invalidated object even when every hash still matches", () => {
    const dead = makeObject({ ...obj, invalidated_at: "2026-09-12T00:10:00.000Z" });
    const plan = planRefresh({
      object: dead, diff: diffEvidence(refs, allFresh), now: NOW, requested: "verified", config,
    });
    expect(plan.tier).toBe("rebuilt");
    expect(plan.reason).toMatch(/invalidated/);
  });

  it("serves cached without a diff when cached mode is inside the TTL", () => {
    const plan = planRefresh({ object: obj, diff: null, now: NOW, requested: "cached", config });
    expect(plan.tier).toBe("cached");
  });

  it("verifies when nothing churned", () => {
    const plan = planRefresh({
      object: obj, diff: diffEvidence(refs, allFresh), now: NOW, requested: "verified", config,
    });
    expect(plan.tier).toBe("verified");
    expect(plan.patchEvidenceIds).toEqual([]);
  });

  it("verifies a TTL-expired object whose sources all still match", () => {
    const later = new Date("2026-09-12T09:00:00.000Z");
    const plan = planRefresh({
      object: obj, diff: diffEvidence(refs, allFresh), now: later, requested: "verified", config,
    });
    expect(plan.tier).toBe("verified");
  });

  it("patches when churn sits at or below the threshold", () => {
    const plan = planRefresh({
      object: obj, diff: diffWithChanged(["b", "c"]), now: NOW, requested: "verified", config,
    });
    expect(plan.tier).toBe("patched");
    expect(plan.patchEvidenceIds).toEqual(["b", "c"]);
  });

  it("rebuilds when churn exceeds the threshold", () => {
    const plan = planRefresh({
      object: obj, diff: diffWithChanged(["a", "b", "c"]), now: NOW, requested: "verified", config,
    });
    expect(plan.tier).toBe("rebuilt");
    expect(plan.reason).toMatch(/exceeds threshold/);
  });

  it("routes deleted evidence to removedEvidenceIds and unknown to the patch set", () => {
    const map = new Map<string, Fingerprint | null>(allFresh);
    map.set("a", null);
    map.delete("b");
    const plan = planRefresh({
      object: obj, diff: diffEvidence(refs, map), now: NOW, requested: "verified", config,
    });
    expect(plan.tier).toBe("patched");
    expect(plan.removedEvidenceIds).toEqual(["a"]);
    expect(plan.patchEvidenceIds).toEqual(["b"]);
  });

  it("rebuilds rather than guessing when a diff was required but absent", () => {
    const plan = planRefresh({ object: obj, diff: null, now: NOW, requested: "verified", config });
    expect(plan.tier).toBe("rebuilt");
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/test/freshness/planner.test.ts`
Expected: FAIL — `Cannot find module '../../src/freshness/planner.js'`.

- [x] **Step 3: Write the implementation**

`packages/core/src/freshness/planner.ts`:

```ts
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

const NO_EVIDENCE = { patchEvidenceIds: [], removedEvidenceIds: [] } as const;

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
```

Add to `packages/core/src/index.ts`:

```ts
export * from "./freshness/planner.js";
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: PASS — every test in this task's files green, and the full suite still green.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: refresh planner selecting verify/patch/rebuild tiers"
```

---

### Task 5: The coverage gate

**Files:**
- Create: `packages/core/src/gates/result.ts`, `packages/core/src/gates/coverage.ts`
- Modify: `packages/core/src/index.ts` (add the export lines)
- Test: `packages/core/test/gates/coverage.test.ts`

**Interfaces:**
- Consumes: `IntelligenceObject`, `KnowyConfig`, `DEFAULT_CONFIG` from Task 1.
- Produces: `GateResult` (`{ pass: boolean; reason: string }`, shared with Task 6) and `passesCoverage(input: { matchScore: number; object: IntelligenceObject; config: KnowyConfig }): GateResult`. Task 9 consumes both.

- [x] **Step 1: Write the failing test**

`packages/core/test/gates/coverage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { passesCoverage } from "../../src/gates/coverage.js";
import { makeObject } from "../../src/testing/fixtures.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";

const config = DEFAULT_CONFIG; // match_threshold 0.86, min_confidence 0.6

describe("passesCoverage", () => {
  it("passes when similarity and confidence both clear their thresholds", () => {
    const result = passesCoverage({
      matchScore: 0.91, object: makeObject({ confidence: 0.8 }), config,
    });
    expect(result.pass).toBe(true);
  });

  it("passes exactly at both thresholds", () => {
    const result = passesCoverage({
      matchScore: 0.86, object: makeObject({ confidence: 0.6 }), config,
    });
    expect(result.pass).toBe(true);
  });

  it("fails a near-miss similarity, naming the score and threshold", () => {
    const result = passesCoverage({
      matchScore: 0.85, object: makeObject({ confidence: 0.9 }), config,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("0.85");
    expect(result.reason).toContain("0.86");
  });

  it("fails a well-matched question when the object itself is low confidence", () => {
    const result = passesCoverage({
      matchScore: 0.99, object: makeObject({ confidence: 0.4 }), config,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/confidence/);
  });

  it("honours a caller-tuned threshold rather than the default", () => {
    const lenient = { ...config, match_threshold: 0.7 };
    const result = passesCoverage({
      matchScore: 0.75, object: makeObject({ confidence: 0.9 }), config: lenient,
    });
    expect(result.pass).toBe(true);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/test/gates/coverage.test.ts`
Expected: FAIL — `Cannot find module '../../src/gates/coverage.js'`.

- [x] **Step 3: Write the implementation**

`packages/core/src/gates/result.ts`:

```ts
export interface GateResult {
  pass: boolean;
  reason: string;
}
```

`packages/core/src/gates/coverage.ts`:

```ts
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
```

Add to `packages/core/src/index.ts`:

```ts
export * from "./gates/result.js";
export * from "./gates/coverage.js";
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: PASS — every test in this task's files green, and the full suite still green.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: coverage gate guarding against false hits"
```

---

### Task 6: The permission gate

**Files:**
- Create: `packages/core/src/gates/permission.ts`
- Modify: `packages/core/src/index.ts` (add the export line)
- Test: `packages/core/test/gates/permission.test.ts`

**Interfaces:**
- Consumes: `GateResult` (Task 5), `IntelligenceObject`, `KnowyConfig` (Task 1).
- Produces: `isPermitted(input: { object: IntelligenceObject; granted: readonly string[]; config: KnowyConfig }): GateResult` and `aclUnion(evidence: readonly { acl: string[] }[]): string[]`. Task 9 consumes both.

- [x] **Step 1: Write the failing test**

`packages/core/test/gates/permission.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isPermitted, aclUnion } from "../../src/gates/permission.js";
import { makeObject } from "../../src/testing/fixtures.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";

const strict = DEFAULT_CONFIG;
const tenantOnly = { ...DEFAULT_CONFIG, acl_mode: "tenant_only" as const };

describe("aclUnion", () => {
  it("deduplicates and sorts tags across every evidence item", () => {
    expect(
      aclUnion([{ acl: ["group:b", "group:a"] }, { acl: ["group:a", "group:c"] }]),
    ).toEqual(["group:a", "group:b", "group:c"]);
  });

  it("returns an empty union for evidence with no tags", () => {
    expect(aclUnion([{ acl: [] }, { acl: [] }])).toEqual([]);
  });
});

describe("isPermitted (strict)", () => {
  it("permits a caller holding every required tag", () => {
    const obj = makeObject({ acl: ["group:support"], acl_complete: true });
    expect(isPermitted({ object: obj, granted: ["group:support", "group:eng"], config: strict }).pass)
      .toBe(true);
  });

  it("refuses a caller missing even one tag", () => {
    const obj = makeObject({ acl: ["group:support", "group:finance"], acl_complete: true });
    const result = isPermitted({ object: obj, granted: ["group:support"], config: strict });
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("group:finance");
  });

  it("permits an object built entirely from untagged evidence", () => {
    const obj = makeObject({ acl: [], acl_complete: true });
    expect(isPermitted({ object: obj, granted: [], config: strict }).pass).toBe(true);
  });

  it("refuses any object whose ACLs the index could not report", () => {
    const obj = makeObject({ acl: [], acl_complete: false });
    const result = isPermitted({ object: obj, granted: ["group:support"], config: strict });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/acl_complete/);
  });
});

describe("isPermitted (tenant_only)", () => {
  it("permits regardless of tags, because the operator opted out explicitly", () => {
    const obj = makeObject({ acl: ["group:finance"], acl_complete: false });
    expect(isPermitted({ object: obj, granted: [], config: tenantOnly }).pass).toBe(true);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/test/gates/permission.test.ts`
Expected: FAIL — `Cannot find module '../../src/gates/permission.js'`.

- [x] **Step 3: Write the implementation**

`packages/core/src/gates/permission.ts`:

```ts
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
```

Add to `packages/core/src/index.ts`:

```ts
export * from "./gates/permission.js";
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: PASS — every test in this task's files green, and the full suite still green.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: permission gate enforcing acl-union subset checks"
```

---

### Task 7: Token accounting

**Files:**
- Create: `packages/core/src/accounting/savings.ts`
- Modify: `packages/core/src/index.ts` (add the export line)
- Test: `packages/core/test/accounting/savings.test.ts`

**Interfaces:**
- Consumes: `Savings` (Task 1), `Evidence` (Task 1).
- Produces: `estimateTokens(text: string): number`, `baselineFromEvidence(evidence: readonly Evidence[]): number`, and `computeSavings(input: { baselineTokens: number; actualTokens: number; baselineIsEstimate: boolean }): Savings`. Task 9 consumes all three.

- [x] **Step 1: Write the failing test**

`packages/core/test/accounting/savings.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeSavings, estimateTokens, baselineFromEvidence } from "../../src/accounting/savings.js";
import { makeEvidence } from "../../src/testing/fixtures.js";

describe("estimateTokens", () => {
  it("approximates four characters per token, rounding up", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("is zero for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("baselineFromEvidence", () => {
  it("sums the token cost of every raw chunk a naive retrieval would have sent", () => {
    const evidence = [
      makeEvidence({ id: "a", content: "x".repeat(400) }),
      makeEvidence({ id: "b", content: "x".repeat(800) }),
    ];
    expect(baselineFromEvidence(evidence)).toBe(300);
  });
});

describe("computeSavings", () => {
  it("reports the difference when serving is cheaper than raw retrieval", () => {
    const s = computeSavings({ baselineTokens: 4800, actualTokens: 400, baselineIsEstimate: true });
    expect(s.saved_tokens).toBe(4400);
    expect(s.baseline_is_estimate).toBe(true);
  });

  it("clamps to zero on a rebuild, which legitimately costs more than the baseline", () => {
    const s = computeSavings({ baselineTokens: 4800, actualTokens: 6000, baselineIsEstimate: false });
    expect(s.saved_tokens).toBe(0);
    expect(s.actual_tokens).toBe(6000);
  });

  it("counts a zero-token verify hit as saving the entire baseline", () => {
    const s = computeSavings({ baselineTokens: 4800, actualTokens: 0, baselineIsEstimate: true });
    expect(s.saved_tokens).toBe(4800);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/test/accounting/savings.test.ts`
Expected: FAIL — `Cannot find module '../../src/accounting/savings.js'`.

- [x] **Step 3: Write the implementation**

`packages/core/src/accounting/savings.ts`:

```ts
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
```

Add to `packages/core/src/index.ts`:

```ts
export * from "./accounting/savings.js";
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: PASS — every test in this task's files green, and the full suite still green.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: token accounting with honest baseline estimates"
```

---

### Task 8: In-memory adapters and the conformance suites

**Files:**
- Create: `packages/core/src/math/cosine.ts`
- Create: `packages/core/src/testing/index-suite.ts`, `packages/core/src/testing/store-suite.ts`, `packages/core/src/testing/index.ts`
- Create: `packages/index-memory/package.json`, `tsconfig.json`, `src/index.ts`
- Create: `packages/store-memory/package.json`, `tsconfig.json`, `src/index.ts`
- Modify: `packages/core/package.json` (add vitest as a peer + dev dependency)
- Test: `packages/index-memory/test/conformance.test.ts`, `packages/store-memory/test/conformance.test.ts`, `packages/core/test/math/cosine.test.ts`

**Interfaces:**
- Consumes: every port from Task 1.
- Produces: `cosine(a: readonly number[], b: readonly number[]): number`; `runIndexConformance(name: string, createHarness: () => Promise<IndexHarness>): void`; `runStoreConformance(name: string, createHarness: () => Promise<ObjectStore>): void`; `MemoryIndex` (with `seed(tenantId, records)`, `setHash(id, hash)`, `remove(id)`, `failFor(ids)`); `MemoryObjectStore`. Task 9 constructs both adapters.

**Contract clarification this task locks in:** in `fingerprint()`, a **`null` value means the index knows the id is gone or never existed**; an **absent key means the index could not answer** (timeout, partial failure). `diffEvidence` classifies the first as `deleted` and the second as `unknown`, and both count toward churn.

- [x] **Step 1: Write the failing cosine test**

`packages/core/test/math/cosine.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { cosine } from "../../src/math/cosine.js";

describe("cosine", () => {
  it("is 1 for identical vectors", () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("ignores magnitude", () => {
    expect(cosine([2, 0], [8, 0])).toBeCloseTo(1);
  });

  it("is 0 when either vector is all zeros rather than dividing by zero", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it("throws on a dimension mismatch rather than silently truncating", () => {
    expect(() => cosine([1, 2], [1, 2, 3])).toThrow(/dimension/);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/test/math/cosine.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement cosine**

`packages/core/src/math/cosine.ts`:

```ts
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dimension mismatch, ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
```

Add `export * from "./math/cosine.js";` to `packages/core/src/index.ts`.

- [x] **Step 4: Write the conformance suites**

Add vitest to `packages/core/package.json`:

```json
  "peerDependencies": { "vitest": "^2.1.0" },
  "peerDependenciesMeta": { "vitest": { "optional": true } },
  "devDependencies": { "vitest": "^2.1.0" }
```

`packages/core/src/testing/index-suite.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import type { Evidence, RawEvidenceIndex } from "../index.js";

export interface IndexRecord {
  evidence: Evidence;
  embedding: number[];
}

export interface IndexHarness {
  index: RawEvidenceIndex;
  seed(tenantId: string, records: IndexRecord[]): Promise<void>;
  setHash(id: string, hash: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Make fingerprint() omit these ids, simulating a partial failure. */
  failFor(ids: string[]): Promise<void>;
}

const ev = (id: string, content: string, acl: string[] = []): Evidence => ({
  id, content, source_uri: `test://${id}`, content_hash: `h-${id}`, acl, score: 0,
});

export function runIndexConformance(
  name: string,
  createHarness: () => Promise<IndexHarness>,
): void {
  describe(`RawEvidenceIndex conformance: ${name}`, () => {
    let h: IndexHarness;

    beforeEach(async () => {
      h = await createHarness();
      await h.seed("acme", [
        { evidence: ev("a", "alpha"), embedding: [1, 0, 0] },
        { evidence: ev("b", "beta"), embedding: [0.9, 0.1, 0] },
        { evidence: ev("c", "gamma", ["group:finance"]), embedding: [0, 1, 0] },
      ]);
      await h.seed("other", [{ evidence: ev("z", "zeta"), embedding: [1, 0, 0] }]);
    });

    it("returns results ordered by descending score", async () => {
      const out = await h.index.search(
        { text: "alpha", vector: [1, 0, 0] },
        { tenantId: "acme", topK: 3 },
      );
      expect(out.map((e) => e.id)).toEqual(["a", "b", "c"]);
      expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
    });

    it("respects topK", async () => {
      const out = await h.index.search(
        { text: "alpha", vector: [1, 0, 0] },
        { tenantId: "acme", topK: 2 },
      );
      expect(out).toHaveLength(2);
    });

    it("never returns another tenant's evidence", async () => {
      const out = await h.index.search(
        { text: "zeta", vector: [1, 0, 0] },
        { tenantId: "acme", topK: 10 },
      );
      expect(out.map((e) => e.id)).not.toContain("z");
    });

    it("filters by caller permissions when granted is supplied", async () => {
      const out = await h.index.search(
        { text: "gamma", vector: [0, 1, 0] },
        { tenantId: "acme", topK: 10, granted: [] },
      );
      expect(out.map((e) => e.id)).not.toContain("c");
    });

    it("fetches evidence by id", async () => {
      const out = await h.index.fetch(["a", "c"]);
      expect(out.map((e) => e.id).sort()).toEqual(["a", "c"]);
      expect(out.find((e) => e.id === "a")!.content).toBe("alpha");
    });

    it("omits ids from fetch that no longer exist", async () => {
      await h.remove("a");
      expect(await h.index.fetch(["a", "b"])).toHaveLength(1);
    });

    it("fingerprints known ids with their current hash", async () => {
      const fps = await h.index.fingerprint(["a", "b"]);
      expect(fps.get("a")!.content_hash).toBe("h-a");
    });

    it("reflects a hash change in the fingerprint", async () => {
      await h.setHash("a", "h-a-v2");
      const fps = await h.index.fingerprint(["a"]);
      expect(fps.get("a")!.content_hash).toBe("h-a-v2");
    });

    it("maps a removed id to null, meaning known-gone", async () => {
      await h.remove("b");
      const fps = await h.index.fingerprint(["b"]);
      expect(fps.has("b")).toBe(true);
      expect(fps.get("b")).toBeNull();
    });

    it("maps an id that never existed to null as well", async () => {
      const fps = await h.index.fingerprint(["never"]);
      expect(fps.get("never")).toBeNull();
    });

    it("omits the key entirely when it cannot answer, meaning unknown", async () => {
      await h.failFor(["a"]);
      const fps = await h.index.fingerprint(["a", "b"]);
      expect(fps.has("a")).toBe(false);
      expect(fps.has("b")).toBe(true);
    });

    it("declares its capabilities", async () => {
      const caps = h.index.capabilities();
      expect(typeof caps.acl).toBe("boolean");
      expect(["native", "derived"]).toContain(caps.hashing);
    });
  });
}
```

`packages/core/src/testing/store-suite.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import type { ObjectStore } from "../index.js";
import { makeObject } from "./fixtures.js";

export function runStoreConformance(
  name: string,
  createStore: () => Promise<ObjectStore>,
): void {
  describe(`ObjectStore conformance: ${name}`, () => {
    let store: ObjectStore;

    beforeEach(async () => {
      store = await createStore();
    });

    it("round-trips an object", async () => {
      const obj = makeObject({ id: "o1" });
      await store.put(obj);
      expect((await store.get("acme", "o1"))!.content).toBe(obj.content);
    });

    it("returns null for an unknown id", async () => {
      expect(await store.get("acme", "missing")).toBeNull();
    });

    it("never returns another tenant's object", async () => {
      await store.put(makeObject({ id: "o1", tenant_id: "acme" }));
      expect(await store.get("other", "o1")).toBeNull();
    });

    it("returns the latest version when no version is requested", async () => {
      await store.put(makeObject({ id: "o1", version: 1, content: "v1" }));
      await store.put(makeObject({ id: "o1", version: 2, content: "v2" }));
      expect((await store.get("acme", "o1"))!.content).toBe("v2");
    });

    it("reads an explicit historical version", async () => {
      await store.put(makeObject({ id: "o1", version: 1, content: "v1" }));
      await store.put(makeObject({ id: "o1", version: 2, content: "v2" }));
      expect((await store.get("acme", "o1", 1))!.content).toBe("v1");
    });

    it("orders similarity results by descending score", async () => {
      await store.put(makeObject({ id: "near", embedding: [1, 0, 0] }));
      await store.put(makeObject({ id: "far", embedding: [0.6, 0.8, 0] }));
      const out = await store.searchSimilar("acme", [1, 0, 0], { topK: 5, minScore: 0 });
      expect(out.map((s) => s.object.id)).toEqual(["near", "far"]);
    });

    it("drops candidates below minScore", async () => {
      await store.put(makeObject({ id: "orthogonal", embedding: [0, 1, 0] }));
      const out = await store.searchSimilar("acme", [1, 0, 0], { topK: 5, minScore: 0.5 });
      expect(out).toHaveLength(0);
    });

    it("respects topK", async () => {
      await store.put(makeObject({ id: "a", embedding: [1, 0, 0] }));
      await store.put(makeObject({ id: "b", embedding: [0.99, 0.01, 0] }));
      const out = await store.searchSimilar("acme", [1, 0, 0], { topK: 1, minScore: 0 });
      expect(out).toHaveLength(1);
    });

    it("returns only the latest version from similarity search", async () => {
      await store.put(makeObject({ id: "o1", version: 1, embedding: [1, 0, 0] }));
      await store.put(makeObject({ id: "o1", version: 2, embedding: [1, 0, 0] }));
      const out = await store.searchSimilar("acme", [1, 0, 0], { topK: 5, minScore: 0 });
      expect(out).toHaveLength(1);
      expect(out[0]!.object.version).toBe(2);
    });

    it("invalidates by id and reports how many objects it touched", async () => {
      await store.put(makeObject({ id: "o1" }));
      expect(await store.invalidate("acme", { ids: ["o1"] })).toBe(1);
      expect((await store.get("acme", "o1"))!.invalidated_at).not.toBeNull();
    });

    it("invalidates by tag", async () => {
      await store.put(makeObject({ id: "o1", tags: ["policy"] }));
      await store.put(makeObject({ id: "o2", tags: ["pricing"] }));
      expect(await store.invalidate("acme", { tags: ["policy"] })).toBe(1);
      expect((await store.get("acme", "o2"))!.invalidated_at).toBeNull();
    });

    it("invalidates by source uri", async () => {
      await store.put(makeObject({ id: "o1" })); // fixture evidence is confluence://policies/refunds
      expect(await store.invalidate("acme", { source_uris: ["confluence://policies/refunds"] })).toBe(1);
    });

    it("markVerified extends the freshness window without creating a version", async () => {
      await store.put(makeObject({ id: "o1", version: 1 }));
      await store.markVerified("acme", "o1", "2026-09-13T00:00:00.000Z");
      const got = (await store.get("acme", "o1"))!;
      expect(got.last_verified_at).toBe("2026-09-13T00:00:00.000Z");
      expect(got.version).toBe(1);
    });
  });
}
```

`packages/core/src/testing/index.ts`:

```ts
export * from "./fixtures.js";
export * from "./index-suite.js";
export * from "./store-suite.js";
```

- [x] **Step 5: Write the adapter test files, which fail because the adapters do not exist**

`packages/index-memory/test/conformance.test.ts`:

```ts
import { runIndexConformance } from "@knowy/core/testing";
import { MemoryIndex } from "../src/index.js";

runIndexConformance("MemoryIndex", async () => {
  const index = new MemoryIndex();
  return {
    index,
    seed: (tenantId, records) => index.seed(tenantId, records),
    setHash: (id, hash) => index.setHash(id, hash),
    remove: (id) => index.remove(id),
    failFor: (ids) => index.failFor(ids),
  };
});
```

`packages/store-memory/test/conformance.test.ts`:

```ts
import { runStoreConformance } from "@knowy/core/testing";
import { MemoryObjectStore } from "../src/index.js";

runStoreConformance("MemoryObjectStore", async () => new MemoryObjectStore());
```

- [x] **Step 6: Run them to verify they fail**

Run: `pnpm vitest run packages/index-memory packages/store-memory`
Expected: FAIL — `Cannot find module '../src/index.js'`.

- [x] **Step 7: Implement MemoryIndex**

`packages/index-memory/package.json` (and an equivalent `tsconfig.json` copying `packages/core/tsconfig.json`):

```json
{
  "name": "@knowy/index-memory",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": { "@knowy/core": "workspace:*" }
}
```

`packages/index-memory/src/index.ts`:

```ts
import {
  cosine,
  type Evidence,
  type Fingerprint,
  type IndexCapabilities,
  type RawEvidenceIndex,
  type SearchOpts,
  type SearchQuery,
} from "@knowy/core";
// IndexRecord lives with the conformance suite; the import is type-only, so it erases.
import type { IndexRecord } from "@knowy/core/testing";

interface Row extends IndexRecord {
  tenantId: string;
}

export class MemoryIndex implements RawEvidenceIndex {
  private rows = new Map<string, Row>();
  private failing = new Set<string>();

  async seed(tenantId: string, records: IndexRecord[]): Promise<void> {
    for (const r of records) {
      this.rows.set(r.evidence.id, { tenantId, evidence: { ...r.evidence }, embedding: r.embedding });
    }
  }

  async setHash(id: string, hash: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.evidence.content_hash = hash;
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async failFor(ids: string[]): Promise<void> {
    for (const id of ids) this.failing.add(id);
  }

  async search(query: SearchQuery, opts: SearchOpts): Promise<Evidence[]> {
    const granted = opts.granted === undefined ? null : new Set(opts.granted);
    return [...this.rows.values()]
      .filter((r) => r.tenantId === opts.tenantId)
      .filter((r) => granted === null || r.evidence.acl.every((t) => granted.has(t)))
      .map((r) => ({ ...r.evidence, score: cosine(query.vector, r.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.topK);
  }

  async fetch(ids: string[]): Promise<Evidence[]> {
    return ids.flatMap((id) => {
      const row = this.rows.get(id);
      return row ? [{ ...row.evidence }] : [];
    });
  }

  async fingerprint(ids: string[]): Promise<Map<string, Fingerprint | null>> {
    const out = new Map<string, Fingerprint | null>();
    for (const id of ids) {
      if (this.failing.has(id)) continue; // omitted key => unknown
      const row = this.rows.get(id);
      out.set(
        id,
        row ? { id, content_hash: row.evidence.content_hash, acl: row.evidence.acl } : null,
      );
    }
    return out;
  }

  capabilities(): IndexCapabilities {
    return { acl: true, hashing: "native" };
  }
}
```

- [x] **Step 8: Implement MemoryObjectStore**

`packages/store-memory/package.json` mirrors the one above with `"name": "@knowy/store-memory"`.

`packages/store-memory/src/index.ts`:

```ts
import {
  cosine,
  type IntelligenceObject,
  type InvalidateSelector,
  type ObjectStore,
  type ScoredObject,
  type SimilarOpts,
} from "@knowy/core";

const key = (tenantId: string, id: string, version: number) => `${tenantId}/${id}@${version}`;

export class MemoryObjectStore implements ObjectStore {
  private rows = new Map<string, IntelligenceObject>();

  private versionsOf(tenantId: string, id: string): IntelligenceObject[] {
    return [...this.rows.values()]
      .filter((o) => o.tenant_id === tenantId && o.id === id)
      .sort((a, b) => b.version - a.version);
  }

  private latestPerId(tenantId: string): IntelligenceObject[] {
    const best = new Map<string, IntelligenceObject>();
    for (const o of this.rows.values()) {
      if (o.tenant_id !== tenantId) continue;
      const seen = best.get(o.id);
      if (!seen || o.version > seen.version) best.set(o.id, o);
    }
    return [...best.values()];
  }

  async get(tenantId: string, id: string, version?: number): Promise<IntelligenceObject | null> {
    if (version !== undefined) return this.rows.get(key(tenantId, id, version)) ?? null;
    return this.versionsOf(tenantId, id)[0] ?? null;
  }

  async put(obj: IntelligenceObject): Promise<void> {
    this.rows.set(key(obj.tenant_id, obj.id, obj.version), { ...obj });
  }

  async searchSimilar(
    tenantId: string,
    vec: number[],
    opts: SimilarOpts,
  ): Promise<ScoredObject[]> {
    return this.latestPerId(tenantId)
      .filter((o) => opts.tags === undefined || opts.tags.some((t) => o.tags.includes(t)))
      .map((o) => ({ object: o, score: cosine(vec, o.embedding) }))
      .filter((s) => s.score >= opts.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.topK);
  }

  async invalidate(tenantId: string, selector: InvalidateSelector): Promise<number> {
    const at = new Date().toISOString();
    let touched = 0;
    for (const o of this.latestPerId(tenantId)) {
      const hit =
        selector.all === true ||
        (selector.ids?.includes(o.id) ?? false) ||
        (selector.tags?.some((t) => o.tags.includes(t)) ?? false) ||
        (selector.source_uris?.some((u) => o.evidence.some((e) => e.source_uri === u)) ?? false);
      if (!hit) continue;
      this.rows.set(key(tenantId, o.id, o.version), { ...o, invalidated_at: at });
      touched++;
    }
    return touched;
  }

  async markVerified(tenantId: string, id: string, at: string): Promise<void> {
    const latest = this.versionsOf(tenantId, id)[0];
    if (!latest) return;
    this.rows.set(key(tenantId, id, latest.version), { ...latest, last_verified_at: at });
  }
}
```

`invalidate` is the one place an in-memory *adapter* may read the wall clock — the
purity constraint binds `@knowy/core`, not adapters.

- [x] **Step 9: Run the conformance suites to verify they pass**

Run: `pnpm install && pnpm -r build && pnpm vitest run`
Expected: PASS — both conformance suites green, and the full suite still green.

- [x] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: in-memory adapters validated by shared conformance suites"
```

---

### Task 9: The Agent Context Manager

**Files:**
- Create: `packages/core/src/acm/context-manager.ts`
- Modify: `packages/core/src/index.ts` (add the export line)
- Test: `packages/core/test/acm/doubles.ts`, `packages/core/test/acm/context-manager.test.ts`

**Interfaces:**
- Consumes: `needsFingerprintCheck` (2), `diffEvidence` (3), `planRefresh` (4), `passesCoverage` (5), `isPermitted`/`aclUnion` (6), `computeSavings`/`baselineFromEvidence`/`estimateTokens` (7), `MemoryIndex`/`MemoryObjectStore` (8), `validateObject` (1).
- Produces: `AgentContextManager` with `ask(req: AskRequest): Promise<AskResponse>`, the protected helpers `rebuild`, `applyPatch`, `serve`, `serveEmpty`, `serveDegraded`, its constructor type `AcmDeps`, and `FreshnessUnavailableError`. Task 10 extends the same class.

- [x] **Step 1: Write the test doubles**

`packages/core/test/acm/doubles.ts`:

```ts
import type { Clock, Embedder, Evidence, Synthesizer, SynthesisResult } from "../../src/index.js";

export class FakeClock implements Clock {
  constructor(private t: Date) {}
  now(): Date { return new Date(this.t); }
  advance(seconds: number): void { this.t = new Date(this.t.getTime() + seconds * 1000); }
}

export class FakeEmbedder implements Embedder {
  readonly dimensions = 3;
  private map = new Map<string, number[]>();
  register(text: string, vector: number[]): void { this.map.set(text, vector); }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.map.get(t) ?? [1, 0, 0]);
  }
}

export class FakeSynthesizer implements Synthesizer {
  buildCalls = 0;
  patchCalls = 0;
  failBuild = false;
  failPatch = false;
  confidence = 0.9;

  async build(question: string, evidence: Evidence[]): Promise<SynthesisResult> {
    this.buildCalls++;
    if (this.failBuild) throw new Error("synthesizer unavailable");
    return {
      content: `digest of ${evidence.length} items for: ${question}`,
      claims: evidence.map((e) => ({ text: e.content, evidence_ids: [e.id] })),
      confidence: this.confidence,
      gaps: [],
      tokens_used: 1000,
    };
  }

  async patch(obj: { content: string }, changed: Evidence[], removed: string[]): Promise<SynthesisResult> {
    this.patchCalls++;
    if (this.failPatch) throw new Error("synthesizer unavailable");
    return {
      content: `${obj.content} [patched +${changed.length} -${removed.length}]`,
      claims: changed.map((e) => ({ text: e.content, evidence_ids: [e.id] })),
      confidence: this.confidence,
      gaps: [],
      tokens_used: 120,
    };
  }
}
```

- [x] **Step 2: Write the failing test**

`packages/core/test/acm/context-manager.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryIndex } from "@knowy/index-memory";
import { MemoryObjectStore } from "@knowy/store-memory";
import { AgentContextManager, FreshnessUnavailableError } from "../../src/acm/context-manager.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { FakeClock, FakeEmbedder, FakeSynthesizer } from "./doubles.js";
import type { AskRequest } from "../../src/types/responses.js";

const QUESTION = "How long do refunds take?";

function evidence(id: string, acl: string[] = []) {
  return {
    evidence: {
      id, content: "x".repeat(2400), source_uri: `confluence://${id}`,
      content_hash: `h-${id}`, acl, score: 0,
    },
    embedding: [1, 0, 0],
  };
}

describe("AgentContextManager.ask", () => {
  let index: MemoryIndex;
  let store: MemoryObjectStore;
  let synthesizer: FakeSynthesizer;
  let embedder: FakeEmbedder;
  let clock: FakeClock;
  let acm: AgentContextManager;
  let seq: number;

  const req = (over: Partial<AskRequest> = {}): AskRequest => ({
    tenant_id: "acme", question: QUESTION, granted_permissions: ["group:support"], ...over,
  });

  beforeEach(async () => {
    index = new MemoryIndex();
    store = new MemoryObjectStore();
    synthesizer = new FakeSynthesizer();
    embedder = new FakeEmbedder();
    clock = new FakeClock(new Date("2026-09-12T00:00:00.000Z"));
    seq = 0;
    await index.seed("acme", [
      evidence("a", ["group:support"]),
      evidence("b", ["group:support"]),
      evidence("c", ["group:support"]),
      evidence("d", ["group:support"]),
      evidence("public", []),
    ]);
    acm = new AgentContextManager({
      index, store, synthesizer, embedder,
      config: DEFAULT_CONFIG, clock, newId: () => `obj-${++seq}`,
    });
  });

  it("rebuilds on a cold miss and stores the object", async () => {
    const res = await acm.ask(req());
    expect(res.tier).toBe("rebuilt");
    expect(synthesizer.buildCalls).toBe(1);
    expect(res.object_version).toBe(1);
    expect(await store.get("acme", res.object_id)).not.toBeNull();
  });

  it("serves the second identical question from the object store at zero LLM cost", async () => {
    await acm.ask(req());
    const res = await acm.ask(req());
    expect(res.tier).toBe("verified");
    expect(synthesizer.buildCalls).toBe(1);
    expect(res.savings.saved_tokens).toBeGreaterThan(0);
    expect(res.savings.baseline_is_estimate).toBe(true);
  });

  it("skips the index entirely in cached mode inside the TTL", async () => {
    await acm.ask(req());
    await index.failFor(["a", "b", "c", "d"]);
    const res = await acm.ask(req({ freshness: "cached" }));
    expect(res.tier).toBe("cached");
  });

  it("patches when one source of five changed", async () => {
    await acm.ask(req());
    await index.setHash("a", "h-a-v2");
    const res = await acm.ask(req());
    expect(res.tier).toBe("patched");
    expect(synthesizer.patchCalls).toBe(1);
    expect(synthesizer.buildCalls).toBe(1);
    expect(res.object_version).toBe(2);
    const stored = await store.get("acme", res.object_id);
    expect(stored!.supersedes).toBe(`${res.object_id}@1`);
  });

  it("rebuilds when churn exceeds the threshold", async () => {
    await acm.ask(req());
    await index.setHash("a", "h-a-v2");
    await index.setHash("b", "h-b-v2");
    await index.setHash("c", "h-c-v2");
    const res = await acm.ask(req());
    expect(res.tier).toBe("rebuilt");
    expect(synthesizer.buildCalls).toBe(2);
    expect(res.object_version).toBe(2);
  });

  it("forces a rebuild when the caller asks for fresh", async () => {
    await acm.ask(req());
    const res = await acm.ask(req({ freshness: "fresh" }));
    expect(res.tier).toBe("rebuilt");
    expect(synthesizer.buildCalls).toBe(2);
  });

  it("never serves a cached object to a caller lacking its ACL tags", async () => {
    const privileged = await acm.ask(req());
    const res = await acm.ask(req({ granted_permissions: [] }));
    expect(res.tier).toBe("rebuilt");
    expect(synthesizer.buildCalls).toBe(2);
    // The unprivileged answer is a fresh object built only from public evidence.
    expect(res.object_id).not.toBe(privileged.object_id);
    const rebuilt = await store.get("acme", res.object_id);
    expect(rebuilt!.acl).toEqual([]);
    expect(rebuilt!.evidence.map((e) => e.id)).toEqual(["public"]);
  });

  it("returns an empty, zero-confidence answer when no evidence is accessible", async () => {
    const res = await acm.ask({
      tenant_id: "acme", question: "unrelated", granted_permissions: [],
      freshness: "fresh",
    });
    // Every seeded document is either group-tagged or public; scope to a tenant with none.
    const empty = await acm.ask({
      tenant_id: "empty-tenant", question: "anything", granted_permissions: [],
    });
    expect(empty.confidence).toBe(0);
    expect(empty.gaps[0]).toMatch(/no evidence/i);
    expect(empty.object_id).toBe("");
    expect(res.tier).toBe("rebuilt");
  });

  it("serves stale rather than failing when freshness cannot be verified", async () => {
    await acm.ask(req());
    index.fingerprint = async () => { throw new Error("index down"); };
    const res = await acm.ask(req());
    expect(res.stale).toBe(true);
    expect(res.tier).toBe("cached");
  });

  it("fails instead when the tenant configured on_stale_error: fail", async () => {
    await acm.ask(req());
    index.fingerprint = async () => { throw new Error("index down"); };
    const strictAcm = new AgentContextManager({
      index, store, synthesizer, embedder, clock, newId: () => "obj-x",
      config: { ...DEFAULT_CONFIG, on_stale_error: "fail" },
    });
    await expect(strictAcm.ask(req())).rejects.toBeInstanceOf(FreshnessUnavailableError);
  });

  it("degrades to raw evidence when synthesis fails, and stores nothing", async () => {
    synthesizer.failBuild = true;
    const res = await acm.ask(req());
    expect(res.degraded).toBe(true);
    expect(res.confidence).toBe(0);
    expect(res.answer.content).toContain("x".repeat(100));
    expect(await store.searchSimilar("acme", [1, 0, 0], { topK: 5, minScore: 0 })).toHaveLength(0);
  });

  it("still answers when the object store write fails", async () => {
    store.put = async () => { throw new Error("store down"); };
    const res = await acm.ask(req());
    expect(res.tier).toBe("rebuilt");
    expect(res.degraded).toBe(false);
    expect(res.answer.content).toContain("digest of");
  });

  it("does not serve an object whose confidence is below the gate", async () => {
    synthesizer.confidence = 0.3;
    await acm.ask(req());
    const res = await acm.ask(req());
    expect(res.tier).toBe("rebuilt");
    expect(synthesizer.buildCalls).toBe(2);
  });

  it("reports a verify hit as saving the whole baseline minus the digest", async () => {
    const cold = await acm.ask(req());
    const warm = await acm.ask(req());
    expect(warm.savings.baseline_tokens).toBe(cold.savings.baseline_tokens);
    expect(warm.savings.actual_tokens).toBeLessThan(cold.savings.actual_tokens);
  });
});
```

- [x] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/test/acm`
Expected: FAIL — `Cannot find module '../../src/acm/context-manager.js'`.

- [x] **Step 4: Write the implementation**

`packages/core/src/acm/context-manager.ts`:

```ts
import type { Evidence } from "../types/evidence.js";
import type { IntelligenceObject } from "../types/object.js";
import type { KnowyConfig } from "../types/config.js";
import type {
  AskRequest, AskResponse, FreshnessMode, Tier,
} from "../types/responses.js";
import type {
  Clock, Embedder, ObjectStore, RawEvidenceIndex, Synthesizer, SynthesisResult,
} from "../types/ports.js";
import { validateObject } from "../object/validate.js";
import { needsFingerprintCheck } from "../freshness/ttl.js";
import { diffEvidence } from "../freshness/diff.js";
import { planRefresh, type RefreshPlan } from "../freshness/planner.js";
import { passesCoverage } from "../gates/coverage.js";
import { aclUnion, isPermitted } from "../gates/permission.js";
import { baselineFromEvidence, computeSavings, estimateTokens } from "../accounting/savings.js";

export class FreshnessUnavailableError extends Error {}

export interface AcmDeps {
  index: RawEvidenceIndex;
  store: ObjectStore;
  synthesizer: Synthesizer;
  embedder: Embedder;
  config: KnowyConfig;
  clock: Clock;
  newId: () => string;
}

export class AgentContextManager {
  constructor(protected readonly deps: AcmDeps) {}

  async ask(req: AskRequest): Promise<AskResponse> {
    const { store, embedder, index, config, clock } = this.deps;
    const startedAt = clock.now().getTime();
    const requested: FreshnessMode = req.freshness ?? "verified";

    const qvec = (await embedder.embed([req.question]))[0];
    if (qvec === undefined) throw new Error("embedder returned no vector");

    const candidates =
      requested === "fresh"
        ? []
        : await store.searchSimilar(req.tenant_id, qvec, {
            topK: config.discovery_top_k,
            minScore: config.discovery_min_score,
            ...(req.tags === undefined ? {} : { tags: req.tags }),
          });

    for (const candidate of candidates) {
      const obj = candidate.object;
      if (!isPermitted({ object: obj, granted: req.granted_permissions, config }).pass) continue;
      if (!passesCoverage({ matchScore: candidate.score, object: obj, config }).pass) continue;

      const now = clock.now();
      let diff = null;
      if (needsFingerprintCheck({ object: obj, now, requested })) {
        try {
          const fps = await index.fingerprint(obj.evidence.map((e) => e.id));
          diff = diffEvidence(obj.evidence, fps);
        } catch (cause) {
          if (config.on_stale_error === "fail") {
            throw new FreshnessUnavailableError(`cannot verify freshness of ${obj.id}`, { cause });
          }
          return this.serve({
            object: obj, tier: "cached", stale: true, degraded: false,
            actualTokens: obj.accounting.serve_tokens, baselineIsEstimate: true, startedAt,
          });
        }
      }

      const plan = planRefresh({ object: obj, diff, now, requested, config });

      if (plan.tier === "cached") {
        return this.serve({
          object: obj, tier: "cached", stale: false, degraded: false,
          actualTokens: obj.accounting.serve_tokens, baselineIsEstimate: true, startedAt,
        });
      }
      if (plan.tier === "verified") {
        const at = now.toISOString();
        await store.markVerified(req.tenant_id, obj.id, at);
        return this.serve({
          object: { ...obj, last_verified_at: at }, tier: "verified", stale: false,
          degraded: false, actualTokens: obj.accounting.serve_tokens,
          baselineIsEstimate: true, startedAt,
        });
      }
      if (plan.tier === "patched") {
        return this.applyPatch({ object: obj, plan, req, qvec, startedAt });
      }
      return this.rebuild({ req, qvec, existing: obj, startedAt });
    }

    return this.rebuild({ req, qvec, existing: null, startedAt });
  }

  protected async rebuild(input: {
    req: AskRequest; qvec: number[]; existing: IntelligenceObject | null; startedAt: number;
  }): Promise<AskResponse> {
    const { req, qvec, existing, startedAt } = input;
    const { index, store, synthesizer, config, clock } = this.deps;

    const evidence = await index.search(
      { text: req.question, vector: qvec },
      {
        tenantId: req.tenant_id,
        topK: config.retrieval_k,
        granted: req.granted_permissions,
        ...(req.tags === undefined ? {} : { tags: req.tags }),
      },
    );
    const baseline = baselineFromEvidence(evidence);

    // No accessible evidence is a legitimate answer, not a failure. Synthesizing from
    // nothing would invent content, and storing it would violate the object invariants.
    if (evidence.length === 0) return this.serveEmpty(startedAt);

    let result: SynthesisResult;
    try {
      result = await synthesizer.build(req.question, evidence);
    } catch {
      return this.serveDegraded(evidence, baseline, startedAt);
    }

    const now = clock.now();
    const iso = now.toISOString();
    const object: IntelligenceObject = {
      id: existing?.id ?? this.deps.newId(),
      tenant_id: req.tenant_id,
      scope: "query",
      canonical_question: req.question,
      content: result.content,
      claims: result.claims,
      confidence: result.confidence,
      gaps: result.gaps,
      embedding: qvec,
      tags: req.tags ?? [],
      acl: aclUnion(evidence),
      acl_complete: index.capabilities().acl,
      evidence: evidence.map((e) => ({
        id: e.id, hash: e.content_hash, source_uri: e.source_uri, acl: e.acl, retrieved_at: iso,
      })),
      built_at: iso,
      last_verified_at: null,
      invalidated_at: null,
      ttl_seconds: config.default_ttl_seconds,
      version: (existing?.version ?? 0) + 1,
      supersedes: existing === null ? null : `${existing.id}@${existing.version}`,
      accounting: {
        build_tokens: result.tokens_used,
        baseline_tokens: baseline,
        serve_tokens: estimateTokens(result.content),
      },
    };

    validateObject(object);
    // A lost cache write must not fail the request (spec §14) — the answer is already good.
    await store.put(object).catch(() => undefined);
    return this.serve({
      object, tier: "rebuilt", stale: false, degraded: false,
      actualTokens: result.tokens_used + object.accounting.serve_tokens,
      baselineIsEstimate: false, startedAt,
    });
  }

  protected async applyPatch(input: {
    object: IntelligenceObject; plan: RefreshPlan; req: AskRequest;
    qvec: number[]; startedAt: number;
  }): Promise<AskResponse> {
    const { object, plan, req, qvec, startedAt } = input;
    const { index, store, synthesizer, clock } = this.deps;

    const changed = await index.fetch(plan.patchEvidenceIds);
    const returned = new Set(changed.map((e) => e.id));
    // Anything we asked for and did not get back is gone, whatever the fingerprint said.
    const removed = [
      ...plan.removedEvidenceIds,
      ...plan.patchEvidenceIds.filter((id) => !returned.has(id)),
    ];

    const kept = object.evidence.filter(
      (r) => !removed.includes(r.id) && !returned.has(r.id),
    );
    if (kept.length + changed.length === 0) {
      return this.rebuild({ req, qvec, existing: object, startedAt });
    }

    let result: SynthesisResult;
    try {
      result = await synthesizer.patch(object, changed, removed);
    } catch {
      return this.rebuild({ req, qvec, existing: object, startedAt });
    }

    const iso = clock.now().toISOString();
    const evidence = [
      ...kept,
      ...changed.map((e) => ({
        id: e.id, hash: e.content_hash, source_uri: e.source_uri, acl: e.acl, retrieved_at: iso,
      })),
    ];

    const next: IntelligenceObject = {
      ...object,
      content: result.content,
      claims: result.claims,
      confidence: result.confidence,
      gaps: result.gaps,
      acl: aclUnion(evidence),
      evidence,
      built_at: iso,
      last_verified_at: null,
      invalidated_at: null,
      version: object.version + 1,
      supersedes: `${object.id}@${object.version}`,
      accounting: {
        ...object.accounting,
        build_tokens: result.tokens_used,
        serve_tokens: estimateTokens(result.content),
      },
    };

    validateObject(next);
    await store.put(next).catch(() => undefined);
    return this.serve({
      object: next, tier: "patched", stale: false, degraded: false,
      actualTokens: result.tokens_used + next.accounting.serve_tokens,
      baselineIsEstimate: true, startedAt,
    });
  }

  protected serve(input: {
    object: IntelligenceObject; tier: Tier; stale: boolean; degraded: boolean;
    actualTokens: number; baselineIsEstimate: boolean; startedAt: number;
  }): AskResponse {
    const { object } = input;
    return {
      answer: {
        content: object.content,
        claims: object.claims,
        citations: object.evidence.map((e) => ({ evidence_id: e.id, source_uri: e.source_uri })),
      },
      object_id: object.id,
      object_version: object.version,
      tier: input.tier,
      stale: input.stale,
      degraded: input.degraded,
      confidence: object.confidence,
      gaps: object.gaps,
      savings: computeSavings({
        baselineTokens: object.accounting.baseline_tokens,
        actualTokens: input.actualTokens,
        baselineIsEstimate: input.baselineIsEstimate,
      }),
      latency_ms: this.deps.clock.now().getTime() - input.startedAt,
    };
  }

  /** Nothing in the index is both relevant and readable by this caller. */
  protected serveEmpty(startedAt: number): AskResponse {
    return {
      answer: { content: "", claims: [], citations: [] },
      object_id: "",
      object_version: 0,
      tier: "rebuilt",
      stale: false,
      degraded: false,
      confidence: 0,
      gaps: ["no evidence accessible to this caller"],
      savings: computeSavings({
        baselineTokens: 0, actualTokens: 0, baselineIsEstimate: false,
      }),
      latency_ms: this.deps.clock.now().getTime() - startedAt,
    };
  }

  /** Synthesis failed. Return raw evidence so the agent still works, clearly flagged. */
  protected serveDegraded(
    evidence: Evidence[],
    baseline: number,
    startedAt: number,
  ): AskResponse {
    return {
      answer: {
        content: evidence.map((e) => e.content).join("\n\n"),
        claims: [],
        citations: evidence.map((e) => ({ evidence_id: e.id, source_uri: e.source_uri })),
      },
      object_id: "",
      object_version: 0,
      tier: "rebuilt",
      stale: false,
      degraded: true,
      confidence: 0,
      gaps: ["synthesis unavailable; raw evidence returned"],
      savings: computeSavings({
        baselineTokens: baseline, actualTokens: baseline, baselineIsEstimate: false,
      }),
      latency_ms: this.deps.clock.now().getTime() - startedAt,
    };
  }
}
```

Add to `packages/core/src/index.ts`:

```ts
export * from "./acm/context-manager.js";
```

`@knowy/core`'s `package.json` gains `@knowy/index-memory` and `@knowy/store-memory` as
**devDependencies only** (`"workspace:*"`), used by the ACM tests. Core's runtime
dependencies stay empty.

- [x] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS — every ACM test green, and the full suite still green.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: agent context manager resolving asks across all four tiers"
```

---

### Task 10: Manual refresh, invalidation, and a runnable demo

**Files:**
- Modify: `packages/core/src/acm/context-manager.ts` (add two methods)
- Create: `examples/cold-to-warm.ts`, `examples/README.md`
- Modify: root `package.json` (add the `example` script)
- Test: `packages/core/test/acm/refresh.test.ts`

**Interfaces:**
- Consumes: everything from Task 9.
- Produces: `AgentContextManager.refresh(input: { tenant_id: string; object_id: string; granted_permissions: string[]; mode?: "auto" | "rebuild" }): Promise<AskResponse>` and `AgentContextManager.invalidate(tenantId: string, selector: InvalidateSelector): Promise<number>`. Plan 2's HTTP layer calls both.

- [x] **Step 1: Write the failing test**

`packages/core/test/acm/refresh.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryIndex } from "@knowy/index-memory";
import { MemoryObjectStore } from "@knowy/store-memory";
import { AgentContextManager } from "../../src/acm/context-manager.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { FakeClock, FakeEmbedder, FakeSynthesizer } from "./doubles.js";

const QUESTION = "How long do refunds take?";

function evidence(id: string) {
  return {
    evidence: {
      id, content: "x".repeat(2400), source_uri: `confluence://${id}`,
      content_hash: `h-${id}`, acl: ["group:support"], score: 0,
    },
    embedding: [1, 0, 0],
  };
}

describe("AgentContextManager.refresh and .invalidate", () => {
  let index: MemoryIndex;
  let store: MemoryObjectStore;
  let synthesizer: FakeSynthesizer;
  let acm: AgentContextManager;
  let objectId: string;

  const ask = { tenant_id: "acme", question: QUESTION, granted_permissions: ["group:support"] };

  beforeEach(async () => {
    index = new MemoryIndex();
    store = new MemoryObjectStore();
    synthesizer = new FakeSynthesizer();
    await index.seed("acme", [evidence("a"), evidence("b"), evidence("c"), evidence("d")]);
    acm = new AgentContextManager({
      index, store, synthesizer, embedder: new FakeEmbedder(),
      config: DEFAULT_CONFIG, clock: new FakeClock(new Date("2026-09-12T00:00:00.000Z")),
      newId: () => "obj-1",
    });
    objectId = (await acm.ask(ask)).object_id;
  });

  it("refresh in auto mode uses the cheap patch tier when only one source moved", async () => {
    await index.setHash("a", "h-a-v2");
    const res = await acm.refresh({
      tenant_id: "acme", object_id: objectId, granted_permissions: ["group:support"],
    });
    expect(res.tier).toBe("patched");
    expect(synthesizer.buildCalls).toBe(1);
  });

  it("refresh in auto mode still reports verified when nothing changed", async () => {
    const res = await acm.refresh({
      tenant_id: "acme", object_id: objectId, granted_permissions: ["group:support"],
    });
    expect(res.tier).toBe("verified");
    expect(synthesizer.patchCalls).toBe(0);
  });

  it("refresh in rebuild mode always pays for a full synthesis", async () => {
    const res = await acm.refresh({
      tenant_id: "acme", object_id: objectId,
      granted_permissions: ["group:support"], mode: "rebuild",
    });
    expect(res.tier).toBe("rebuilt");
    expect(synthesizer.buildCalls).toBe(2);
  });

  it("refresh refuses an object the caller may not read", async () => {
    await expect(
      acm.refresh({ tenant_id: "acme", object_id: objectId, granted_permissions: [] }),
    ).rejects.toThrow(/permission/i);
  });

  it("refresh throws on an unknown object id", async () => {
    await expect(
      acm.refresh({ tenant_id: "acme", object_id: "nope", granted_permissions: [] }),
    ).rejects.toThrow(/not found/i);
  });

  it("an invalidated object rebuilds on the next ask even though every hash matches", async () => {
    expect(await acm.invalidate("acme", { ids: [objectId] })).toBe(1);
    const res = await acm.ask(ask);
    expect(res.tier).toBe("rebuilt");
    expect(synthesizer.buildCalls).toBe(2);
  });

  it("invalidating by source uri reaches objects built from that source", async () => {
    expect(await acm.invalidate("acme", { source_uris: ["confluence://a"] })).toBe(1);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/test/acm/refresh.test.ts`
Expected: FAIL — `acm.refresh is not a function`.

- [x] **Step 3: Implement refresh and invalidate**

Add to `AgentContextManager` in `packages/core/src/acm/context-manager.ts`, and add
`InvalidateSelector` to the `types/ports.js` import list at the top of the file:

```ts
  /**
   * Explicit refresh. `auto` still takes the cheap patch tier where it applies, so
   * "give me fresh data" is usually not a full re-synthesis (spec §7.2).
   */
  async refresh(input: {
    tenant_id: string;
    object_id: string;
    granted_permissions: string[];
    mode?: "auto" | "rebuild";
  }): Promise<AskResponse> {
    const { store, index, embedder, config, clock } = this.deps;
    const startedAt = clock.now().getTime();

    const object = await store.get(input.tenant_id, input.object_id);
    if (object === null) {
      throw new Error(`object not found: ${input.object_id}`);
    }
    const permission = isPermitted({
      object, granted: input.granted_permissions, config,
    });
    if (!permission.pass) {
      throw new Error(`permission denied: ${permission.reason}`);
    }

    const req: AskRequest = {
      tenant_id: input.tenant_id,
      question: object.canonical_question,
      granted_permissions: input.granted_permissions,
      ...(object.tags.length > 0 ? { tags: object.tags } : {}),
    };
    const qvec = (await embedder.embed([object.canonical_question]))[0];
    if (qvec === undefined) throw new Error("embedder returned no vector");

    if (input.mode === "rebuild") {
      return this.rebuild({ req, qvec, existing: object, startedAt });
    }

    const now = clock.now();
    let diff = null;
    try {
      const fps = await index.fingerprint(object.evidence.map((e) => e.id));
      diff = diffEvidence(object.evidence, fps);
    } catch (cause) {
      throw new FreshnessUnavailableError(`cannot verify freshness of ${object.id}`, { cause });
    }

    // An explicit refresh always verifies, so the invalidation flag has served its
    // purpose and must not force a rebuild on top of a clean diff.
    const plan = planRefresh({
      object: { ...object, invalidated_at: null }, diff, now, requested: "verified", config,
    });

    if (plan.tier === "verified") {
      const at = now.toISOString();
      await store.markVerified(input.tenant_id, object.id, at);
      return this.serve({
        object: { ...object, last_verified_at: at, invalidated_at: null },
        tier: "verified", stale: false, degraded: false,
        actualTokens: object.accounting.serve_tokens, baselineIsEstimate: true, startedAt,
      });
    }
    if (plan.tier === "patched") {
      return this.applyPatch({ object, plan, req, qvec, startedAt });
    }
    return this.rebuild({ req, qvec, existing: object, startedAt });
  }

  async invalidate(tenantId: string, selector: InvalidateSelector): Promise<number> {
    return this.deps.store.invalidate(tenantId, selector);
  }
```

One subtlety worth keeping: a verify-tier refresh clears `invalidated_at`, because the
fingerprint check has now answered the question the invalidation was asking. Without
that, an invalidated object would rebuild forever.

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS — every refresh test green, and the full suite still green.

- [x] **Step 5: Write the runnable demo**

`examples/cold-to-warm.ts`:

```ts
import { AgentContextManager, DEFAULT_CONFIG, type AskResponse } from "@knowy/core";
import { MemoryIndex } from "@knowy/index-memory";
import { MemoryObjectStore } from "@knowy/store-memory";

const QUESTION = "What is our refund policy?";

const CORPUS = [
  "Refunds are processed within 5 business days of approval.",
  "Refund requests must be filed within 30 days of purchase.",
  "Digital goods are non-refundable once downloaded.",
  "Enterprise contracts follow the termination clause, not the standard refund policy.",
];

const index = new MemoryIndex();
await index.seed(
  "acme",
  CORPUS.map((content, i) => ({
    evidence: {
      id: `doc-${i}`,
      content: content.repeat(20),
      source_uri: `confluence://refunds/${i}`,
      content_hash: `h-${i}`,
      acl: [],
      score: 0,
    },
    embedding: [1, 0, 0],
  })),
);

const acm = new AgentContextManager({
  index,
  store: new MemoryObjectStore(),
  embedder: { dimensions: 3, embed: async (ts) => ts.map(() => [1, 0, 0]) },
  synthesizer: {
    build: async (q, evidence) => ({
      content: `Refunds complete within 5 business days; requests must be filed within 30 days.`,
      claims: evidence.map((e) => ({ text: e.content.slice(0, 40), evidence_ids: [e.id] })),
      confidence: 0.92,
      gaps: [],
      tokens_used: 1400,
    }),
    patch: async (obj, changed) => ({
      content: obj.content,
      claims: changed.map((e) => ({ text: e.content.slice(0, 40), evidence_ids: [e.id] })),
      confidence: 0.92,
      gaps: [],
      tokens_used: 160,
    }),
  },
  config: DEFAULT_CONFIG,
  clock: { now: () => new Date() },
  newId: () => "obj-demo",
});

const ask = { tenant_id: "acme", question: QUESTION, granted_permissions: [] };

function report(label: string, r: AskResponse): void {
  console.log(
    `${label.padEnd(22)} tier=${r.tier.padEnd(9)} ` +
      `baseline=${r.savings.baseline_tokens} actual=${r.savings.actual_tokens} ` +
      `saved=${r.savings.saved_tokens}`,
  );
}

report("1. cold (miss)", await acm.ask(ask));
report("2. repeat (hit)", await acm.ask(ask));
await index.setHash("doc-0", "h-0-v2");
report("3. one source changed", await acm.ask(ask));
report("4. forced fresh", await acm.ask({ ...ask, freshness: "fresh" }));
```

`examples/README.md`:

```markdown
# Examples

## cold-to-warm

Runs the full Knowy loop against in-memory adapters — no database, no API keys.

    pnpm example

Shows four asks: a cold miss paying full synthesis, a repeat served from the object
store at zero LLM cost, a cheap patch after one source changes, and a caller-forced
rebuild.
```

Add to the root `package.json` scripts:

```json
    "example": "pnpm -r build && node --experimental-strip-types examples/cold-to-warm.ts"
```

- [x] **Step 6: Run the demo and confirm the tiers**

Run: `pnpm example`
Expected output — four lines showing `tier=rebuilt`, then `tier=verified` with
`saved` greater than zero, then `tier=patched`, then `tier=rebuilt`.

- [x] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: manual refresh, invalidation, and a runnable cold-to-warm demo"
```

---

## Done When

- `pnpm test` green: roughly 100 tests across core, index-memory, and store-memory.
- `pnpm typecheck` clean under `strict` plus `noUncheckedIndexedAccess`.
- `pnpm example` prints rebuilt → verified → patched → rebuilt with a positive saving
  on the verified line.
- The purity test passes, proving `@knowy/core` still does no I/O.
- Both conformance suites pass, so Plan 2's pgvector and Pinecone adapters have a
  runnable definition of "correct" before a line of them is written.

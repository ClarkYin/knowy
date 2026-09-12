# Knowy Plan 2 — Real Adapters, HTTP Server, and SDK

> **Agent brief.** You are implementing this plan cold, with no prior conversation
> context. Everything you need is in this file plus the two documents it references.
> Read §0 fully before writing any code — it contains contracts that are easy to
> violate and expensive to get wrong.

**Goal:** Replace Knowy's in-memory-only footing with production adapters (Postgres + pgvector, Pinecone), an HTTP API, and a typed client — so Knowy runs against a real index and real agents can call it.

**Covers:** Spec §17 milestones 5–6.

**Spec:** [docs/superpowers/specs/2026-09-12-knowy-design.md](../specs/2026-09-12-knowy-design.md) — read §7, §8, §10, §11, §12, §14, §16.

**Plan 1 (already merged, read for context):** [docs/superpowers/plans/2026-09-12-knowy-core-engine.md](./2026-09-12-knowy-core-engine.md)

---

## §0 Cold start — read this first

### What already exists

```
packages/core/          @knowy/core         pure decision engine, ZERO I/O. 102 tests green.
packages/index-memory/  @knowy/index-memory reference RawEvidenceIndex
packages/store-memory/  @knowy/store-memory reference ObjectStore
examples/cold-to-warm.ts                    runnable demo: pnpm example
```

Get oriented in this order, it takes about twenty minutes and saves far more:

1. `packages/core/src/types/ports.ts` — the four interfaces you implement against.
2. `packages/core/src/testing/index-suite.ts` and `store-suite.ts` — **the conformance
   suites. These are your acceptance criteria.** An adapter is correct when it passes
   its suite, and incorrect otherwise. Do not modify a suite to make an adapter pass.
3. `packages/core/src/acm/context-manager.ts` — how the ports get used at runtime.
4. `packages/index-memory/src/index.ts` — a complete, working reference implementation
   of every contract below. When a contract is unclear, read what MemoryIndex does.

### Setup

```bash
git clone git@github.com:ClarkYin/knowy.git && cd knowy
git checkout -b feat/adapters-and-server origin/feat/core-engine
pnpm install
pnpm test        # must be 102 passing before you change anything
pnpm example     # must print rebuilt / verified / patched / rebuilt
```

**Use pnpm. Never npm or yarn.** The repo is a pnpm workspace and npm will corrupt it.

### Five contracts that are easy to get wrong

**1. `fingerprint()` distinguishes "gone" from "could not answer".**

| Result | Meaning | Core classifies it as |
|---|---|---|
| Map has key → `Fingerprint` | Evidence exists, hash is current | unchanged or changed |
| Map has key → `null` | Evidence is **known** gone, or never existed | `deleted` |
| Map has **no key** for that id | The index **could not answer** (timeout, partial failure) | `unknown` |

Both `deleted` and `unknown` count toward churn, so both are safe. But conflating them
loses information the refresh planner uses. A successful query for a missing row returns
`null`; only a genuine failure omits the key. Never return an empty map on error —
throw, and let the ACM's `on_stale_error` policy decide.

**2. `granted` filtering must happen inside the query, not after it.**

`SearchOpts.granted` carries the caller's permission tags. Evidence is returnable only
when **every** tag on that evidence is in `granted` (see `MemoryIndex.search`). This must
be expressed in SQL / the Pinecone filter, not applied in JS after fetching, for two
reasons: post-filtering breaks `topK` (you ask for 8, filter to 3), and it moves
unreadable content through your process. When `granted` is `undefined`, do not filter —
that is the trusted internal path.

This is the mechanism behind spec §8. Getting it wrong leaks data across permission
boundaries, which is the single worst failure this system can have.

**3. `@knowy/core` does no I/O, and a test enforces it.**

`packages/core/test/purity.test.ts` fails the build if `src/` gains `fetch`, a `node:`
import, `process.env`, `new Date()`, or `Date.now()`. Time enters core through the
injected `Clock` port. Your adapters are free to do all of these — the constraint binds
core only. If you need something from core that would require I/O, the design is wrong;
pass it in instead.

**4. Content hashes may be derived.**

`IndexCapabilities.hashing` is `"native"` when the store holds a real content hash and
`"derived"` when you compute a stand-in from whatever change signal exists (`updated_at`,
an ETag, a revision number). Both are valid. What matters is that the value **changes
when the content changes** and is **stable when it does not** — a hash derived from a
timestamp that updates on unrelated writes causes needless rebuilds and quietly destroys
the product's economics.

**5. `capabilities().acl` drives `acl_complete` on every object.**

Return `acl: false` only if your index genuinely cannot report per-evidence ACL tags.
Under the default `acl_mode: "strict"`, objects built from such an index are never served
from cache — correct, but it turns Knowy into a pure pass-through. Do not return `false`
for convenience.

### Coordination — another agent is working in this repo simultaneously

| Owner | Packages | Branch |
|---|---|---|
| **You** | `store-postgres`, `index-pgvector`, `index-pinecone`, `server`, `sdk`, `apps/node` | `feat/adapters-and-server` |
| Other agent | `llm-anthropic`, `mcp`, `plugins/slack`, `calibration/` | `feat/mcp-slack-calibration` |

Rules that keep this collision-free:

- **You own the only change to `@knowy/core` in this plan:** adding `stats()` to the
  `ObjectStore` port (Task 7). The other agent does not touch `ObjectStore`. Do it in one
  commit, touching `types/ports.ts`, `testing/store-suite.ts`, and `store-memory`.
- Any *other* core change: stop and ask before making it.
- `pnpm-lock.yaml` and the root `package.json` will conflict. Expect it, take both sides,
  re-run `pnpm install`, commit the regenerated lockfile.
- Do not edit `examples/`, `packages/index-memory`, or `docs/superpowers/specs/`.

### Definition of done

- `pnpm test` green, including both conformance suites against every new adapter.
- `pnpm typecheck` exit 0.
- CI green on your branch.
- `docker compose up -d && pnpm test:integration` green against real Postgres.
- A PR against `main` describing what you built and anything you deviated from.

---

## Task 1 — Postgres test harness

**Files:** `docker-compose.yml`, `packages/store-postgres/{package.json,tsconfig.json}`, `packages/store-postgres/src/migrate.ts`, `packages/store-postgres/migrations/001_init.sql`, `vitest.integration.config.ts`, root `package.json` (add `test:integration`)

Integration tests must be opt-in so the default `pnpm test` stays infrastructure-free and fast. Gate them on `KNOWY_TEST_PG_URL`; skip with a clear message when unset.

```yaml
# docker-compose.yml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_PASSWORD: knowy
      POSTGRES_DB: knowy_test
    ports: ["5433:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 2s
      retries: 15
```

Migrations are plain numbered SQL applied in order by a tiny runner that records applied
filenames in a `knowy_migrations` table. No migration framework — it is twenty lines and
one fewer dependency.

**Schema.** `embedding` dimensions must be configurable, because embedding models differ
(1536 for text-embedding-3-small, 1024 for voyage-3). Take it as a migration parameter,
default 1536.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowy_objects (
  tenant_id           text        NOT NULL,
  id                  text        NOT NULL,
  version             integer     NOT NULL,
  scope               text        NOT NULL,
  canonical_question  text        NOT NULL,
  content             text        NOT NULL,
  claims              jsonb       NOT NULL,
  confidence          real        NOT NULL,
  gaps                jsonb       NOT NULL,
  embedding           vector(1536) NOT NULL,
  tags                text[]      NOT NULL,
  acl                 text[]      NOT NULL,
  acl_complete        boolean     NOT NULL,
  evidence            jsonb       NOT NULL,
  built_at            timestamptz NOT NULL,
  last_verified_at    timestamptz,
  invalidated_at      timestamptz,
  ttl_seconds         integer     NOT NULL,
  supersedes          text,
  accounting          jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id, version)
);

-- searchSimilar only ever reads the latest version of each object.
CREATE INDEX knowy_objects_latest ON knowy_objects (tenant_id, id, version DESC);
CREATE INDEX knowy_objects_embedding ON knowy_objects
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX knowy_objects_tags ON knowy_objects USING gin (tags);
CREATE INDEX knowy_objects_acl  ON knowy_objects USING gin (acl);
```

**Verify:** `docker compose up -d`, migration runner applies cleanly, is idempotent on a
second run, and `\d knowy_objects` shows every index.

---

## Task 2 — `@knowy/store-postgres`

**Files:** `packages/store-postgres/src/index.ts`, `packages/store-postgres/test/conformance.test.ts`

Implement `ObjectStore` (see `packages/core/src/types/ports.ts`) on `pg`.

```ts
import { runStoreConformance } from "@knowy/core/testing";
import { PostgresObjectStore } from "../src/index.js";

const url = process.env.KNOWY_TEST_PG_URL;
if (url === undefined) {
  console.warn("KNOWY_TEST_PG_URL unset — skipping PostgresObjectStore conformance");
} else {
  runStoreConformance("PostgresObjectStore", async () => {
    const store = new PostgresObjectStore({ url, dimensions: 3 });
    await store.truncateForTests();
    return store;
  });
}
```

The suite fixtures use 3-dimensional embeddings, so make dimensions a constructor option
rather than a hardcoded constant.

Points where a naive implementation fails the suite:

- **`get(tenantId, id)` with no version returns the *latest* version**, not the first row.
- **`searchSimilar` returns at most one row per object id** — the latest version only.
  A `DISTINCT ON (id) ... ORDER BY id, version DESC` subquery, then rank by distance.
- **`minScore` is cosine *similarity*; pgvector's `<=>` is cosine *distance*.**
  `similarity = 1 - distance`. Filter on `1 - (embedding <=> $1) >= $minScore`.
- **`invalidate` sets `invalidated_at` on the latest version only** and returns the count
  of objects touched, not rows scanned. Selectors compose as OR: `ids`, `tags`,
  `source_uris` (matched against `evidence[].source_uri` inside the JSONB), `all`.
- **`markVerified` updates `last_verified_at` in place and must not change `version`.**

**Verify:** `KNOWY_TEST_PG_URL=... pnpm test:integration` — all 13 store conformance tests green.

---

## Task 3 — `@knowy/index-pgvector`

**Files:** `packages/index-pgvector/**`, plus `migrations/002_evidence.sql`

The built-in default index, so a deployment needs one database for both object store and
evidence index.

```sql
CREATE TABLE knowy_evidence (
  tenant_id    text         NOT NULL,
  id           text         NOT NULL,
  content      text         NOT NULL,
  source_uri   text         NOT NULL,
  content_hash text         NOT NULL,
  acl          text[]       NOT NULL,
  embedding    vector(1536) NOT NULL,
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX knowy_evidence_embedding ON knowy_evidence
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX knowy_evidence_acl ON knowy_evidence USING gin (acl);
```

`capabilities()` returns `{ acl: true, hashing: "native" }`.

**ACL filtering in SQL** — the tags on the row must be a subset of the caller's grants,
which in Postgres array terms is `acl <@ $granted::text[]`. Apply it in the `WHERE`
clause of the search, before `LIMIT`. Omit the clause entirely when `granted` is undefined.

**`fingerprint(ids)`** — one `WHERE id = ANY($1)` query. Every requested id that the query
successfully covers gets an entry: a `Fingerprint` if the row exists, `null` if it does
not. The map has a key for every id you asked about. If the query itself throws, let it
throw.

Ship a `seed()` helper for tests and examples; the harness in the conformance suite needs
`seed`, `setHash`, `remove`, and `failFor`. `failFor` simulates partial failure — keep a
set of ids to omit from `fingerprint` results.

**Verify:** all 12 index conformance tests green against Postgres.

---

## Task 4 — `@knowy/index-pinecone`

**Files:** `packages/index-pinecone/**`

This package exists to prove the adapter interface is real. An interface with one
implementation is a guess. Expect to discover that `RawEvidenceIndex` has a
Postgres-shaped assumption in it — **if you find one, report it rather than working
around it in the adapter.** That discovery is this task's main value.

Mapping notes:

- ACLs go in Pinecone metadata as a string array; filter with `{"acl": {"$in": granted}}`
  — but note `$in` is *any-of*, while the contract is *every tag must be granted*. Pinecone
  has no subset operator, so store a precomputed `acl_key` (sorted tags joined, or a hash)
  and filter on membership in the set of permitted keys the caller could satisfy. If that
  proves impractical at scale, **say so in the PR** — it is a real finding about ACL
  modelling, not a defect in your work.
- `fingerprint` uses `fetch` by id, which returns only found vectors. Ids absent from the
  response are `null` (known gone), not omitted — omission is reserved for a thrown request.
- `capabilities()` returns `{ acl: true, hashing: "derived" }` unless you store a real hash.

Gate the suite on `KNOWY_TEST_PINECONE_KEY`; skip cleanly when unset so CI stays green
without a Pinecone account.

---

## Task 5 — Auth and tenant resolution

**Files:** `packages/server/src/auth.ts` and tests

An API key resolves to `{ tenant_id, granted_permissions }`. Ship a pluggable
`KeyResolver` interface with one static env-backed implementation; real deployments
supply their own. Constant-time comparison, no key material in logs or error messages.

Tenant is taken **from the resolved key, never from the request body** — a tenant id a
caller can set is not a boundary.

---

## Task 6 — HTTP server

**Files:** `packages/server/src/{app.ts,routes/*.ts}`, tests using in-memory adapters

Hono, chosen so the same code runs on Node now and Workers later.

```
POST /v1/ask                  { question, freshness?, tags?, max_tokens? } -> AskResponse
GET  /v1/objects/:id          -> IntelligenceObject (404 when absent, 403 when ACL denies)
POST /v1/objects/:id/refresh  { mode?: "auto" | "rebuild" } -> AskResponse
POST /v1/invalidate           { selector: {...} } -> { invalidated: number }
GET  /v1/healthz              liveness
GET  /v1/readyz               readiness — see below
```

Every route is a thin shell: validate input, resolve auth, call the `AgentContextManager`,
serialize. **No domain logic in the server.** If you find yourself making a freshness or
permission decision in a route handler, it belongs in core.

Error mapping: `FreshnessUnavailableError` → 503. Permission denial → 403. Unknown object
→ 404. Validation failure → 400 naming the field. Everything else → 500 with a correlation
id, never an internal message.

**`readyz` checks the embedding dimension** of the configured embedder against the stored
objects' dimension and fails if they disagree (spec §14). A dimension mismatch is a
configuration error that would otherwise surface as garbage similarity scores at runtime —
catch it at startup.

Test the whole request path against in-memory adapters so these tests need no database.

---

## Task 7 — `/v1/stats` and OpenTelemetry

**This is the one task that modifies `@knowy/core`.** Do it in a single commit.

Add to `ObjectStore` in `packages/core/src/types/ports.ts`:

```ts
export interface Window { from: string; to: string }

export interface StatsSnapshot {
  asks: number;
  by_tier: Record<Tier, number>;
  tokens_saved: number;
  tokens_spent: number;
}

// on ObjectStore:
stats(tenantId: string, window: Window): Promise<StatsSnapshot>;
```

Then: add stats cases to `packages/core/src/testing/store-suite.ts`, implement in
`store-memory` and `store-postgres`. Serving stats requires recording each ask, so add an
append-only `knowy_asks` table (tenant, tier, saved, spent, at) written on the serve path.

Emit the same figures as OTel metrics: hit rate by tier, tokens saved, synthesis latency,
staleness distribution, coverage-gate rejections. **Coverage-gate rejections matter most** —
a rising rejection rate is the earliest signal that `match_threshold` is mistuned.

---

## Task 8 — `@knowy/sdk`

**Files:** `packages/sdk/**`

Typed client over the HTTP API: every endpoint, configurable timeout, retry with
exponential backoff on 5xx and 429 only (**never retry a 4xx, and never retry a rebuild —
it is the expensive path**), and a streaming variant of `ask`.

The other agent's MCP server consumes this package, so treat its surface as public API
and keep `AskResponse` identical to core's type rather than redefining it.

---

## Task 9 — `apps/node` and Docker

**Files:** `apps/node/**`, `Dockerfile`, `README` deployment section

A composition root: read config, construct adapters, start the server. Multi-stage
Dockerfile, non-root user, healthcheck hitting `/v1/healthz`. Document every environment
variable and every tunable from spec §16 with its default.

Finish with `docker compose up` bringing up Postgres and the server together, and a
documented curl that returns a real `AskResponse`.

---

## Reporting back

Open a PR against `main`. In the description cover: what you built, conformance status per
adapter, anything in this plan that turned out wrong, and — most valuable — **any place
where `RawEvidenceIndex` or `ObjectStore` fitted Postgres but fought Pinecone.** Those are
findings about the abstraction, and they are worth more than the adapter code.

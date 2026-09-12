# Knowy — Design Spec

**Date:** 2026-09-12
**Status:** Approved for implementation planning
**Scope:** v1 of the Knowy structural operational layer

---

## 1. Problem

Enterprises have already indexed their knowledge. They run Pinecone, Weaviate, Vertex
AI Search, Elastic, or pgvector over Confluence, Drive, Notion, ticket systems, and
wikis. That investment is done.

What they do not have is a layer that stops every agent from re-paying for it.

Today each agent question triggers the same sequence: embed the question, retrieve the
top-k raw chunks, stuff several thousand tokens of partially relevant text into the
context window, and ask an LLM to figure it out. Ten agents asking overlapping
questions run that sequence ten times. The same question asked tomorrow runs it again.
Nothing is remembered, nothing is reused, and the token bill scales linearly with
usage while the underlying knowledge barely changes.

Knowy is the operational layer between agents and an existing index. It synthesizes
retrieved evidence once into a durable, citation-bearing **intelligence object**,
serves that object to any agent that asks a semantically equivalent question, and
rebuilds it only when the underlying sources actually change.

## 2. Goals

1. **Cut tokens per answered question** by serving distilled objects instead of raw
   chunk dumps, and by not re-synthesizing what has not changed.
2. **Stay a layer, not a silo.** Read through adapters over the index the customer
   already runs. Knowy owns only its own object store and object embeddings.
3. **Connect to any agent.** MCP as the primary surface, a plain HTTP API underneath,
   and a Slack plugin proving third parties can build on it.
4. **Never serve a stale answer silently,** and make getting fresh data both explicit
   and cheap.
5. **Never launder permissions.** A cached object must not reach a caller who could
   not have read the evidence behind it.
6. **Measure the token claim** rather than assert it.

## 3. Non-goals for v1

- Admin / observability web UI. Metrics ship over OpenTelemetry plus a `/v1/stats`
  endpoint; a console can read those later without redesign.
- Proactive topic-scoped object building on a schedule. The object model reserves a
  `scope` field so this is additive, not a rewrite.
- Source-system connectors and change webhooks. The `invalidate` API exists as the
  hook; the connectors that call it do not ship in v1.
- Non-text evidence (images, audio, tables as first-class structures).
- A Cloudflare Workers deployment target. The architecture is structured so this is a
  second entry under `apps/`, but v1 ships Node/Docker only.

## 4. Core concepts

**Evidence** — one retrievable unit in the customer's existing index: a chunk, a
passage, a record. Knowy never stores evidence content durably; it stores references
and hashes.

**Fingerprint** — the tuple `(evidence_id, content_hash, exists)` that lets Knowy ask
"has this changed?" without transferring content. This is the one capability Knowy
requires of an index adapter beyond search.

**Intelligence Object** — the unit of value. A synthesized, citation-bearing digest
that answers a canonical question, plus everything needed to decide whether it is
still true: the evidence set it was built from, those evidence hashes, a TTL, an ACL
set, and cost accounting.

**Agent Context Manager (ACM)** — the request-path orchestrator. Resolves a question
to an object, decides which refresh tier is needed, and returns the answer with
citations and savings accounting.

**Intelligence Builder** — the synthesis path. Turns retrieved evidence into an
object (`build`), or revises an existing object against only the evidence that changed
(`patch`).

## 5. Architecture

```
                  ┌──────────────────────┐
   Agent ────────▶│ Agent Context Manager│◀──── MCP / HTTP / Slack
                  └──────────┬───────────┘
                             │ 1. embed question
                             │ 2. search object index
                             ▼
                  ┌──────────────────────┐
                  │ Intelligence Object  │
                  │        Store         │
                  └──────────┬───────────┘
                             │ 3. candidate objects
                             ▼
                      ╱──────────────╲
                     ╱ Freshness Check ╲──── sources unchanged ──▶ serve (0 LLM tokens)
                     ╲   (fingerprints) ╱
                      ╲──────────────╱
                             │ changed or missing
                             ▼
                  ┌──────────────────────┐        ┌──────────────────────┐
                  │  Vector DB — raw     │───────▶│ Intelligence Builder │
                  │   evidence index     │        │    (LLM synthesis)   │
                  │   (customer-owned)   │        └──────────┬───────────┘
                  └──────────────────────┘                   │
                             ▲                               │ new/revised object
                             │  object embedding             ▼
                             └──────── for discovery ───  Object Store
```

The loop is reactive: objects are created on demand when no fresh object covers an
incoming question, never speculatively. Objects are embedded back into the index so
future questions discover a *synthesized answer* semantically rather than only raw
chunks — that embedding is what makes the hit rate viable.

### 5.1 Why semantic object lookup, not keyed cache

Natural-language questions vary infinitely. An exact-match or normalized-string cache
would almost never hit. Objects are therefore found by embedding the incoming question
and searching the object index by cosine similarity, then gated on a coverage check.
This is the single design decision that separates a useful hit rate from a useless one.

## 6. Request lifecycle

`ask(question, opts)` resolves as follows.

1. **Authenticate and scope.** Resolve `tenant_id` and the caller's granted permission
   set from the API credential. Every subsequent store and index query is partitioned
   by `tenant_id`.
2. **Embed.** `qvec = embedder.embed(question)`.
3. **Discover.** `objectStore.searchSimilar(qvec, { tenant_id, topK: 5, minScore: 0.82 })`.
4. **Filter by permission.** Drop any candidate whose `acl` set is not a subset of the
   caller's granted set. See §8.
5. **Gate on coverage.** A candidate is servable when
   `match_score >= match_threshold` (default `0.86`) **and**
   `object.confidence >= min_confidence` (default `0.6`).
   Candidates are considered in descending `match_score`; the first that resolves wins.
6. **Resolve freshness** for that candidate per the requested tier. See §7.
7. **Miss** — no candidate passes steps 4–6 — falls through to a full rebuild:
   `index.search(qvec)` → evidence → `synthesizer.build` → `store.put` → serve.
8. **Respond** with the answer, citations, the tier that served it, and the savings
   block.

## 7. Freshness and refresh

Every object records the exact evidence IDs and content hashes it was built from, plus
a TTL. A request resolves through three tiers; Knowy selects the cheapest tier that is
still correct.

| Tier | Condition | Cost |
|---|---|---|
| **Verify** | All fingerprints match and TTL is valid | One metadata query. **Zero LLM tokens.** |
| **Patch** | Some evidence changed, churn at or below `churn_threshold` (default `0.4`) | Synthesizer receives only the changed evidence plus the existing object and returns a targeted revision. Typically 10–20% of a rebuild. |
| **Rebuild** | Object missing, churn above threshold, or coverage gate failed | Full retrieval plus synthesis. The expensive path, taken rarely. |

`churn_ratio = (changed_count + deleted_count) / total_evidence_count`.

### 7.1 Caller control

The `freshness` parameter is accepted on every ask across every surface:

- **`"cached"`** — serve if `now < built_at + ttl`, skipping the fingerprint check
  entirely. Fastest, one store read, no index round-trip.
- **`"verified"`** *(default)* — run the fingerprint check and resolve to verify,
  patch, or rebuild.
- **`"fresh"`** — force a rebuild, ignoring anything cached.

### 7.2 Manual refresh

- `refresh(object_id, { mode: "auto" | "rebuild" })` — `auto` still uses the patch
  tier where it applies, so an explicit "get me fresh data" is usually cheap rather
  than a full re-synthesis. `rebuild` forces the expensive path.
- `invalidate(selector)` — marks objects stale by `ids`, `source_uris`, `tags`, or
  whole tenant. This is the hook a customer's ETL, or a future source connector, calls
  to mark objects stale early. Push invalidation is therefore an *optimization* layered
  on a baseline that is already correct without it, never a correctness dependency.
- In Slack: `/knowy refresh <question>` and a **Refresh** button on every answer.

### 7.3 Fail-safe direction

A fingerprint lookup that errors or times out counts as **changed**, never as
unchanged. Knowy's failure mode is spending tokens, not serving a stale answer.

## 8. Permission-aware caching

Any cache in front of retrieval risks becoming a permission-laundering machine: user A
can read a document, an object is synthesized from it, and user B — who cannot read
that document — receives the synthesis.

Knowy's rule: **an object stores the union of the ACL tags of all evidence it was built
from.** The ACM serves an object only when `object.acl ⊆ caller.granted_permissions`.

This is conservative by construction. A caller with narrower permissions than the
object's evidence union gets a miss and a fresh, correctly-scoped build. The check can
cause extra misses; it cannot leak.

- ACL tags are opaque strings supplied by the index adapter per evidence item
  (a group ID, a space key, a classification label). Knowy does not interpret them.
- An adapter that cannot supply ACL tags returns the empty set, and the deployment must
  set `acl_mode: "tenant_only"` explicitly — an operator decision, never a silent
  default. `acl_mode: "strict"` is the default and refuses to serve objects built from
  evidence with unknown ACLs.
- `tenant_id` is a hard partition above ACLs, enforced in every store and index query,
  not as a post-filter.

## 9. Token accounting

Token reduction is the product's headline claim, so it is measured. Savings come from
three distinct places:

1. **Digest instead of chunks** — a ~400-token object in place of, say, 8 × ~600-token
   raw chunks at serve time.
2. **No re-synthesis when fresh** — the verify tier costs zero LLM tokens.
3. **Patch instead of rebuild** when only part of the evidence set moved.

Every response carries:

```ts
savings: {
  baseline_tokens: number        // what naive top-k raw retrieval would have cost
  actual_tokens: number          // what this request actually cost
  saved_tokens: number
  baseline_is_estimate: boolean  // true when reused from build time
}
```

`baseline_tokens` is recorded honestly at build time, when full retrieval genuinely
ran and the raw chunk token count is known. On subsequent hits it is reused and
flagged `baseline_is_estimate: true`. Aggregated per tenant over a window, this is both
the ROI dashboard and the regression test — a change that quietly degrades hit rate
shows up as reduced aggregate savings.

## 10. Adapter interfaces

Four interfaces carry every external dependency. `@knowy/core` depends on these types
and nothing else.

```ts
interface RawEvidenceIndex {
  search(query: SearchQuery, opts: SearchOpts): Promise<Evidence[]>
  // SearchOpts carries `granted`, so the index returns only evidence the caller may read
  fetch(ids: string[]): Promise<Evidence[]>   // patch tier needs changed content by id
  fingerprint(ids: string[]): Promise<Map<string, Fingerprint | null>>
  capabilities(): IndexCapabilities   // { acl: boolean, hashing: "native" | "derived" }
}

interface ObjectStore {
  get(tenantId: string, id: string, version?: number): Promise<IntelligenceObject | null>
  // version omitted returns the latest; an explicit version reads history (§11)
  put(obj: IntelligenceObject): Promise<void>
  searchSimilar(tenantId: string, vec: number[], opts: SimilarOpts): Promise<ScoredObject[]>
  invalidate(tenantId: string, selector: InvalidateSelector): Promise<number>
  markVerified(tenantId: string, id: string, at: string): Promise<void>
  stats(tenantId: string, window: Window): Promise<StatsSnapshot>   // added with §12.5
}

interface Synthesizer {
  build(question: string, evidence: Evidence[]): Promise<SynthesisResult>
  patch(obj: IntelligenceObject, changed: Evidence[], removed: string[]): Promise<SynthesisResult>
}

interface Embedder {
  embed(texts: string[]): Promise<number[][]>
  dimensions: number
}
```

`SynthesisResult` carries `{ content, claims, confidence, gaps, tokens_used }`.
`confidence` and `gaps` are the synthesizer's self-report on whether the evidence
actually answered the question; `confidence` feeds the coverage gate in §6 step 5.

### 10.1 The fingerprint requirement

`fingerprint()` distinguishes two outcomes that are easy to conflate: a **`null` value**
means the index knows the evidence is gone or never existed, while an **absent key**
means the index could not answer. The first is a deletion, the second is a partial
failure, and §7.3 counts both toward churn.

`fingerprint()` is the one non-obvious demand Knowy places on a customer's existing
index: it must report, cheaply and without returning content, whether an evidence ID
still exists and whether its content changed. Every serious vector database supports
this through metadata filtering. Where an index stores no content hash natively, the
adapter derives one (`capabilities().hashing === "derived"`) from whatever change
signal exists — `updated_at`, an ETag, a revision number.

### 10.2 Conformance suite

Every `RawEvidenceIndex` and `ObjectStore` implementation is validated against one
shared conformance test suite exported from `@knowy/core/testing`. "Does Weaviate work
with Knowy?" therefore has a runnable answer rather than an opinion.

**Two index implementations ship in v1 deliberately.** An adapter interface with a
single implementation is not an abstraction, it is a guess.

## 11. Data model

```ts
interface IntelligenceObject {
  id: string
  tenant_id: string
  scope: "query" | "topic"        // v1 always "query"; "topic" reserved
  canonical_question: string
  content: string                 // markdown digest — the payload served to agents
  claims: Claim[]                 // [{ text, evidence_ids }] — citation-bearing
  confidence: number              // 0..1, synthesizer self-report
  gaps: string[]                  // what the evidence did not cover
  embedding: number[]             // of canonical_question — discovery
  tags: string[]
  acl: string[]                   // union of evidence ACL tags
  acl_complete: boolean           // false when the index could not report ACLs (§8)
  evidence: EvidenceRef[]         // [{ id, hash, source_uri, acl, retrieved_at }]
  built_at: string                // ISO 8601
  last_verified_at: string | null // mutable; TTL is measured from this when set
  invalidated_at: string | null   // set by invalidate(); forces a rebuild (§7.2)
  ttl_seconds: number
  version: number
  supersedes: string | null
  accounting: {
    build_tokens: number
    baseline_tokens: number
    serve_tokens: number
  }
}
```

Objects are **immutable per version**. A patch or rebuild writes a new version with
`supersedes` pointing at the previous one, so an answer an agent acted on remains
auditable. Retention of superseded versions is configurable (default: 30 days).

Three fields are deliberately *mutable* metadata rather than versioned content:

- `last_verified_at` — a verify-tier hit on a TTL-expired object proves the object is
  still true, so it extends the freshness window without creating a new version.
  Effective expiry is `(last_verified_at ?? built_at) + ttl_seconds`. Without this,
  every request after TTL expiry would re-run the fingerprint check.
- `invalidated_at` — set by `invalidate()`. A caller invalidates because they know
  something the fingerprints cannot see, so an invalidated object forces a **rebuild**
  even when every hash still matches.
- `acl_complete` — recorded at build time from `index.capabilities().acl`. Under
  `acl_mode: "strict"` an object with `acl_complete: false` is never served from cache.

Persistence in `@knowy/store-postgres`: one `objects` table with a `vector` column for
`embedding` (pgvector, IVFFlat index), a JSONB column for `evidence`, and a GIN index
on `acl` and `tags`. `(tenant_id, id, version)` is the primary key.

## 12. Public surfaces

The HTTP API is the substrate. MCP and Slack are thin clients over `@knowy/sdk` and
contain no domain logic of their own.

### 12.1 HTTP API

```
POST /v1/ask                    { question, freshness?, tags?, max_tokens? }
GET  /v1/objects/:id
POST /v1/objects/:id/refresh    { mode?: "auto" | "rebuild" }
POST /v1/invalidate             { selector: { ids?, source_uris?, tags?, all? } }
GET  /v1/stats?window=24h
GET  /healthz
GET  /readyz
```

`AskResponse`:

```ts
{
  answer: {
    content: string
    claims: Claim[]
    citations: { evidence_id: string, source_uri: string }[]
  }
  object_id: string
  object_version: number
  tier: "cached" | "verified" | "patched" | "rebuilt"
  stale: boolean          // freshness could not be verified (see §14)
  degraded: boolean       // synthesis failed; `content` is raw evidence, not a digest
  confidence: number
  gaps: string[]
  savings: Savings
  latency_ms: number
}
```

Auth is a bearer API key mapping to `(tenant_id, granted_permissions)`. Framework is
Hono, chosen because it runs unchanged on Node today and on Workers later.

### 12.2 MCP server

Tools: `knowy_ask`, `knowy_get_object`, `knowy_refresh`, `knowy_invalidate`. Runs over
both stdio (local agents, Claude Code, Cursor) and streamable HTTP (hosted). Tool
descriptions state explicitly that `knowy_ask` returns a pre-synthesized, cited digest,
so an agent does not additionally fan out to raw retrieval.

### 12.3 TypeScript SDK

`@knowy/sdk` — a typed client over the HTTP API with retries, timeouts, and a
streaming variant of `ask`. Every other surface consumes it.

### 12.4 Slack plugin

The reference plugin, and the demo:

- `/knowy <question>` — answers in-channel with the digest, a citations context block,
  and a footer showing tier and tokens saved.
- `/knowy refresh <question>` — explicit refresh.
- `@knowy` mention in a thread — answers with the thread as extra context.
- A **Refresh** button on every answer, re-running at `freshness: "fresh"`.

Built on Slack Bolt. Slack user identity maps to Knowy permissions through a
configurable mapping so §8 holds inside Slack too.

### 12.5 Observability

Structured OpenTelemetry metrics: hit rate by tier, tokens saved, synthesis latency,
staleness distribution, coverage-gate rejections. `/v1/stats` exposes the same
aggregates over JSON for anyone without an OTel collector.

## 13. Repository layout

pnpm workspace monorepo, TypeScript throughout, strict mode, ESM.

```
knowy/
├─ packages/
│  ├─ core/              @knowy/core            pure domain, zero I/O
│  ├─ server/            @knowy/server          HTTP API (Hono)
│  ├─ sdk/               @knowy/sdk             typed HTTP client
│  ├─ mcp/               @knowy/mcp             MCP server over the SDK
│  ├─ index-memory/      @knowy/index-memory    in-memory index (tests, examples)
│  ├─ index-pgvector/    @knowy/index-pgvector  built-in default index
│  ├─ index-pinecone/    @knowy/index-pinecone  second implementation
│  ├─ store-postgres/    @knowy/store-postgres  object store
│  └─ llm-anthropic/     @knowy/llm-anthropic   synthesizer + embedder
├─ plugins/
│  └─ slack/             @knowy/plugin-slack
├─ apps/
│  └─ node/              Docker-deployable runtime (server + MCP)
├─ examples/             runnable end-to-end demos, no external infra
└─ docs/
```

### 13.1 The core boundary

`@knowy/core` contains no network calls, no database, no SDK imports, and no
environment access. It holds:

- the object model and its invariants
- the **freshness engine** — fingerprint diffing, churn ratio, tier selection
- the **refresh planner** — which tier, which evidence to send to a patch
- the **coverage gate** — match score and confidence thresholds
- **token accounting** — baseline and actual computation
- the **permission gate** — ACL subset checks
- the conformance suite exported at `@knowy/core/testing`

Everything interesting is therefore a pure function over plain data: fast to test,
trivially portable, and the reason a Workers deployment later is an `apps/` entry
rather than a fork.

### 13.2 Why adapters are separate packages

Each adapter carries its own heavyweight dependency (`pg`, the Pinecone SDK, the
Anthropic SDK). Bundling them into one package would force every deployment to install
all of them. Separate packages keep installs honest.

**Built-in default: Postgres + pgvector.** One dependency serves both the object store
and the default raw evidence index, and any enterprise able to run Knowy already runs
Postgres. `index-memory` exists so the test suite and `examples/` need no
infrastructure at all.

## 14. Error handling and degradation

| Failure | Behavior |
|---|---|
| Index unreachable during fingerprint check | Serve the object flagged `stale: true`. Configurable per tenant to hard-fail via `on_stale_error: "serve_stale" \| "fail"`; default `serve_stale`. |
| Index unreachable during a rebuild | Fail the request with `503`. There is nothing honest to serve. |
| Partial fingerprint response | Missing entries count as **changed** (§7.3). |
| Synthesizer failure or timeout | Degrade to returning the raw retrieved evidence, flagged `degraded: true` and `confidence: 0`. The agent still works; the response is explicitly not a Knowy digest. |
| Synthesizer returns `confidence` below `min_confidence` | Store the object (it records what the evidence could not answer via `gaps`) but return it flagged, with `gaps` populated so the agent can escalate. |
| Object store write failure after successful synthesis | Serve the answer, log the write failure, emit a metric. A lost cache write is not a failed request. |
| Embedding dimension mismatch against stored objects | Fail fast at startup in `readyz`, not per request. |
| Evidence ACL unknown and `acl_mode: "strict"` | Do not serve the cached object; rebuild scoped to the caller. |

## 15. Testing strategy

TDD throughout, per the project's standard workflow. Tests are written before the
implementation they cover.

1. **Core unit tests** — pure functions, no mocks, no infrastructure. Freshness tier
   selection, churn math, coverage gating, ACL subset logic, and token accounting are
   all table-driven. This is the bulk of the test suite and it runs in under a second.
2. **Adapter conformance suite** — one shared suite every `RawEvidenceIndex` and
   `ObjectStore` implementation must pass, run against `index-memory` in CI by default
   and against pgvector and Pinecone behind an integration flag.
3. **Integration tests** — server, MCP, and Slack surfaces against in-memory adapters,
   so the full request path is exercised without Postgres or a network.
4. **Calibration harness** — a seeded corpus plus a set of golden question pairs
   (known-equivalent and known-distinct) measuring hit rate, false-hit rate, and
   aggregate token savings. This is how `match_threshold`, `min_confidence`, and
   `churn_threshold` get tuned rather than guessed, and it runs as a regression check
   so a change that quietly wrecks the hit rate fails CI.

A **false hit — serving an object that does not actually answer the question — is the
most damaging failure mode in the system** and the calibration harness exists primarily
to keep it measured.

## 16. Configuration

Adapters are wired in a typed `knowy.config.ts`; secrets and per-deployment values come
from the environment. Tunables and their defaults:

| Key | Default | Meaning |
|---|---|---|
| `match_threshold` | `0.86` | Minimum object similarity to serve |
| `discovery_top_k` | `5` | Candidate objects considered per ask |
| `discovery_min_score` | `0.82` | Minimum similarity to consider a candidate |
| `min_confidence` | `0.6` | Minimum synthesizer confidence to serve |
| `churn_threshold` | `0.4` | Above this, patch becomes rebuild |
| `default_ttl_seconds` | `86400` | Object TTL |
| `retrieval_k` | `8` | Raw chunks retrieved on a rebuild |
| `acl_mode` | `"strict"` | `strict` or `tenant_only` |
| `on_stale_error` | `"serve_stale"` | Behavior when freshness cannot be verified |
| `superseded_retention_days` | `30` | Version history retention |

## 17. Build order

Each milestone is independently verifiable and leaves the repo in a working state.

1. **Workspace and core model.** pnpm workspace, TypeScript config, CI, `@knowy/core`
   types and invariants. Verified by: unit tests pass, `pnpm build` clean.
2. **Freshness engine and refresh planner.** Pure tier selection, churn math, coverage
   gate, ACL gate, token accounting. Verified by: table-driven unit tests covering
   every tier transition.
3. **In-memory adapters plus the conformance suite.** Verified by: `index-memory` and
   an in-memory object store both pass conformance.
4. **The ACM end to end on in-memory adapters.** Full ask → discover → gate → freshness
   → build loop. Verified by: integration tests showing a cold miss then a warm
   zero-token hit.
5. **Real adapters.** `store-postgres`, `index-pgvector`, `llm-anthropic`, then
   `index-pinecone`. Verified by: conformance suite green against each.
6. **HTTP server and SDK.** Auth, all endpoints, OTel metrics, `/v1/stats`. Verified
   by: integration tests over the running server.
7. **MCP server, then the Slack plugin, then the calibration harness.** Verified by:
   an MCP client completing an ask; Slack answering a slash command; the harness
   reporting hit rate and savings on the seeded corpus.

## 18. Open decisions deferred, deliberately

- **Object promotion** (query-scoped objects earning topic-scoped status with scheduled
  refresh). The `scope` field reserves it; the heuristics need real usage data.
- **Cross-object composition** — answering from two partially-covering objects rather
  than rebuilding. Attractive, but it multiplies the false-hit risk and should wait
  until the calibration harness can measure it.
- **Self-hosted embedding models.** The `Embedder` interface allows it; v1 ships one
  hosted implementation.

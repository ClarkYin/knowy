# Knowy

**A structural operational layer between AI agents and the knowledge an enterprise has already indexed.**

Agents re-pay for retrieval on every question: embed, pull top-k raw chunks, push thousands
of tokens into context, synthesize. Ten agents asking overlapping questions run that
sequence ten times. The same question tomorrow runs it again. Nothing is remembered,
nothing is reused, and the bill scales with usage while the underlying knowledge barely moves.

Knowy synthesizes retrieved evidence **once** into a durable, citation-bearing
*intelligence object*, serves that object to any agent asking a semantically equivalent
question, and rebuilds it only when the underlying sources actually change.

It reads through adapters over the vector index you already run — Knowy is a layer, not
another silo.

## How it works

```
   Agent ──▶ Agent Context Manager ──▶ Intelligence Object Store
                     │                          │
                     │                    Freshness Check
                     │                     ╱          ╲
                     │      sources unchanged        changed or missing
                     │            │                        │
                     ◀────────────┘                        ▼
              serve (0 LLM tokens)              Vector DB ──▶ Intelligence Builder
                                               (your index)     (LLM synthesis)
```

Objects are found by **semantic similarity over object embeddings**, not by an exact-match
cache key — natural-language questions vary infinitely, so a keyed cache would never hit.

### Three refresh tiers

Every object records the evidence ids and content hashes it was built from, plus a TTL.
Knowy picks the cheapest tier that is still correct:

| Tier | When | Cost |
|---|---|---|
| **Verify** | Every fingerprint still matches | One metadata query. **Zero LLM tokens.** |
| **Patch** | Some evidence changed, below the churn threshold | Only the changed evidence goes to the LLM. ~10–20% of a rebuild. |
| **Rebuild** | Missing, heavily churned, or explicitly forced | Full retrieval and synthesis. |

Callers control this per request (`freshness: "cached" | "verified" | "fresh"`), can force
a refresh, and can invalidate objects by id, tag, or source.

### Permission-aware by construction

Every object stores the union of the ACL tags of its evidence, and is served only when
that set is a subset of the caller's grants. A cache in front of retrieval is otherwise a
permission-laundering machine. The check is conservative: it can cause extra misses, it
cannot leak.

## Try it

```bash
pnpm install
pnpm example
```

Runs the full loop against in-memory adapters — no database, no API keys:

```
1. cold (miss)           tier=rebuilt   baseline=1230   actual=1420   saved=0
2. repeat (hit)          tier=verified  baseline=1230   actual=20     saved=1210
3. one source changed    tier=patched   baseline=1230   actual=180    saved=1050
4. forced fresh          tier=rebuilt   baseline=1230   actual=1420   saved=0
```

> These figures come from a **stub synthesizer with fixed token counts**. They demonstrate
> that the tiers route correctly — not that the savings hold on a real corpus. Measuring
> that against a live embedder and LLM is the calibration work in Plan 3, and until it
> runs, the savings claim is unvalidated.

```bash
pnpm test        # 102 tests, no infrastructure required
pnpm typecheck
pnpm build
```

## Layout

```
packages/core/           @knowy/core          pure decision engine, zero I/O
packages/index-memory/   @knowy/index-memory  reference RawEvidenceIndex
packages/store-memory/   @knowy/store-memory  reference ObjectStore
examples/                runnable demo
docs/superpowers/        design spec and implementation plans
```

`@knowy/core` performs no I/O whatsoever — no network, no database, no `process.env`, not
even an ambient clock. Freshness diffing, tier selection, the coverage and permission
gates, and token accounting are pure functions over plain data. A test enforces this.
Everything else is an adapter or a transport around it.

### Writing an adapter

Four interfaces carry every external dependency: `RawEvidenceIndex`, `ObjectStore`,
`Synthesizer`, `Embedder` (see `packages/core/src/types/ports.ts`). Each has a shared
**conformance suite** exported from `@knowy/core/testing` — so "does Weaviate work with
Knowy?" has a runnable answer rather than an opinion.

## Status

Early. The core engine is built and tested; production adapters, the HTTP API, MCP, and
the Slack plugin are in progress.

- [Design spec](docs/superpowers/specs/2026-09-12-knowy-design.md)
- [Plan 1 — core engine](docs/superpowers/plans/2026-09-12-knowy-core-engine.md) ✅ complete
- [Plan 2 — adapters, server, SDK](docs/superpowers/plans/2026-09-12-knowy-adapters-and-server.md) — in progress
- Plan 3 — MCP, Slack, calibration harness — in progress

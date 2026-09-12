# Knowy Plan 3 — LLM Adapters, Calibration, MCP, and Slack

**Goal:** Plug real models into Knowy, measure whether the design's central bet actually holds, and expose the result to agents and humans.

**Covers:** Spec §17 milestone 7, plus the `Synthesizer` and `Embedder` adapters that Plan 2 does not own.

**Spec:** [docs/superpowers/specs/2026-09-12-knowy-design.md](../specs/2026-09-12-knowy-design.md)

**Runs in parallel with:** [Plan 2](./2026-09-12-knowy-adapters-and-server.md) on `feat/adapters-and-server`. This plan owns `llm-anthropic`, `embed-voyage`, `calibration/`, `mcp`, `plugins/slack` and does **not** touch `ObjectStore` or `RawEvidenceIndex`.

**Branch:** `feat/mcp-slack-calibration`, based on `main`.

---

## Why calibration comes first

Knowy's economics rest on one unmeasured number: **how often does a real question land
within `match_threshold` of a stored object that genuinely answers it?**

Every other number in the system is arithmetic. This one is empirical, it is a property of
the embedding model and the corpus rather than of our code, and nothing in Plan 1 or Plan 2
reveals it. If it is 60%, Knowy works. If it is 15%, the reactive-cache design needs
rethinking and we would rather know before building six more packages on top of it.

So the order is: real models (Tasks 1–2), measure (Task 3), then surfaces (Tasks 4–5).

### The two ways this can fail, and they are not symmetric

- **Miss** — a question that a stored object could have answered triggers a rebuild.
  Costs money. Recoverable. Tune the threshold down.
- **False hit** — a stored object is served for a question it does not actually answer.
  Produces a confident, cited, **wrong** answer. This is the failure that loses a customer,
  and the one the calibration harness exists to bound.

Lowering `match_threshold` trades the first for the second. The harness's job is to find
where that trade sits for a real embedding model, not to assume 0.86 was a good guess.

---

## Task 1 — `@knowy/llm-anthropic` (Synthesizer)

**Files:** `packages/llm-anthropic/{package.json,tsconfig.json}`, `src/{index.ts,prompts.ts}`, `test/*.test.ts`

Implements `Synthesizer` (`build` and `patch`) against the Claude API.

This adapter is where the product's answer quality lives. Four requirements:

1. **Structured output, not prose parsing.** Use tool-use with a JSON schema so
   `{ content, claims, confidence, gaps, tokens_used }` comes back typed. Never regex a
   model's free text into a data structure.
2. **Every claim carries `evidence_ids`.** A claim citing evidence not in the input is a
   hallucinated citation — reject the synthesis and retry once, then fail to the degraded
   path rather than store an object with fabricated provenance. `validateObject` in core
   enforces this too, but failing early gives a better error.
3. **`confidence` and `gaps` are honest self-reports.** The prompt must explicitly invite
   the model to say the evidence did not answer the question. A synthesizer that always
   returns 0.9 makes the coverage gate useless, so the prompt asks for gaps *first*, then
   confidence — reasoning about shortfalls before scoring is what makes the score mean
   anything.
4. **`tokens_used` comes from the API response's usage block**, never estimated. The
   estimate in core is a fallback for counterfactual baselines only.

**`patch` is the subtle one.** It receives the existing object, only the changed evidence,
and the ids of removed evidence. The prompt must instruct: preserve every claim whose
supporting evidence did not change, revise only what the changed evidence affects, and drop
claims whose sole support was removed. Getting this wrong turns a cheap patch into a silent
rewrite, and the token savings in tier two evaporate.

**Tests** run against a recorded-fixture transport by default — real API calls gated on
`ANTHROPIC_API_KEY` so the suite stays hermetic and free. Cover: well-formed synthesis,
hallucinated-citation rejection, low-confidence path, patch preserving unchanged claims.

## Task 2 — `@knowy/embed-voyage` (Embedder)

**Files:** `packages/embed-voyage/**`

Implements `Embedder` against Voyage AI (`voyage-3`). Anthropic publishes no embeddings
API and recommends Voyage, so the synthesizer and embedder are deliberately separate
packages rather than one "LLM adapter".

- **Batch.** Voyage caps inputs per request; chunk the input array, preserve order on
  reassembly. Order corruption here silently mismatches every embedding to the wrong text,
  and no test downstream would obviously catch it — so test it explicitly.
- **`dimensions` is declared, not inferred**, and must match the vector column Plan 2
  provisions. The server's `readyz` check exists to catch a mismatch at startup.
- Retry 429 and 5xx with backoff; never retry 4xx.

## Task 3 — The calibration harness

**Files:** `calibration/{corpus.ts,questions.ts,run.ts,report.ts}`, `calibration/README.md`

Not a package — a runnable experiment. `pnpm calibrate`.

### Corpus

Ingest a large public documentation set (PostgreSQL or Kubernetes docs — big, genuinely
technical, densely cross-referenced, structurally similar to an enterprise wiki). Chunk,
embed, load into `MemoryIndex` or Plan 2's pgvector index once it exists. Cache embeddings
to disk keyed by content hash; re-embedding a corpus on every run is slow and expensive.

### Question sets — the part that makes the measurement mean something

For each of N topics drawn from the corpus, generate three sets with Claude:

| Set | What it is | Correct behaviour |
|---|---|---|
| **Seed** | The question that builds the object | rebuild |
| **Paraphrases** | Same information need, different words — "how long do refunds take" / "what's the turnaround on a refund" | **hit** |
| **Near-misses** | Lexically similar, different information need — "how long do refunds take" / "how long do refund *disputes* take" | **miss** |

Near-misses are what make this a real experiment. A harness that only measures paraphrase
hit rate can be trivially maximised by lowering the threshold to zero.

**Generated labels are not trusted.** An LLM judge, given the served answer and the asked
question, rules whether the answer actually addresses it. A "hit" the judge rejects is a
**false hit**, and that number is the headline output.

### Metrics

- Hit rate on paraphrases; false-hit rate on near-misses (judge-confirmed)
- Aggregate token savings against a measured raw-retrieval baseline — real numbers from a
  real model, replacing the stub figures the README currently carries
- Tier distribution, and latency per tier
- **Threshold sweep:** re-run scoring across `match_threshold` from 0.70 to 0.95 and report
  the curve. Sweeping is cheap because it needs no re-embedding and no re-synthesis — score
  once, threshold many times.

### Output

`calibration/report.md`, committed: the curve, a recommended `match_threshold` and
`min_confidence`, and a plain statement of whether the product thesis holds. **Write the
report honestly even if the answer is no** — a design that does not survive contact with
measurement is worth knowing about now, and that is the entire reason this task exists.

Then wire a reduced version into CI as a regression gate so a future change that quietly
wrecks the hit rate fails the build.

## Task 4 — `@knowy/mcp`  
> **Reassigned to the Codex agent** (2026-09-12), along with Task 5. Blocked on calibration round 2: building surfaces on a 27% hit rate is premature. See `calibration/report.md`.

**Files:** `packages/mcp/**`

Tools: `knowy_ask`, `knowy_get_object`, `knowy_refresh`, `knowy_invalidate`. Runs over
stdio (Claude Code, Claude Desktop, Cursor) and streamable HTTP (hosted).

**Decoupled from Plan 2** so neither branch blocks the other: define a minimal
`KnowyClient` interface covering the four operations. Ship an in-process implementation
wrapping `AgentContextManager` now; Codex's `@knowy/sdk` satisfies the same interface and
drops in later with no change to tool code.

**Tool descriptions are load-bearing.** `knowy_ask` must state that it returns a
pre-synthesized, cited digest, so an agent does not helpfully fan out to raw retrieval
afterwards and destroy the saving Knowy just produced. Surface `tier` and `savings` in the
response so the agent — and the user watching it — can see what was avoided.

## Task 5 — `plugins/slack`

**Files:** `plugins/slack/**`

The reference plugin, and the demo.

- `/knowy <question>` — digest, citations as a context block, footer showing tier and
  tokens saved
- `/knowy refresh <question>` and a **Refresh** button on every answer (`freshness: "fresh"`)
- `@knowy` in a thread — answers using the thread as extra context
- Slack user identity maps to Knowy permissions through a configurable mapping, so spec §8
  holds inside Slack rather than being bypassed by it

Built on Slack Bolt. Socket Mode for local development so no public URL is needed.

---

## Done when

- `pnpm test` and `pnpm typecheck` green; CI green.
- `pnpm calibrate` produces `calibration/report.md` with judge-confirmed hit and false-hit
  rates against a real embedder and a real LLM.
- The README's savings figures are replaced with measured ones, or the thesis is revised.
- An MCP client completes an ask; Slack answers a slash command.

## Needed from the repo owner

- `VOYAGE_API_KEY` — without it the harness runs only against stub embeddings, and the
  hit-rate number cannot exist.
- `ANTHROPIC_API_KEY` with enough budget for corpus-scale question generation and judging.

Everything is built so it runs end-to-end without these and gates the live measurement on
their presence — the same pattern Plan 2 uses for Pinecone.

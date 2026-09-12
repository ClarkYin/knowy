# Calibration Report — Round 1

**Date:** 2026-09-12
**Question:** Does semantic similarity reliably route a question to an intelligence object that actually answers it?
**Answer:** Not on its own. The coverage gate needs a second signal.

## Method

15 topics drawn from typical enterprise-knowledge-base subject matter (HR policy, expenses,
deployment, on-call, security, IT). Each topic contributes:

- **1 seed question** — builds the stored object, and supplies its embedding
- **3 paraphrases** — same information need, different wording. Must **hit**.
- **3 near-misses** — lexically adjacent, *different* information need. Must **miss**.

All 15 objects sit in one simulated store. All 90 probes are routed against the whole
store exactly as the ACM's discovery step does, then scored across thresholds 0.70–0.95.

Embeddings run locally (transformers.js). No API key, no cost, fully reproducible:
`pnpm calibrate`.

## Results

| Threshold | Hit rate (of 45) | False hits (of 45 near-misses) |
|---|---|---|
| 0.70 | 84% | 41 |
| 0.80 | 56% | 18 |
| **0.86 (Knowy default)** | **27%** | **5** |
| 0.90 | 7% | 4 |

**There is no good operating point.** Raising the threshold to suppress false hits
destroys the hit rate, and the token-savings thesis with it. Lowering it to recover hit
rate serves a wrong answer to nearly every near-miss.

### The finding: this is not a tuning problem

**In 12 of 15 topics, the worst genuine paraphrase scores *below* the best near-miss.**
No threshold can separate them, because the distributions overlap.

```
refund-timing       worst paraphrase 0.8650  <  best near-miss 0.9030
password-rotation   worst paraphrase 0.6416  <  best near-miss 0.9136
code-review-sla     worst paraphrase 0.5832  <  best near-miss 0.9018
prod-deploy         worst paraphrase 0.6580  <  best near-miss 0.8592
```

"How long do refunds take?" vs "How long do refund **disputes** take?" — 0.9030, higher
than any real rephrasing of the original.

### It is also not a model-capacity problem

Re-run with `bge-base-en-v1.5` (768-dim, roughly 4× the parameters):

| Model | Separable topics | Hit @ 0.86 | False hits @ 0.86 |
|---|---|---|---|
| bge-small-en-v1.5 (384d) | 3/15 | 27% | 5 |
| bge-base-en-v1.5 (768d)  | 3/15 | 24% | 9 |

Four times the model, no improvement. A stronger commercial embedder (voyage-3,
text-embedding-3-large) would likely shift the numbers somewhat, but the overlap is
structural rather than marginal, and scaling the encoder did not begin to close it.

### The useful nuance: the failure is "right topic, wrong question"

**Misroutes were zero at every threshold.** A paraphrase never got routed to a *different
topic's* object — it either matched its own or fell below the bar. All the damage comes
from near-misses inside the same subject area.

So bi-encoder cosine is doing its job: it finds the right region of the corpus. What it
cannot do is distinguish two different *information needs* that share a topic. That is a
known property of bi-encoders, not a defect in this corpus.

## What this means for the design

Spec §6's coverage gate uses two signals — question↔object similarity, and the object's
self-reported confidence. Neither catches this failure: the similarity is high, and the
object is genuinely confident about content that answers a *different* question.

A third signal is needed. Three candidates, in ascending cost:

1. **Evidence-set overlap** *(cheapest, and the most promising)*. Retrieve top-k evidence
   for the incoming question and compare it against the evidence the object was built
   from. A different information need pulls different sources. Costs one index query —
   which the freshness check already pays for — and no LLM tokens at all.
2. **Cross-encoder reranking.** Cross-encoders score a question–document *pair* jointly
   rather than embedding each separately, which is exactly the discrimination missing
   here. Small rerankers run locally and free.
3. **LLM verification** of candidate hits. Most accurate, but it spends tokens on the
   serve path and erodes the saving Knowy exists to produce.

Round 2 should measure 1 and 2 against this same fixture.

## Caveats — read these before quoting the numbers

- **The fixture is adversarial by construction.** Near-misses were written to be the
  hardest possible cases. A real query stream contains many easy repeats, so 27% is a
  floor, not an expected production hit rate.
- **15 topics, hand-authored by the same author as the harness.** There is real risk of
  bias in what was labelled "paraphrase" versus "near-miss". An independent labeller, or
  an LLM judge over real answers, would strengthen this considerably.
- **Only open-weight embedders tested.** A commercial model remains untested.
- Objects are embedded from their seed *question*. Embedding the object's synthesized
  *content*, or a concatenation of both, is an untested variable that might matter.

## Bottom line

The product thesis — synthesize once, serve many — is not disproven. The retrieval
mechanism as currently specified is insufficient to deliver it safely, and no amount of
threshold tuning fixes that. This was worth learning before building the HTTP API, MCP
server, and Slack plugin on top of it.

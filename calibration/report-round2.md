# Calibration Report — Round 2

**Date:** 2026-09-12
**Question:** Can a second signal rescue the coverage gate that round 1 showed is insufficient?
**Answer:** Neither candidate worked. Plain cosine remains the best of everything tested, and it is not good enough.

## What was tested

Same 15-topic fixture as round 1 (45 paraphrases that must hit, 45 near-misses that must
miss), now with a real corpus behind it: 13 policy documents, 55 chunks, deliberately
written so that **related information needs share a document** — refund timing and refund
disputes live on the same page, as they would in a real knowledge base. That makes
evidence-overlap gating a fair test rather than a rigged one.

| Strategy | Idea |
|---|---|
| **A** cosine only | The current spec |
| **B** cosine + evidence overlap | Does the question retrieve the same sources the object was built from? |
| **C** cosine + cross-encoder | Joint question/passage scoring with a reranker |

## Results

| Strategy | Hit rate | False hits (of 45) | Net |
|---|---|---|---|
| **A  cosine ≥ 0.84** | **42%** | **7** | **12** |
| A  cosine ≥ 0.80 | 56% | 18 | 7 |
| A  cosine ≥ 0.86 (default) | 27% | 5 | 7 |
| B  cosine ≥ 0.78 + overlap ≥ 0.625 | 67% | 21 | 9 |
| B  cosine ≥ 0.82 + overlap ≥ 0.500 | 47% | 14 | 7 |
| C  cosine ≥ 0.78 + rerank ≥ −0.6 | 62% | 24 | 4 |
| C  rerank only ≥ 2.5 | 53% | 30 | −6 |

**Nothing beat plain cosine.** Evidence overlap raises hit rate but raises false hits
faster. The cross-encoder is worse than cosine at every operating point.

## Why both failed — the same reason

Evidence overlap fails because a near-miss question retrieves chunks from the *same
document* as the seed. "How long do refund disputes take?" pulls the refunds page, which is
exactly what the refund-timing object was built from. Overlap is high precisely when it
needs to be low.

The cross-encoder fails for the equivalent reason. It answers *"is this passage relevant to
this question?"*, and the refunds page genuinely **is** relevant to a question about refund
disputes. It scores the near-miss as relevant because the near-miss *is* relevant.

**This is the general lesson: every retrieval-shaped signal measures topical relevance.
What the coverage gate needs is equivalence of information need. Those are different
predicates, and no retrieval tool computes the second one.**

### Two methodology bugs found and fixed, worth recording

1. The transformers.js `text-classification` pipeline softmaxes a **single-label** head, so
   it returned `score: 1.0` for every pair — pure noise. The relevance signal is the raw
   logit. An earlier run reported cross-encoder numbers from this and they were invalid.
2. The reranker was first fed **question↔question** pairs. ms-marco rerankers are trained
   on query↔passage; scoring it against the object's evidence text is the in-distribution
   use. Both results above use the corrected form.

## What this means for the design

The cheap gate may simply not exist. The honest remaining option is **LLM verification on
the serve path**: given the question and the object's content, ask a small model whether
the object actually answers it. That is an entailment question, not a retrieval one, which
is the predicate actually needed.

**This costs tokens, but far less than it appears to.** A verification call against a
~400-token digest costs on the order of 100 tokens. Against the measured ~1230-token
raw-retrieval baseline:

```
raw retrieval baseline      1230 tokens
digest + verification        400 + ~100 = ~500 tokens
saving                       ~59%
```

So the product thesis survives — synthesize once, serve many — but the *mechanism* changes.
Knowy's gate becomes cheap-retrieval-then-cheap-verification rather than retrieval alone,
and the headline claim moves from "~98% reduction" to something closer to "~60%, with a
correctness guarantee". That is a weaker but far more defensible claim, and it is one that
survives contact with measurement.

Round 3 should measure exactly that: verification accuracy and true cost on this fixture.

## Caveats

- The fixture is **adversarial by construction** and self-authored; near-misses were
  written to be maximally hard. Real query streams contain many easy repeats, so hit rates
  here are floors.
- 15 topics, 55 chunks. The corpus is small enough that top-k retrieval covers a large
  fraction of it, which handicaps overlap gating. Sweeping k (3 and 8) changed little, but
  a corpus two orders of magnitude larger might behave differently.
- Only open-weight models tested, and only one reranker.
- Objects are embedded from their seed question. Embedding the synthesized content instead,
  or both, remains untested and is cheap to try.

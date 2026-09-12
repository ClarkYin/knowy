# Knowy

A structural operational layer between AI agents and the knowledge an enterprise has
already indexed.

Agents today re-pay for retrieval on every question: embed, pull top-k raw chunks, stuff
thousands of tokens into context, synthesize. Ten agents asking overlapping questions run
that ten times. Knowy synthesizes retrieved evidence once into a durable,
citation-bearing **intelligence object**, serves it to any agent asking a semantically
equivalent question, and rebuilds it only when the underlying sources actually change.

It reads through adapters over the vector index you already run — it is a layer, not
another silo.

**Status:** design approved, implementation not started.

**Design spec:** [docs/superpowers/specs/2026-09-12-knowy-design.md](docs/superpowers/specs/2026-09-12-knowy-design.md)

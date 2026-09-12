# Examples

## cold-to-warm

Runs the full Knowy loop against in-memory adapters — no database, no API keys.

    pnpm example

Shows four asks: a cold miss paying full synthesis, a repeat served from the object
store at zero LLM cost, a cheap patch after one source changes, and a caller-forced
rebuild.

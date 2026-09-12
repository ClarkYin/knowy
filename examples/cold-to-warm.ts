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
  embedder: { dimensions: 3, embed: async (ts: string[]) => ts.map(() => [1, 0, 0]) },
  synthesizer: {
    build: async (_q, evidence) => ({
      content: "Refunds complete within 5 business days; requests must be filed within 30 days.",
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
    `${label.padEnd(24)} tier=${r.tier.padEnd(9)} ` +
      `baseline=${String(r.savings.baseline_tokens).padEnd(6)} ` +
      `actual=${String(r.savings.actual_tokens).padEnd(6)} ` +
      `saved=${r.savings.saved_tokens}`,
  );
}

report("1. cold (miss)", await acm.ask(ask));
report("2. repeat (hit)", await acm.ask(ask));
await index.setHash("doc-0", "h-0-v2");
report("3. one source changed", await acm.ask(ask));
report("4. forced fresh", await acm.ask({ ...ask, freshness: "fresh" }));

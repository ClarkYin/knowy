/**
 * Knowy calibration harness.
 *
 * Measures the one empirical number the design rests on: how reliably does semantic
 * similarity route a question to an intelligence object that actually answers it?
 *
 * Simulates a populated object store — one object per topic, embedded from its seed
 * question — then routes every probe question against the whole store, exactly as the
 * ACM's discovery step would. Needs no API key: embeddings run locally.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { LocalEmbedder } from "@knowy/embed-local";
import { cosine } from "@knowy/core";

interface Topic {
  id: string;
  seed: string;
  paraphrases: string[];
  near_misses: string[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./questions.fixture.json", import.meta.url), "utf8"),
) as { topics: Topic[] };
const topics = fixture.topics;

const MODEL = process.env.KNOWY_EMBED_MODEL ?? "Xenova/bge-small-en-v1.5";
const embedder = new LocalEmbedder({ model: MODEL });

console.log(`model: ${MODEL}`);
console.log(`loading model and embedding ${topics.length} objects + probes...`);
const seedVecs = await embedder.embed(topics.map((t) => t.seed));

interface Probe {
  text: string;
  topicIdx: number;
  kind: "paraphrase" | "near_miss";
}
const probes: Probe[] = topics.flatMap((t, i) => [
  ...t.paraphrases.map((text) => ({ text, topicIdx: i, kind: "paraphrase" as const })),
  ...t.near_misses.map((text) => ({ text, topicIdx: i, kind: "near_miss" as const })),
]);
const probeVecs = await embedder.embed(probes.map((p) => p.text));

/** For each probe: the best-scoring object in the store, and which topic it belongs to. */
const routed = probes.map((p, i) => {
  const scores = seedVecs.map((sv) => cosine(probeVecs[i]!, sv));
  let bestIdx = 0;
  for (let j = 1; j < scores.length; j++) if (scores[j]! > scores[bestIdx]!) bestIdx = j;
  return { ...p, bestIdx, bestScore: scores[bestIdx]!, ownScore: scores[p.topicIdx]! };
});

interface Row {
  threshold: number;
  hits: number;          // paraphrase routed to its own object, above threshold
  misses: number;        // paraphrase fell below threshold — costs a rebuild, recoverable
  misroutes: number;     // paraphrase served the WRONG object — a false hit
  falseHits: number;     // near-miss served any object — a false hit
  correctlyMissed: number;
}

const paraphrases = routed.filter((r) => r.kind === "paraphrase");
const nearMisses = routed.filter((r) => r.kind === "near_miss");

function evaluate(threshold: number): Row {
  let hits = 0, misses = 0, misroutes = 0;
  for (const r of paraphrases) {
    if (r.bestScore < threshold) misses++;
    else if (r.bestIdx === r.topicIdx) hits++;
    else misroutes++;
  }
  const falseHits = nearMisses.filter((r) => r.bestScore >= threshold).length;
  return {
    threshold, hits, misses, misroutes, falseHits,
    correctlyMissed: nearMisses.length - falseHits,
  };
}

const sweep: Row[] = [];
for (let t = 0.70; t <= 0.9501; t += 0.01) sweep.push(evaluate(Number(t.toFixed(2))));

const pct = (n: number, d: number) => `${((n / d) * 100).toFixed(0)}%`;

console.log(`\nStore: ${topics.length} objects. Probes: ${paraphrases.length} paraphrases (should hit), ${nearMisses.length} near-misses (should miss).\n`);
console.log("thresh | hit rate | miss | misroute | FALSE HIT | net useful");
console.log("-------|----------|------|----------|-----------|------------");
for (const r of sweep) {
  if (Math.round(r.threshold * 100) % 2 !== 0) continue;
  const net = r.hits - (r.misroutes + r.falseHits);
  console.log(
    `  ${r.threshold.toFixed(2)} |   ${pct(r.hits, paraphrases.length).padStart(4)}   |` +
    ` ${String(r.misses).padStart(3)}  |   ${String(r.misroutes).padStart(3)}    |` +
    `    ${String(r.falseHits).padStart(3)}    | ${String(net).padStart(4)}`,
  );
}

// Per-topic separability: can ANY threshold split this topic's paraphrases from its
// near-misses? Where the answer is no, threshold tuning cannot fix the topic.
const separability = topics.map((t, i) => {
  const ps = paraphrases.filter((r) => r.topicIdx === i).map((r) => r.ownScore);
  const ns = nearMisses.filter((r) => r.topicIdx === i).map((r) => r.ownScore);
  const minP = Math.min(...ps), maxN = Math.max(...ns);
  return { id: t.id, minP, maxN, gap: minP - maxN, separable: minP > maxN };
});
const overlapping = separability.filter((s) => !s.separable);

console.log(`\nPer-topic separability: ${separability.length - overlapping.length}/${separability.length} topics separable by some threshold`);
for (const s of overlapping) {
  console.log(`  OVERLAP  ${s.id.padEnd(24)} worst paraphrase ${s.minP.toFixed(4)} < best near-miss ${s.maxN.toFixed(4)}`);
}

const best = [...sweep].sort(
  (a, b) => (b.hits - b.misroutes - b.falseHits) - (a.hits - a.misroutes - a.falseHits),
)[0]!;
const atDefault = evaluate(0.86);

console.log(`\nKnowy's current default (0.86): hit ${pct(atDefault.hits, paraphrases.length)}, false hits ${atDefault.falseHits + atDefault.misroutes}`);
console.log(`Best threshold by net-useful  (${best.threshold.toFixed(2)}): hit ${pct(best.hits, paraphrases.length)}, false hits ${best.falseHits + best.misroutes}`);

writeFileSync(
  new URL(`./results-${MODEL.split("/")[1]}.json`, import.meta.url),
  JSON.stringify({ model: MODEL, sweep, separability, atDefault, best }, null, 2),
);
console.log(`\nwrote calibration/results-${MODEL.split("/")[1]}.json`);

/**
 * Calibration round 2 — can a second signal rescue the coverage gate?
 *
 * Round 1 showed question<->object cosine alone cannot separate a paraphrase from a
 * near-miss (12 of 15 topics overlap at every threshold). This compares three gating
 * strategies against the same fixture, now with a real corpus behind it.
 *
 *   A  cosine only                  the current spec
 *   B  cosine + evidence overlap    does the question pull the same sources?
 *   C  cosine + cross-encoder       joint question/object scoring
 */
import { readFileSync, writeFileSync } from "node:fs";
import { LocalEmbedder } from "@knowy/embed-local";
import { cosine } from "@knowy/core";

// retrieval_k. With a small corpus, a large k retrieves a big fraction of everything
// and washes out overlap's discriminative power — so it is swept, not fixed.
const K = Number(process.env.KNOWY_K ?? 8);

interface Topic { id: string; seed: string; paraphrases: string[]; near_misses: string[] }
const { topics } = JSON.parse(
  readFileSync(new URL("./questions.fixture.json", import.meta.url), "utf8"),
) as { topics: Topic[] };
const { documents } = JSON.parse(
  readFileSync(new URL("./corpus.fixture.json", import.meta.url), "utf8"),
) as { documents: { uri: string; chunks: string[] }[] };

const chunks = documents.flatMap((d, di) =>
  d.chunks.map((text, ci) => ({ id: `${di}:${ci}`, uri: d.uri, text })),
);

const embedder = new LocalEmbedder();
console.log(`corpus: ${chunks.length} chunks from ${documents.length} documents, k=${K}`);
console.log("embedding corpus and questions...");

const chunkVecs = await embedder.embed(chunks.map((c) => c.text));
const seedVecs = await embedder.embed(topics.map((t) => t.seed));

function retrieve(vec: number[]): Set<string> {
  return new Set(
    chunks
      .map((c, i) => ({ id: c.id, s: cosine(vec, chunkVecs[i]!) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, K)
      .map((x) => x.id),
  );
}

// Each object's evidence set is what its seed question retrieved.
const objectEvidence = seedVecs.map((v) => retrieve(v));

interface Probe { text: string; topicIdx: number; kind: "paraphrase" | "near_miss" }
const probes: Probe[] = topics.flatMap((t, i) => [
  ...t.paraphrases.map((text) => ({ text, topicIdx: i, kind: "paraphrase" as const })),
  ...t.near_misses.map((text) => ({ text, topicIdx: i, kind: "near_miss" as const })),
]);
const probeVecs = await embedder.embed(probes.map((p) => p.text));

const analysed = probes.map((p, i) => {
  const v = probeVecs[i]!;
  const scores = seedVecs.map((sv) => cosine(v, sv));
  let best = 0;
  for (let j = 1; j < scores.length; j++) if (scores[j]! > scores[best]!) best = j;
  const ev = retrieve(v);
  const objEv = objectEvidence[best]!;
  let shared = 0;
  for (const id of ev) if (objEv.has(id)) shared++;
  return { ...p, bestIdx: best, bestScore: scores[best]!, overlap: shared / K };
});

const paraphrases = analysed.filter((a) => a.kind === "paraphrase");
const nearMisses = analysed.filter((a) => a.kind === "near_miss");

function score(pred: (a: typeof analysed[number]) => boolean) {
  const hits = paraphrases.filter((a) => pred(a) && a.bestIdx === a.topicIdx).length;
  const misroutes = paraphrases.filter((a) => pred(a) && a.bestIdx !== a.topicIdx).length;
  const falseHits = nearMisses.filter((a) => pred(a)).length;
  return {
    hitRate: hits / paraphrases.length,
    falseHits: falseHits + misroutes,
    hits, misroutes, rawFalse: falseHits,
  };
}

const pc = (x: number) => `${(x * 100).toFixed(0)}%`;
const rows: any[] = [];

console.log(`\n${paraphrases.length} paraphrases (should hit), ${nearMisses.length} near-misses (should miss)\n`);
console.log("strategy                              | hit rate | false hits | net");
console.log("--------------------------------------|----------|------------|-----");

function report(label: string, r: ReturnType<typeof score>) {
  rows.push({ label, ...r });
  console.log(
    `${label.padEnd(38)}|   ${pc(r.hitRate).padStart(4)}   |     ${String(r.falseHits).padStart(2)}     | ${String(r.hits - r.falseHits).padStart(3)}`,
  );
}

// A — cosine only, the current spec
for (const t of [0.80, 0.84, 0.86]) {
  report(`A  cosine >= ${t.toFixed(2)}`, score((a) => a.bestScore >= t));
}

// B — cosine floor plus evidence-set overlap
for (const ct of [0.78, 0.82]) {
  for (const ot of [0.5, 0.625, 0.75, 0.875]) {
    report(
      `B  cosine >= ${ct.toFixed(2)} + overlap >= ${ot.toFixed(3)}`,
      score((a) => a.bestScore >= ct && a.overlap >= ot),
    );
  }
}

// C — cross-encoder reranking.
// Scored against the object's EVIDENCE TEXT, not its canonical question: ms-marco
// rerankers are trained on query/passage pairs, and feeding them question/question
// pairs is out of distribution. The relevance signal is the raw logit — the
// text-classification pipeline softmaxes a single-label head and returns 1.0 for
// everything, which is pure noise.
try {
  const { AutoTokenizer, AutoModelForSequenceClassification } = await import(
    "@huggingface/transformers"
  );
  const MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
  const tok: any = await AutoTokenizer.from_pretrained(MODEL);
  const model: any = await AutoModelForSequenceClassification.from_pretrained(MODEL);

  const byId = new Map(chunks.map((c) => [c.id, c.text]));
  const objectText = objectEvidence.map((set) =>
    [...set].slice(0, 3).map((id) => byId.get(id) ?? "").join(" ").slice(0, 1200),
  );

  const ce: number[] = [];
  for (const a of analysed) {
    const inputs = await tok(a.text, {
      text_pair: objectText[a.bestIdx]!, padding: true, truncation: true,
    });
    const { logits } = await model(inputs);
    ce.push(logits.tolist()[0][0] as number);
  }
  const sorted = [...ce].sort((x, y) => x - y);
  for (const q of [0.2, 0.4, 0.5, 0.6, 0.75]) {
    const t = sorted[Math.floor(sorted.length * q)]!;
    report(
      `C  cosine >= 0.78 + rerank >= ${t.toFixed(1)}`,
      score((a) => a.bestScore >= 0.78 && ce[analysed.indexOf(a)]! >= t),
    );
  }
  // Reranker alone, no cosine floor at all.
  for (const q of [0.4, 0.6]) {
    const t = sorted[Math.floor(sorted.length * q)]!;
    report(`C  rerank only >= ${t.toFixed(1)}`, score((a) => ce[analysed.indexOf(a)]! >= t));
  }
} catch (err) {
  console.log(`\n(cross-encoder unavailable: ${(err as Error).message.slice(0, 70)})`);
}

const best = [...rows].sort((a, b) => (b.hits - b.falseHits) - (a.hits - a.falseHits))[0];
console.log(`\nBest strategy: ${best.label}`);
console.log(`  hit rate ${pc(best.hitRate)}, false hits ${best.falseHits}/${nearMisses.length}`);

writeFileSync(
  new URL("./results-round2.json", import.meta.url),
  JSON.stringify({ k: K, corpusChunks: chunks.length, ceAvailable, rows }, null, 2),
);
console.log("\nwrote calibration/results-round2.json");

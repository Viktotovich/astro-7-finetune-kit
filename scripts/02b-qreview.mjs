// Stage 2b: screen every candidate question with a strong model BEFORE answering it.
// Drops trivia, vendor/dashboard minutiae, false premises, invented APIs, vague or
// context-dependent questions, and generic "how do I fix error X" templates.
// Output: work/qreview.jsonl { id, keep, reason, question? (lightly improved wording) }
import { join } from "node:path";
import { WORK, ASTRO_VERSION, readJsonl, appendJsonl, pMap, parseJsonLoose, progress, cloudWithFallback, FREE_MODELS, rotate } from "./lib.mjs";

const OUT = join(WORK, "qreview.jsonl");
const BATCH = 40;
const CONC = Number(process.env.CONC ?? 4);
const major = ASTRO_VERSION.split(".")[0];

const done = new Set(readJsonl(OUT).map((r) => r.id));
const todo = readJsonl(join(WORK, "questions.jsonl")).filter((q) => !done.has(q.id));

const INSTRUCTIONS = `You curate questions for a fine-tuning dataset that teaches a small model to answer real developer questions about Astro ${major} (Astro ${ASTRO_VERSION}).
For each numbered question decide keep or drop. KEEP only if ALL hold:
- Realistic: something a developer building with Astro would actually ask; self-contained (no "the endpoint above", "this page", "the example").
- Astro-specific: about Astro's APIs, config, files, rendering, routing, integrations/adapters, or how Astro interacts with a tool. Drop questions only about a third-party product's dashboard/CLI/version fields with nothing Astro-specific.
- Correct premise for Astro ${major}: no invented APIs or options, no removed APIs presented as current (migration questions about removed APIs are fine if phrased as migration).
- Valuable: teaches how Astro works, a distinction, a debugging insight, configuration, architecture or an edge case. Drop trivia ("what version added X", "can I use X?"), generic "how do I fix error <name>?" with no symptom/context, and questions answerable with one word.
- Not a near-duplicate of another question in this batch (keep the better one).
If a kept question has awkward wording, you may give a lightly improved "question" (same meaning, no new facts).
Reply with ONLY a JSON array: [{"i": n, "keep": true|false, "reason": "<few words>", "question": "<optional improved wording>"}]`;

const batches = [];
for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
console.log(`[qreview] questions=${todo.length} batches=${batches.length}`);
const t0 = Date.now();
let n = 0;
let kept = 0;
let seen = 0;
await pMap(
  batches,
  async (batch, bi) => {
    // Questions can also be reviewed out of band (manual review appends to the same file).
    const reviewedNow = () => new Set(readJsonl(OUT).map((r) => r.id));
    let seenIds = reviewedNow();
    batch = batch.filter((q) => !seenIds.has(q.id));
    if (!batch.length) return;
    const doc = batch.map((q, i) => `${i + 1}. [${q.type}, ${q.difficulty}] ${q.question}`).join("\n");
    const { parsed, model } = await cloudWithFallback(`TASK:\n${INSTRUCTIONS}\n\nQUESTIONS:\n${doc}`, rotate(FREE_MODELS, bi), (t) => {
      const a = parseJsonLoose(t);
      return Array.isArray(a) && a.length >= batch.length * 0.8 ? a : null;
    });
    seenIds = reviewedNow();
    for (const r of parsed) {
      const q = batch[Number(r.i) - 1];
      if (!q || seenIds.has(q.id)) continue;
      const improved = typeof r.question === "string" && r.question.length > 20 && r.question !== q.question ? r.question.trim() : undefined;
      appendJsonl(OUT, { id: q.id, keep: r.keep === true, reason: String(r.reason ?? "").slice(0, 120), question: improved, reviewer: model });
      seen++;
      if (r.keep === true) kept++;
    }
    if (++n % 10 === 0) progress(`qreview kept=${kept}/${seen}`, n, batches.length, t0);
  },
  CONC,
);
console.log(`[qreview] done: kept ${kept}/${seen}`);

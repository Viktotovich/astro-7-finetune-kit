// Stage 3: grounded answers. Context = Astro MCP search for the question itself +
// best-overlapping chunks from the question's source page (+ the spec topic for
// web-platform questions). Resumable. Output: work/answers.jsonl
import { join } from "node:path";
import { WORK, MODELS, chat, pMap, readJsonl, appendJsonl, progress, cloudWithFallback, splitSections, FREE_MODELS, rotate, claim, unclaim, loadKeptQuestions, isCooling } from "./lib.mjs";
import { ANSWER_SYSTEM as SYSTEM, contextFor } from "./answer-lib.mjs";

const OUT = join(WORK, "answers.jsonl");

const questions = loadKeptQuestions();
const done = new Set(readJsonl(OUT).map((a) => a.id));
const limit = Number(process.env.LIMIT ?? Infinity);
const todo = questions.filter((q) => !done.has(q.id)).slice(0, limit);

const BACKEND = process.env.BACKEND ?? "cloud";
const CLOUD_MODELS = process.env.GEN_MODELS ? process.env.GEN_MODELS.split(",") : FREE_MODELS;
const BATCH = BACKEND === "cloud" ? Number(process.env.ANSWER_BATCH ?? 6) : 1;
const CONC = Number(process.env.CONC ?? (BACKEND === "cloud" ? 6 : 4));

const batches = [];
for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
if (process.env.REVERSE) batches.reverse();
console.log(`[answers] todo=${todo.length} done=${done.size} backend=${BACKEND} batches=${batches.length}`);
const t0 = Date.now();
let n = 0;
let made = 0;
let insufficient = 0;
await pMap(
  batches,
  async (batch, bi) => {
    batch = batch.filter((q) => claim("a", q.id));
    if (!batch.length) return;
    const written = new Set();
    try {
    const items = [];
    for (const q of batch) {
      const ctx = await contextFor(q);
      items.push({ q, ctx, links: [...new Set(ctx.map((c) => c.url))] });
    }
    let texts;
    const avail = CLOUD_MODELS.filter((m) => !isCooling(m));
    if (BACKEND === "cloud" && avail.length) {
      const doc =
        `TASK:\n${SYSTEM}\n\nAnswer each QUESTION below using only its own CONTEXT and ALLOWED LINKS. ` +
        `Output format, nothing else: for each question a line "=====ANSWER n=====" followed by the answer.\n` +
        items
          .map((it, i) => `\n===== QUESTION ${i + 1} =====\n${it.q.question}\nALLOWED LINKS: ${it.links.join(" ")}\nCONTEXT:\n${it.ctx.map((c) => `<<${c.url}>>\n${c.content}`).join("\n\n")}\n`)
          .join("");
      try {
        const { parsed, model: genModel } = await cloudWithFallback(
          doc,
          rotate(avail, bi),
          (t) => {
            const s = splitSections(t, "ANSWER");
            return Object.keys(s).length >= Math.ceil(items.length / 2) ? s : null;
          },
          { local: false, maxRounds: 1 },
        );
        texts = items.map((_, i) => parsed[i + 1]);
        items.genModel = genModel;
      } catch {
        texts = null; // every strong cloud model is throttled right now
      }
    }
    if (!texts) {
      // Local Qwen3-Coder-30B MoE, one question per call so the prompt fits its context.
      texts = [];
      for (const it of items) {
        const user = `CONTEXT:\n${it.ctx.map((c) => `<<${c.url}>>\n${c.content}`).join("\n\n")}\n\nALLOWED LINKS:\n${it.links.join("\n")}\n\nQUESTION:\n${it.q.question}`;
        texts.push(await chat([{ role: "system", content: SYSTEM }, { role: "user", content: user }], { temperature: 0.3, maxTokens: Number(process.env.LOCAL_MAX_TOKENS ?? 700) }));
      }
      items.genModel = `local/${MODELS.fast}`;
    }
    for (const [i, it] of items.entries()) {
      const answer = (texts[i] ?? "").trim();
      if (!answer) continue; // missing from the batch output; picked up on the next run
      if (/^INSUFFICIENT\b/.test(answer)) insufficient++;
      appendJsonl(OUT, { id: it.q.id, answer, sources: it.links, model: items.genModel ?? MODELS.fast });
      written.add(it.q.id);
      made++;
    }
    } finally {
      // A failed or partial batch (LM Studio down, unparseable output) frees its questions for a later run.
      for (const q of batch) if (!written.has(q.id)) unclaim("a", q.id);
    }
    if (++n % 20 === 0) progress(`answers made=${made} insufficient=${insufficient}`, n, batches.length, t0);
  },
  CONC,
);
console.log(`[answers] done +${made} (insufficient ${insufficient})`);

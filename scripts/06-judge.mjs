// Stage 6: independent review by free OpenCode cloud models (different family from the
// local generator). Batches of Q/A + the same grounding context go in an attached file;
// the model returns pass | fix (with a corrected answer) | reject, plus scores.
// Only answers that passed the deterministic checks are judged. Output: work/judge.jsonl
import { join } from "node:path";
import { WORK, readJsonl, appendJsonl, pMap, progress, FREE_MODELS, loadKeptQuestions } from "./lib.mjs";
import { judgeBatch } from "./judge-lib.mjs";

const MODELS = process.env.JUDGE_MODELS ? process.env.JUDGE_MODELS.split(",") : FREE_MODELS;
// 8 items per prompt is too much for the local Qwen fallback (prompt processing alone exceeds the timeout); JUDGE_BATCH=2 for local runs.
const BATCH = Number(process.env.JUDGE_BATCH ?? 8);
const CONC = Number(process.env.JUDGE_CONC ?? 6);
const OUT = join(WORK, "judge.jsonl");

const qs = new Map(loadKeptQuestions().map((q) => [q.id, q]));
const checks = new Map(readJsonl(join(WORK, "checks.jsonl")).map((c) => [c.id, c]));
const code = new Map(readJsonl(join(WORK, "codecheck.jsonl")).map((c) => [c.id, c]));
const done = new Set(readJsonl(OUT).map((j) => j.id));
const todo = readJsonl(join(WORK, "answers.jsonl")).filter(
  (a) => !done.has(a.id) && qs.has(a.id) && checks.get(a.id) && !checks.get(a.id).hard.length && !(code.get(a.id)?.hard.length),
);


const batches = [];
// Group by the model that wrote the answer so each batch can be judged by a different model.
const byGen = new Map();
for (const a of todo) byGen.set(a.model ?? "?", [...(byGen.get(a.model ?? "?") ?? []), a]);
// Local-written answers can only be judged by a cloud model (never by the local writer itself), so they go last;
// otherwise they hold the concurrency slots while cloud-written answers wait.
const byGenOrder = [...byGen].sort(([a], [b]) => Number(a.startsWith("local/")) - Number(b.startsWith("local/")));
for (const [, group] of byGenOrder) for (let i = 0; i < group.length; i += BATCH) batches.push(group.slice(i, i + BATCH));
console.log(`[judge] answers=${todo.length} batches=${batches.length} conc=${CONC}`);
const t0 = Date.now();
let n = 0;
let k = 0;
await pMap(
  batches,
  async (batch, bi) => {
    const items = batch.map((a) => ({ ...a, question: qs.get(a.id).question }));
    for (const row of await judgeBatch(items, MODELS, bi)) {
      appendJsonl(OUT, row);
      k++;
    }
    if (++n % 10 === 0) progress(`judge verdicts=${k}`, n, batches.length, t0);
  },
  CONC,
);
console.log(`[judge] done: ${k} verdicts`);

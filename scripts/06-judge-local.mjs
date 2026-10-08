// NOT USED: tried 2026-10-07, Qwen rubber-stamps (5/5 pass on everything), so its verdicts are no gate.
// Stage 6 helper: the local model judges cloud-written answers while the free cloud judges are
// overloaded. Runs beside 06-judge.mjs from the opposite end of the list, re-reading judge.jsonl
// before each batch so nothing the cloud judge finished is judged twice. Never judges local answers.
// Rows carry judge "local/…" so they can be re-judged by a cloud model later (JUDGED_BY=local).
import { join } from "node:path";
import { WORK, readJsonl, appendJsonl, progress, loadKeptQuestions } from "./lib.mjs";
import { judgeBatch } from "./judge-lib.mjs";

const BATCH = Number(process.env.LOCAL_JUDGE_BATCH ?? 3);
const OUT = join(WORK, "judge.jsonl");

const qs = new Map(loadKeptQuestions().map((q) => [q.id, q]));
const checks = new Map(readJsonl(join(WORK, "checks.jsonl")).map((c) => [c.id, c]));
const code = new Map(readJsonl(join(WORK, "codecheck.jsonl")).map((c) => [c.id, c]));
const judged = () => new Set(readJsonl(OUT).map((j) => j.id));
let done = judged();
const todo = readJsonl(join(WORK, "answers.jsonl"))
  .filter((a) => !done.has(a.id) && !String(a.model).startsWith("local/") && qs.has(a.id) && checks.get(a.id) && !checks.get(a.id).hard.length && !(code.get(a.id)?.hard.length))
  .reverse();
console.log(`[judge-local] answers=${todo.length} batch=${BATCH}`);

const t0 = Date.now();
let k = 0;
for (let i = 0; i < todo.length; ) {
  done = judged();
  const batch = [];
  while (i < todo.length && batch.length < BATCH) {
    const a = todo[i++];
    if (!done.has(a.id)) batch.push({ ...a, question: qs.get(a.id).question });
  }
  if (!batch.length) continue;
  try {
    // No cloud models: cloudWithFallback goes straight to the local model.
    const rows = await judgeBatch(batch, [], 0);
    const now = judged();
    for (const row of rows) if (!now.has(row.id)) { appendJsonl(OUT, row); k++; }
  } catch (e) {
    console.error(`[judge-local] batch failed: ${String(e).slice(0, 160)}`);
  }
  progress(`judge-local verdicts=${k}`, i, todo.length, t0);
}
console.log(`[judge-local] done: ${k} verdicts`);

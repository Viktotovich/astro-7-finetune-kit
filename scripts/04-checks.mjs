// Stage 4: deterministic checks on every answer. Output: work/checks.jsonl
//  hard = must be rejected; soft flags lower the ranking score (rules in check-lib.mjs).
import { join } from "node:path";
import { WORK, readJsonl, writeJsonl, loadKeptQuestions } from "./lib.mjs";
import { checkAnswer } from "./check-lib.mjs";

const questions = new Map(loadKeptQuestions().map((q) => [q.id, q]));
const answers = readJsonl(process.env.ANSWERS ?? join(WORK, "answers.jsonl"));

const out = [];
for (const a of answers) {
  const q = questions.get(a.id);
  if (!q) continue;
  out.push({ id: a.id, ...checkAnswer(q, a.answer) });
}
writeJsonl(process.env.CHECKS ?? join(WORK, "checks.jsonl"), out);
const count = (f) => out.filter(f).length;
const reasons = {};
for (const o of out) for (const h of o.hard) { const k = h.split(":")[0]; reasons[k] = (reasons[k] ?? 0) + 1; }
console.log(`[checks] answers=${out.length} hard-rejected=${count((o) => o.hard.length)} clean=${count((o) => !o.hard.length && !o.soft.length)}`);
console.log(`[checks] hard reasons: ${JSON.stringify(reasons)}`);

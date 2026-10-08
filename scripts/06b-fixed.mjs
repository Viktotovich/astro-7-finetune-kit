// Collect judge-corrected answers so they go through the same deterministic + astro check gates.
import { join } from "node:path";
import { WORK, readJsonl, writeJsonl } from "./lib.mjs";

const answers = new Map(readJsonl(join(WORK, "answers.jsonl")).map((a) => [a.id, a]));
const judge = new Map();
for (const j of readJsonl(join(WORK, "judge.jsonl"))) judge.set(j.id, j);
const fixed = [...judge.values()]
  .filter((j) => j.verdict === "fix" && j.fixed_answer && answers.has(j.id))
  .map((j) => ({ id: j.id, answer: j.fixed_answer, sources: answers.get(j.id).sources }));
writeJsonl(join(WORK, "fixed-answers.jsonl"), fixed);
console.log(`[fixed] ${fixed.length} corrected answers queued for re-check`);

// Second look at rejected questions, to catch false negatives from question review.
// Rejected questions that are near-duplicates of a kept question (or of another rejected one)
// are skipped; only the distinct remainder is dumped for manual re-review.
//   node scripts/02d-rejected-recheck.mjs prepare        embed and write work/recheck-candidates.json
//   node scripts/02d-rejected-recheck.mjs dump [N]       print the next N as "k|area|type|difficulty|reason|question"
//   node scripts/02d-rejected-recheck.mjs apply < keep   lines "<k> k" or "<k> i <new wording>" restore those questions
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { WORK, readJsonl, appendJsonl, embed } from "./lib.mjs";

const OUT = join(WORK, "qreview.jsonl");
const CANDS = join(WORK, "recheck-candidates.json");
const LAST = join(WORK, "recheck-last.json");
const DONE = join(WORK, "recheck-done.json");
const DUP = Number(process.env.DUP ?? 0.86);
const REVIEWER = "manual-recheck/claude-opus-5-5";

const reviews = () => {
  const m = new Map();
  for (const r of readJsonl(OUT)) m.set(r.id, r);
  return m;
};
const cos = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const norm = (v) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

const [cmd, arg] = process.argv.slice(2);
if (cmd === "prepare") {
  const rev = reviews();
  const qs = readJsonl(join(WORK, "questions.jsonl")).filter((q) => rev.has(q.id));
  const vecs = [];
  for (let i = 0; i < qs.length; i += 64) {
    vecs.push(...(await embed(qs.slice(i, i + 64).map((q) => `clustering: ${q.question}`))).map(norm));
    if (i % 1280 === 0) console.log(`embedded ${i}/${qs.length}`);
  }
  const keptV = [];
  const out = [];
  qs.forEach((q, i) => rev.get(q.id).keep && keptV.push(vecs[i]));
  const distinctRejected = [];
  let nearKept = 0;
  let nearRejected = 0;
  qs.forEach((q, i) => {
    const r = rev.get(q.id);
    if (r.keep) return;
    if (keptV.some((v) => cos(v, vecs[i]) > DUP)) return nearKept++;
    if (distinctRejected.some((v) => cos(v, vecs[i]) > DUP)) return nearRejected++;
    distinctRejected.push(vecs[i]);
    out.push({ id: q.id, area: q.area, type: q.type, difficulty: q.difficulty, reason: r.reason, reviewer: r.reviewer, question: q.question });
  });
  out.sort((a, b) => a.area.localeCompare(b.area));
  writeFileSync(CANDS, JSON.stringify(out));
  console.log(`rejected=${qs.filter((q) => !rev.get(q.id).keep).length} near-kept=${nearKept} near-other-rejected=${nearRejected} to-recheck=${out.length}`);
} else if (cmd === "dump") {
  const done = new Set(existsSync(DONE) ? JSON.parse(readFileSync(DONE, "utf8")) : []);
  const next = JSON.parse(readFileSync(CANDS, "utf8")).filter((c) => !done.has(c.id)).slice(0, Number(arg ?? 200));
  writeFileSync(LAST, JSON.stringify(next.map((c) => c.id)));
  console.log(`remaining=${JSON.parse(readFileSync(CANDS, "utf8")).length - done.size}`);
  next.forEach((c, k) => console.log(`${k + 1}|${c.area}|${c.type}|${c.difficulty[0]}|${c.reason}|${c.question}`));
} else if (cmd === "apply") {
  const ids = JSON.parse(readFileSync(LAST, "utf8"));
  const done = new Set(existsSync(DONE) ? JSON.parse(readFileSync(DONE, "utf8")) : []);
  let restored = 0;
  for (const line of readFileSync(0, "utf8").split("\n")) {
    const m = line.trim().match(/^(\d+)\s+([ki])(?:\s+(.+))?$/);
    const id = m && ids[Number(m[1]) - 1];
    if (!id) continue;
    appendJsonl(OUT, { id, keep: true, reason: "restored on recheck", question: m[2] === "i" ? m[3]?.trim() : undefined, reviewer: REVIEWER });
    restored++;
  }
  ids.forEach((id) => done.add(id));
  writeFileSync(DONE, JSON.stringify([...done]));
  console.log(`restored=${restored} rechecked=${ids.length}`);
} else {
  console.error("usage: prepare | dump [N] | apply < keep");
  process.exit(1);
}

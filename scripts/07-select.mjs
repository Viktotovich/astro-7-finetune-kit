// Stage 7: gate → score → semantic dedup → quota-aware ranking → exactly N examples.
// Writes dataset.jsonl (model-facing), dataset.meta.jsonl (per-example metadata, joined by id),
// metadata.json (dataset-level).
import { join } from "node:path";
import { ROOT, WORK, ASTRO_VERSION, readJsonl, writeJsonl, writeJson, readJson, embed, loadKeptQuestions } from "./lib.mjs";

const N = Number(process.env.N ?? 3500);
const qs = new Map(loadKeptQuestions().map((q) => [q.id, q]));
const answers = new Map(readJsonl(join(WORK, "answers.jsonl")).map((a) => [a.id, a]));
const checks = new Map(readJsonl(join(WORK, "checks.jsonl")).map((c) => [c.id, c]));
const fixChecks = new Map(readJsonl(join(WORK, "checks-fixed.jsonl")).map((c) => [c.id, c]));
const fixCode = new Map(readJsonl(join(WORK, "codecheck-fixed.jsonl")).map((c) => [c.id, c]));
const judge = new Map();
for (const j of readJsonl(join(WORK, "judge.jsonl"))) judge.set(j.id, j); // last verdict wins
// Refine loop (06c): an accepted rewrite replaces the original answer and verdict.
const refined = new Map();
for (const r of readJsonl(join(WORK, "refine.jsonl"))) refined.set(r.id, r); // last row wins
const overrides = new Map(readJsonl(join(ROOT, "sources", "manual-review.jsonl")).map((o) => [o.id, o]));

// ---- gate + score -------------------------------------------------------------
const cands = [];
const drop = {};
const bump = (k) => (drop[k] = (drop[k] ?? 0) + 1);
for (const id of new Set([...judge.keys(), ...refined.keys()])) {
  const q = qs.get(id);
  const a = answers.get(id);
  if (!q || !a) continue;
  const o = overrides.get(id);
  if (o?.action === "drop") { bump("manual-drop"); continue; }
  const r = refined.get(id);
  if (r && r.status !== "accepted") { bump(`refine-${r.status}`); continue; }
  let j = r ? r.verdict : judge.get(id);
  let text = r ? r.answer : a.answer;
  let soft = r ? r.soft : (checks.get(id)?.soft ?? []);
  if (r) bump("refined-accepted");
  if (!r && j.verdict === "reject") { bump("judge-reject"); continue; }
  if (!r && j.verdict === "fix") {
    const fc = fixChecks.get(id);
    if (!j.fixed_answer || !fc || fc.hard.length || fixCode.get(id)?.hard.length) { bump("fix-failed-checks"); continue; }
    text = j.fixed_answer;
    soft = fc.soft;
  }
  if (o?.answer) text = o.answer;
  const question = o?.question ?? q.question;
  if (j.accuracy < 4 || j.version < 4 || j.usefulness < 4 || j.concise < 3) { bump("low-scores"); continue; }
  const score =
    2 * j.accuracy + 2 * j.version + 1.5 * j.usefulness + j.concise +
    (j.verdict === "pass" ? 1 : 0) - 0.75 * soft.length + (o ? 2 : 0);
  cands.push({ id, q, question, text: text.trim(), score, judge: j });
}
console.log(`[select] gated candidates=${cands.length} dropped=${JSON.stringify(drop)}`);

// ---- semantic dedup (questions) --------------------------------------------------
cands.sort((a, b) => b.score - a.score);
const vecs = [];
for (let i = 0; i < cands.length; i += 64) {
  const batch = cands.slice(i, i + 64).map((c) => `clustering: ${c.question}`);
  vecs.push(...(await embed(batch)));
}
const norm = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const V = vecs.map(norm);
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const DUP = Number(process.env.DUP ?? 0.9);
const kept = [];
const keptVecs = [];
let dups = 0;
for (const [i, c] of cands.entries()) {
  if (keptVecs.some((v) => cos(v, V[i]) > DUP)) { dups++; continue; }
  kept.push({ ...c, vec: V[i] });
  keptVecs.push(V[i]);
}
console.log(`[select] after semantic dedup: ${kept.length} (removed ${dups} near-duplicates at cos>${DUP})`);

// ---- quota-aware selection ---------------------------------------------------------
const AREA_CAP = { errors: 0.11, cms: 0.035, deploy: 0.05, tutorial: 0.015, "migrate-from": 0.015, "upgrade-old": 0.015, experimental: 0.01, legacy: 0.005 };
const SPEC_CAP = 0.1;
const DIFF_TARGET = { foundational: 0.2, intermediate: 0.3, advanced: 0.3, expert: 0.2 };
const cnt = { area: {}, diff: {}, page: {} };
const capOf = (area) => (area.startsWith("spec:") ? SPEC_CAP : AREA_CAP[area] ?? 0.2) * N;
const take = [];
const taken = new Set();
function tryTake(c, strictDiff) {
  const area = c.q.area.startsWith("spec:") ? "spec" : c.q.area;
  if ((cnt.area[area] ?? 0) >= capOf(c.q.area)) return false;
  if ((cnt.page[c.q.source_key] ?? 0) >= 40) return false;
  if (strictDiff && (cnt.diff[c.q.difficulty] ?? 0) >= DIFF_TARGET[c.q.difficulty] * N * 1.1) return false;
  cnt.area[area] = (cnt.area[area] ?? 0) + 1;
  cnt.page[c.q.source_key] = (cnt.page[c.q.source_key] ?? 0) + 1;
  cnt.diff[c.q.difficulty] = (cnt.diff[c.q.difficulty] ?? 0) + 1;
  take.push(c);
  taken.add(c.id);
  return true;
}
for (const c of kept) if (take.length < N) tryTake(c, true);
for (const c of kept) if (take.length < N && !taken.has(c.id)) tryTake(c, false);
if (take.length < N) {
  console.error(`[select] only ${take.length} examples meet the bar (need ${N}). Generate more candidates; the bar is not lowered.`);
  process.exit(2);
}

// ---- write -----------------------------------------------------------------------------
take.sort((a, b) => (a.q.area + a.id).localeCompare(b.q.area + b.id));
writeJsonl(join(ROOT, "dataset.jsonl"), take.map((c) => ({ id: c.id, messages: [{ role: "user", content: c.question }, { role: "assistant", content: c.text }] })));
writeJsonl(
  join(ROOT, "dataset.meta.jsonl"),
  take.map((c) => ({
    id: c.id,
    topic: c.q.area.startsWith("spec:") ? c.q.area : c.q.area,
    focus: c.q.focus,
    type: c.q.type,
    difficulty: c.q.difficulty,
    astro_version: ASTRO_VERSION,
    source: c.q.source_key,
    grounding: answers.get(c.id).sources,
    verified: { deterministic_checks: true, astro_check: true, judge: c.judge.judge, judge_verdict: c.judge.verdict, manual: overrides.has(c.id) },
  })),
);
const dist = (k) => take.reduce((m, c) => ((m[k(c)] = (m[k(c)] ?? 0) + 1), m), {});
const words = take.reduce((s, c) => s + (c.question + " " + c.text).split(/\s+/).length, 0);
writeJson(join(ROOT, "metadata.json"), {
  name: "astro-dataset",
  astro_version: ASTRO_VERSION,
  version_record: readJson(join(ROOT, "sources", "version.json")),
  examples: take.length,
  format: "JSONL, one {id, messages:[user, assistant]} per line; metadata in dataset.meta.jsonl",
  created: new Date().toISOString(),
  candidates: { questions: qs.size, gated: cands.length, after_dedup: kept.length, dedup_cosine_threshold: DUP },
  distribution: { difficulty: dist((c) => c.q.difficulty), type: dist((c) => c.q.type), area: dist((c) => (c.q.area.startsWith("spec:") ? "spec" : c.q.area)) },
  judge_models: dist((c) => c.judge.judge),
  verdicts_used: dist((c) => c.judge.verdict),
  manual_overrides_applied: take.filter((c) => overrides.has(c.id)).length,
  approx_words: words,
  approx_tokens: Math.round(words * 1.4),
});
console.log(`[select] wrote ${take.length} examples; difficulty ${JSON.stringify(dist((c) => c.q.difficulty))}`);

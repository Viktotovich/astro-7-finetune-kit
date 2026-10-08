// Stage 6c: feedback loop. Answers that failed (INSUFFICIENT, hard checks, astro check, judge reject or
// low scores) are not dropped: a strong model rewrites them with the exact reasons they failed and a
// wider grounding context, then the rewrite goes through the same checks, astro check and an
// independent judge. Repeats up to MAX_ROUNDS. A judge "fix" is re-verified as the next candidate.
// Output: work/refine.jsonl (last row per id wins): status accepted | retry | verify | gave-up
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { ROOT, WORK, ASTRO_VERSION, readJsonl, readJson, appendJsonl, writeJsonl, pMap, cloudWithFallback, splitSections, FREE_MODELS, rotate, loadKeptQuestions } from "./lib.mjs";
import { ANSWER_SYSTEM, contextFor } from "./answer-lib.mjs";
import { checkAnswer } from "./check-lib.mjs";
import { judgeBatch } from "./judge-lib.mjs";

const OUT = join(WORK, "refine.jsonl");
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS ?? 4);
const PER_CALL = 4;
const CONC = Number(process.env.CONC ?? 4);
const major = ASTRO_VERSION.split(".")[0];
const gatesOk = (j) => j && j.accuracy >= 4 && j.version >= 4 && j.usefulness >= 4 && j.concise >= 3;

const qs = new Map(loadKeptQuestions().map((q) => [q.id, q]));
const last = (file) => new Map(readJsonl(join(WORK, file)).map((r) => [r.id, r]));
const answers = last("answers.jsonl");
const checks = last("checks.jsonl");
const code = last("codecheck.jsonl");
const judge = last("judge.jsonl");
const fixChecks = last("checks-fixed.jsonl");
const fixCode = last("codecheck-fixed.jsonl");
const refine = last("refine.jsonl");
const staleWhy = new Map(readJson(join(ROOT, "sources", "stale-apis.json")).rules.map((r) => [r.id, r.why]));

/** Plain-English reasons a writer can act on. */
function reasons({ hard = [], codeHard = [], verdict }) {
  const out = [];
  for (const h of hard) {
    const [k, ...rest] = h.split(":");
    const v = rest.join(":");
    if (k === "insufficient") out.push("You replied INSUFFICIENT. The CONTEXT is now wider (more of the source page and extra search results); answer from it.");
    else if (k === "too-short") out.push("Too short to be useful.");
    else if (k === "artifact") out.push("Contains a forbidden phrase (mentions the context/docs, INSUFFICIENT, TODO, AI self-reference, or filler like 'In conclusion').");
    else if (k === "bad-link") out.push(`The link ${v} is not an allowed page. Use only a URL from ALLOWED LINKS, or no link.`);
    else if (k === "stale") out.push(staleWhy.get(v) ?? `Uses an API removed or deprecated in Astro ${major} (${v}).`);
    else if (k === "bad-import") out.push(`The import "${v}" does not exist in Astro ${major}.`);
    else if (k === "unknown-apis") out.push(`These identifiers do not exist anywhere in the Astro docs: ${v}. Do not invent APIs.`);
    else if (k === "unclosed-fence") out.push("A code block is not closed.");
    else out.push(h);
  }
  for (const c of codeHard) out.push(`Type-checking the code against real Astro ${ASTRO_VERSION} types failed: ${c}`);
  if (verdict) out.push(`Independent reviewer: ${verdict.verdict} (accuracy ${verdict.accuracy}/5, version ${verdict.version}/5, usefulness ${verdict.usefulness}/5, concise ${verdict.concise}/5). ${verdict.issues}`);
  return out;
}

// ---- work list from the current state -----------------------------------------------
const items = [];
for (const [id, q] of qs) {
  const r = refine.get(id);
  if (r) {
    if (r.status === "retry" || r.status === "verify") items.push({ id, q, answer: r.answer, sources: r.sources, model: r.model, problems: r.problems, mode: r.status, round: r.round, lowUse: r.lowUse ?? 0 });
    continue;
  }
  const a = answers.get(id);
  const c = checks.get(id);
  if (!a || !c) continue; // not answered / not checked yet
  const codeHard = code.get(id)?.hard ?? [];
  const j = judge.get(id);
  let problems = null;
  if (c.hard.length || codeHard.length) problems = reasons({ hard: c.hard, codeHard });
  else if (j && j.verdict === "fix") {
    const fc = fixChecks.get(id);
    const fixOk = j.fixed_answer && fc && !fc.hard.length && !(fixCode.get(id)?.hard.length);
    if (!fixOk || !gatesOk(j)) problems = reasons({ hard: fc?.hard ?? [], codeHard: fixCode.get(id)?.hard ?? [], verdict: j });
  } else if (j && (j.verdict === "reject" || !gatesOk(j))) problems = reasons({ verdict: j });
  if (problems) items.push({ id, q, answer: a.answer, sources: a.sources, model: a.model, problems, mode: "retry", round: 0, lowUse: j && j.usefulness <= 2 ? 1 : 0 });
}
if (process.env.LIMIT) items.splice(Number(process.env.LIMIT));
console.log(`[refine] to work: ${items.length} (retry ${items.filter((i) => i.mode === "retry").length}, verify ${items.filter((i) => i.mode === "verify").length})`);

const REWRITE = `${ANSWER_SYSTEM}

Each ITEM below has your PREVIOUS ANSWER and the PROBLEMS found with it. Write a corrected, complete answer that fixes every problem.
- If the question rests on a false premise (an API, option or behaviour that does not exist or was removed in Astro ${major}), answer by correcting the premise from the CONTEXT.
- Reply INSUFFICIENT only if the CONTEXT truly does not cover the question.
Output format, nothing else: for each item a line "=====ANSWER n=====" followed by the answer.`;

for (let round = 1; round <= MAX_ROUNDS && items.length; round++) {
  // 1. rewrite (retry items) — verify items keep their candidate answer
  const retry = items.filter((i) => i.mode === "retry");
  const groups = [];
  for (let i = 0; i < retry.length; i += PER_CALL) groups.push(retry.slice(i, i + PER_CALL));
  await pMap(
    groups,
    async (group, gi) => {
      for (const it of group) {
        const ctx = await contextFor(it.q, { size: 12000, extraQueries: it.q.focus ? [it.q.focus] : [], pageChunks: 4 });
        it.ctx = ctx;
        it.links = [...new Set(ctx.map((c) => c.url))];
      }
      const doc =
        `TASK:\n${REWRITE}\n` +
        group
          .map(
            (it, i) =>
              `\n===== ITEM ${i + 1} =====\nQUESTION:\n${it.q.question}\n\nPREVIOUS ANSWER:\n${it.answer}\n\nPROBLEMS:\n- ${it.problems.join("\n- ")}\n\nALLOWED LINKS: ${it.links.join(" ")}\nCONTEXT:\n${it.ctx.map((c) => `<<${c.url}>>\n${c.content}`).join("\n\n")}\n`,
          )
          .join("");
      try {
        const { parsed, model } = await cloudWithFallback(
          doc,
          rotate(FREE_MODELS.filter((m) => m !== group[0].model), gi + round),
          (t) => {
            const s = splitSections(t, "ANSWER");
            return Object.keys(s).length >= Math.ceil(group.length / 2) ? s : null;
          },
        );
        group.forEach((it, i) => {
          if (parsed[i + 1]?.trim()) Object.assign(it, { answer: parsed[i + 1].trim(), sources: it.links, model, rewritten: true });
        });
      } catch (e) {
        console.error(`[refine] rewrite failed: ${String(e).slice(0, 160)}`);
      }
    },
    CONC,
  );

  // Items whose rewrite call failed (every model throttled) wait for the next round unchanged.
  const waiting = items.filter((it) => it.mode === "retry" && !it.rewritten);
  const active = items.filter((it) => it.mode === "verify" || it.rewritten);
  for (const it of active) it.rewritten = false;

  // 2. deterministic checks
  for (const it of active) Object.assign(it, { check: checkAnswer(it.q, it.answer) });

  // 3. astro check on clean candidates (reuses stage 5 via temp files)
  const clean = active.filter((it) => !it.check.hard.length);
  const tmp = { a: join(WORK, "refine-tmp-answers.jsonl"), c: join(WORK, "refine-tmp-checks.jsonl"), k: join(WORK, "refine-tmp-code.jsonl") };
  writeJsonl(tmp.a, clean.map((it) => ({ id: it.id, answer: it.answer, sources: it.sources })));
  writeJsonl(tmp.c, clean.map((it) => ({ id: it.id, ...it.check })));
  if (existsSync(tmp.k)) rmSync(tmp.k);
  spawnSync("node", [join(ROOT, "scripts", "05-codecheck.mjs")], { env: { ...process.env, ANSWERS: tmp.a, CHECKS: tmp.c, CODECHECK: tmp.k }, stdio: "inherit" });
  const codeRes = new Map(readJsonl(tmp.k).map((r) => [r.id, r]));
  for (const it of clean) it.codeHard = codeRes.get(it.id)?.hard ?? [];

  // 4. independent judge on candidates that passed both
  const judged = clean.filter((it) => !it.codeHard.length);
  const jgroups = [];
  for (let i = 0; i < judged.length; i += 8) jgroups.push(judged.slice(i, i + 8));
  await pMap(
    jgroups,
    async (group, gi) => {
      try {
        const rows = await judgeBatch(group.map((it) => ({ id: it.id, question: it.q.question, answer: it.answer, sources: it.sources, model: it.model })), FREE_MODELS, gi + round);
        for (const r of rows) group.find((it) => it.id === r.id).verdict = r;
      } catch (e) {
        console.error(`[refine] judge failed: ${String(e).slice(0, 160)}`);
      }
    },
    CONC,
  );

  // 5. record and decide
  const next = [...waiting];
  let accepted = 0;
  for (const it of active) {
    const v = it.verdict;
    const row = { id: it.id, round: (it.round ?? 0) + 1, answer: it.answer, sources: it.sources, model: it.model, hard: it.check.hard, soft: it.check.soft, codeHard: it.codeHard ?? [], verdict: v };
    delete it.verdict;
    if (!it.check.hard.length && !(it.codeHard ?? []).length && v?.verdict === "pass" && gatesOk(v)) {
      appendJsonl(OUT, { ...row, status: "accepted" });
      accepted++;
      continue;
    }
    it.round = row.round;
    if (v && v.usefulness <= 2) it.lowUse = (it.lowUse ?? 0) + 1;
    if (v?.verdict === "fix" && v.fixed_answer && v.usefulness >= 4) {
      // reviewer supplied a correction: verify it as-is next round
      Object.assign(it, { answer: v.fixed_answer, model: v.judge, mode: "verify", problems: [] });
    } else {
      Object.assign(it, { mode: "retry", problems: v || it.check.hard.length || (it.codeHard ?? []).length ? reasons({ hard: it.check.hard, codeHard: it.codeHard ?? [], verdict: v }) : it.problems });
    }
    const status = row.round >= MAX_ROUNDS || it.lowUse >= 2 ? "gave-up" : it.mode;
    appendJsonl(OUT, { ...row, status, problems: it.problems, lowUse: it.lowUse });
    if (status !== "gave-up") next.push(it);
  }
  console.log(`[refine] round ${round}: accepted ${accepted}, continuing ${next.length} (${waiting.length} still waiting for a model), gave up ${active.length - accepted - (next.length - waiting.length)}`);
  items.length = 0;
  items.push(...next);
}
console.log(`[refine] done`);

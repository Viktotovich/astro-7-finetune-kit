// Stage 2: candidate questions, grounded per docs page (Astro MCP corpus) and per
// Website Specification topic (Specification MCP). Resumable: re-running only fills
// remaining quota. Output: work/questions.jsonl
import { join } from "node:path";
import { ROOT, WORK, ASTRO_VERSION, MODELS, chat, pMap, readJsonl, readJson, appendJsonl, astroSearch, hash, progress, cloudWithFallback, parseJsonLoose, FREE_MODELS, rotate, claim } from "./lib.mjs";

const BACKEND = process.env.BACKEND ?? "cloud";
const CLOUD_MODELS = process.env.GEN_MODELS ? process.env.GEN_MODELS.split(",") : FREE_MODELS;
const CONC = Number(process.env.CONC ?? (BACKEND === "cloud" ? 6 : 4));

const OUT = join(WORK, "questions.jsonl");
const WINDOW = 9000; // chars of source per call (~2.5k tokens)
const PER_CALL = 6;
const TYPES = ["how-to", "concept", "distinction", "debugging", "configuration", "migration", "when-not-to", "architecture", "edge-case"];
const LEVELS = ["foundational", "intermediate", "advanced", "expert"];
const major = ASTRO_VERSION.split(".")[0];
// Round 2+: ROUND=2 EXTRA=1 AREAS=guides,reference adds EXTRA x quota for those areas only,
// with fresh claim keys and windows continuing where round 1 stopped.
const ROUND = Number(process.env.ROUND ?? 1);
const EXTRA = Number(process.env.EXTRA ?? 0);
const AREAS = process.env.AREAS ? process.env.AREAS.split(",") : null;

const inv = readJson(join(ROOT, "sources", "inventory.json"));
const corpus = readJsonl(join(WORK, "corpus.jsonl"));
const spec = readJsonl(join(WORK, "spec.jsonl"));
const existing = readJsonl(OUT);
const have = new Map();
for (const q of existing) have.set(q.source_key, [...(have.get(q.source_key) ?? []), q.question]);

const SYSTEM = `You write training questions for a model that must answer developer questions about Astro ${major} (exact version ${ASTRO_VERSION}).
Rules:
- Every question must be fully answerable from the SOURCE text given, and must be about current Astro ${major} behavior (questions on removed/old APIs only when the source is an upgrade/migration guide, and then phrase them as migration questions).
- Write like a real developer: concrete, specific, self-contained. Include the relevant API, option, file name, error message, or symptom in the question itself. Never mention "the source", "the docs above", or "this page".
- Vary the kind of question. Use these types: ${TYPES.join(", ")}.
  "distinction" = when to use one API/option vs a similar one. "debugging" = a symptom or error message and why it happens. "when-not-to" = a case where the right answer is NOT to use some feature. "edge-case" = unusual but realistic behavior.
- Avoid trivia ("what is X?", "which version added X", "where are the docs for X", "how do I report a bug") and avoid rephrasings of the same question or of the "Already asked" list.
- Never invent APIs, options, error names or behavior that the SOURCE does not state.
- Every question must be about building with Astro: Astro APIs, config, files, behavior, or how Astro interacts with a tool/host. Skip questions that are only about a third-party tool's own settings (editor setup, a host's dashboard) with nothing Astro-specific.
- Refer to the framework as "Astro" (optionally "Astro ${major}" when the version matters). Never write a patch version like ${ASTRO_VERSION}.
- Difficulty: foundational (first weeks with Astro), intermediate, advanced, or expert. Every batch MUST include at least one foundational and at least one advanced-or-expert question.
Return ONLY a JSON array: [{"question": "...", "type": "<type>", "difficulty": "<level>", "focus": "<the specific API or concept tested>"}]`;

function windowsFor(url) {
  const text = corpus.filter((c) => c.url === url).map((c) => c.content).join("\n\n");
  const wins = [];
  for (let i = 0; i < text.length; i += WINDOW) wins.push(text.slice(i, i + WINDOW));
  return wins;
}

function valid(q) {
  return (
    q &&
    typeof q.question === "string" &&
    q.question.length >= 25 &&
    q.question.length <= 600 &&
    TYPES.includes(q.type) &&
    LEVELS.includes(q.difficulty) &&
    !/\b(the|this) (source|page|excerpt|documentation above)\b/i.test(q.question)
  );
}

// Jobs: one per (source window, batch) until the source's quota is met.
const jobs = [];
for (const p of inv.pages.filter((p) => p.quota > 0 && (!AREAS || AREAS.includes(p.area)))) {
  const done = (have.get(p.url) ?? []).length;
  const wins = windowsFor(p.url);
  if (!wins.length) continue;
  let left = Math.round(p.quota * (1 + EXTRA)) - done;
  for (let b = Math.ceil(done / PER_CALL); left > 0; b++) {
    const n = Math.min(PER_CALL, left);
    jobs.push({ kind: "docs", key: p.url, area: p.area, win: wins[b % wins.length], n, batch: ROUND > 1 ? `r${ROUND}-${b}` : b });
    left -= n;
  }
}

// Spec topics: ground in the spec page plus what Astro docs say about the same subject.
const perTopic = Math.round(Math.max(2, Math.round(inv.spec_question_quota / Math.max(1, spec.length))) * (1 + EXTRA));
for (const t of spec.filter((t) => !AREAS || AREAS.includes(`spec:${t.category}`))) {
  const done = (have.get(t.url) ?? []).length;
  if (done < perTopic) jobs.push({ kind: "spec", key: t.url, area: `spec:${t.category}`, topic: t, n: Math.min(PER_CALL, perTopic - done), batch: ROUND > 1 ? `r${ROUND}` : 0 });
}

// LIMIT=n runs an evenly spaced sample of jobs (pilot across the whole docs).
if (process.env.LIMIT) {
  const n = Number(process.env.LIMIT);
  const step = jobs.length / n;
  const sample = Array.from({ length: Math.min(n, jobs.length) }, (_, i) => jobs[Math.floor(i * step)]);
  jobs.length = 0;
  jobs.push(...sample);
}
if (process.env.REVERSE) jobs.reverse();
console.log(`[questions] jobs=${jobs.length} existing=${existing.length}`);
const t0 = Date.now();
let done = 0;
let made = 0;

await pMap(
  jobs,
  async (job, ji) => {
    if (!claim("q", `${job.key}|${job.batch}|${job.n}`)) return;
    let source;
    if (job.kind === "docs") {
      source = job.win;
    } else {
      const astro = (await astroSearch(`${job.topic.title} Astro`)).slice(0, 3);
      source =
        `WEB PLATFORM SPEC: ${job.topic.title}\n${job.topic.content.slice(0, 4500)}\n\n` +
        `ASTRO DOCS:\n${astro.map((c) => c.content).join("\n\n").slice(0, 4500)}`;
    }
    const prior = (have.get(job.key) ?? []).slice(ROUND > 1 ? -30 : -12);
    const extra =
      job.kind === "spec"
        ? `Only write questions about meeting this web-platform requirement IN AN ASTRO SITE, naming the Astro mechanism (middleware, endpoints, response headers, config, integrations, <Image />, i18n routing, prefetch, etc.). Every question must mention Astro. Return fewer or [] if Astro has nothing specific to offer.`
        : "";
    const user =
      `SOURCE:\n${source}\n\n` +
      (prior.length ? `Already asked (do not repeat or rephrase):\n- ${prior.join("\n- ")}\n\n` : "") +
      `${extra}\nWrite ${job.n} questions, mixing types and difficulties.`;
    let out;
    let qModel = MODELS.fast;
    if (BACKEND === "cloud") {
      const r = await cloudWithFallback(`TASK:\n${SYSTEM}\n\n${user}`, rotate(CLOUD_MODELS, ji), (t) => {
        const a = parseJsonLoose(t);
        return Array.isArray(a) ? a : null;
      });
      out = r.parsed;
      qModel = r.model;
    } else {
      out = await chat(
        [
          { role: "system", content: SYSTEM },
          { role: "user", content: user },
        ],
        { temperature: 0.8, maxTokens: 1200, seed: Number.parseInt(hash(job.key + job.batch, 6), 16), json: true },
      );
    }
    const list = (Array.isArray(out) ? out : []).filter(valid).slice(0, job.n);
    for (const q of list) {
      const row = {
        id: `q_${hash(job.key + q.question)}`,
        question: q.question.trim(),
        type: q.type,
        difficulty: q.difficulty,
        focus: String(q.focus ?? "").slice(0, 120),
        area: job.area,
        source_key: job.key,
        source_kind: job.kind,
        model: qModel,
      };
      appendJsonl(OUT, row);
      have.set(job.key, [...(have.get(job.key) ?? []), row.question]);
      made++;
    }
    if (++done % 40 === 0) progress(`questions +${made}`, done, jobs.length, t0);
  },
  CONC,
);
console.log(`[questions] done: +${made} new, total ${readJsonl(OUT).length}`);

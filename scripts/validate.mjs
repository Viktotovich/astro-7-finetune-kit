// Acceptance checks for the final dataset. Exits non-zero on any failure.
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { ROOT, ASTRO_VERSION, readJson } from "./lib.mjs";

const N = Number(process.env.N ?? 3500);
const fails = [];
const warn = [];
const fail = (m) => fails.push(m);

function load(p) {
  const rows = [];
  readFileSync(p, "utf8").split("\n").forEach((l, i) => {
    if (!l.trim()) return;
    try { rows.push(JSON.parse(l)); } catch { fail(`${p}:${i + 1} malformed JSON`); }
  });
  return rows;
}

const data = load(join(ROOT, "dataset.jsonl"));
const meta = load(join(ROOT, "dataset.meta.jsonl"));
const md = readJson(join(ROOT, "metadata.json"), {});
const rules = readJson(join(ROOT, "sources", "stale-apis.json")).rules.map((r) => ({ ...r, rx: new RegExp(r.re, "i") }));
const docsUrls = new Set(readJson(join(ROOT, "sources", "inventory.json")).pages.map((p) => p.url));
const metaById = new Map(meta.map((m) => [m.id, m]));

if (data.length !== N) fail(`expected exactly ${N} examples, found ${data.length}`);
if (meta.length !== data.length) fail(`dataset.meta.jsonl has ${meta.length} rows, dataset has ${data.length}`);
if (md.examples !== data.length) fail(`metadata.json examples=${md.examples} != ${data.length}`);
if (md.astro_version !== ASTRO_VERSION) fail(`metadata.json astro_version ${md.astro_version} != ${ASTRO_VERSION}`);

const ids = new Set();
const seenQ = new Map();
const ARTIFACTS = [
  [/\bas an ai\b|\blanguage model\b/i, "AI self-reference"],
  [/\b(TODO|FIXME|TBD|lorem ipsum|XXX)\b/, "placeholder/TODO"],
  [/<(your|placeholder|insert)[^>]*>|\[(insert|placeholder)[^\]]*\]/i, "placeholder text"],
  [/\b(the|this) (context|excerpt|provided (documentation|docs|text))\b/i, "references generation context"],
  [/\b(dataset|training (data|example)|fine-?tun)/i, "references the dataset/generation process"],
  [/\bINSUFFICIENT\b|```\s*$(?![\s\S]*```)/, "generation artifact"],
  [/\b(difficulty|astro_version|source_key|verified)\s*[:=]/i, "metadata leakage"],
];

const shingles = (s) => {
  const w = s.toLowerCase().replace(/[^a-z0-9:./@-]+/g, " ").trim().split(" ");
  const set = new Set();
  for (let i = 0; i + 3 <= w.length; i++) set.add(w.slice(i, i + 3).join(" "));
  return set;
};
const sh = [];

for (const [i, r] of data.entries()) {
  const at = `example ${i + 1} (${r.id})`;
  const keys = Object.keys(r).sort().join(",");
  if (keys !== "id,messages") fail(`${at}: unexpected keys ${keys}`);
  if (ids.has(r.id)) fail(`${at}: duplicate id`);
  ids.add(r.id);
  const m = r.messages;
  if (!Array.isArray(m) || m.length !== 2 || m[0]?.role !== "user" || m[1]?.role !== "assistant") { fail(`${at}: messages must be [user, assistant]`); continue; }
  const [q, a] = [m[0].content, m[1].content];
  if (typeof q !== "string" || q.trim().length < 15) fail(`${at}: empty/short question`);
  if (typeof a !== "string" || a.trim().length < 40) fail(`${at}: empty/short answer`);
  if ((a.match(/```/g) ?? []).length % 2) fail(`${at}: unclosed code fence`);
  for (const [rx, why] of ARTIFACTS) {
    if (rx.test(q)) fail(`${at}: question ${why}`);
    if (rx.test(a)) fail(`${at}: answer ${why}`);
  }
  const nq = q.toLowerCase().replace(/\s+/g, " ").trim();
  if (seenQ.has(nq)) fail(`${at}: duplicate question of ${seenQ.get(nq)}`);
  seenQ.set(nq, r.id);
  sh.push([r.id, shingles(q)]);

  const mt = metaById.get(r.id);
  if (!mt) fail(`${at}: no metadata row`);
  else if (mt.astro_version !== ASTRO_VERSION) fail(`${at}: astro_version ${mt.astro_version}`);
  const migration = mt && (mt.type === "migration" || /^upgrade/.test(mt.topic));
  for (const rule of rules) if (rule.rx.test(a) && !migration) fail(`${at}: stale API (${rule.id})`);

  const prose = a.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const links = [...prose.matchAll(/https?:\/\/[^\s)>\]"'`]+/g)]
    .map((x) => x[0].replace(/[.,;:]$/, ""))
    .filter((l) => !/^https?:\/\/(localhost|127\.0\.0\.1|([a-z0-9-]+\.)*example\.[a-z]+)([:/]|$)/.test(l));
  if (links.length > 1) fail(`${at}: more than one link`);
  for (const l of links) {
    const base = l.replace(/#.*$/, "").replace(/\/?$/, "/");
    if (!docsUrls.has(base) && !/^https:\/\/specification\.website\/spec\/[a-z0-9-]+\/[a-z0-9-]+\/$/.test(base)) fail(`${at}: link not a known docs/spec page: ${l}`);
  }
}

// Near-duplicate questions (lexical backstop; semantic dedup happened in 07-select).
let near = 0;
for (let i = 0; i < sh.length; i++) {
  for (let j = i + 1; j < sh.length; j++) {
    const [a, b] = [sh[i][1], sh[j][1]];
    if (a.size < 4 || b.size < 4) continue;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    if (inter / (a.size + b.size - inter) > 0.7) { near++; if (near <= 10) fail(`near-duplicate questions: ${sh[i][0]} ~ ${sh[j][0]}`); }
  }
}
if (near > 10) fail(`…and ${near - 10} more near-duplicate pairs`);

for (const f of ["README.md", "metadata.json", "dataset.jsonl", "dataset.meta.jsonl", "sources/version.json", "sources/inventory.json", "sources/stale-apis.json"])
  if (!existsSync(join(ROOT, f))) fail(`missing ${f}`);

console.log(`[validate] examples=${data.length} failures=${fails.length}`);
for (const f of fails.slice(0, 40)) console.log("  FAIL " + f);
for (const w of warn) console.log("  warn " + w);
process.exit(fails.length ? 1 : 0);

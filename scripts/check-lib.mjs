// Deterministic answer checks shared by stage 4 and the refine loop (06c).
//  hard = must be rejected; soft flags lower the ranking score.
import { join } from "node:path";
import { ROOT, WORK, readJsonl, readJson } from "./lib.mjs";


const corpus = readJsonl(join(WORK, "corpus.jsonl"));
const spec = readJsonl(join(WORK, "spec.jsonl"));
const rules = readJson(join(ROOT, "sources", "stale-apis.json")).rules.map((r) => ({ ...r, rx: new RegExp(r.re, "i") }));
const docsUrls = new Set(readJson(join(ROOT, "sources", "inventory.json")).pages.map((p) => p.url));

const corpusText = corpus.map((c) => c.content).join("\n");
const vocab = (corpusText + "\n" + spec.map((t) => t.content).join("\n")).toLowerCase();

// Known named imports per module, as they appear in the docs' own code.
const known = new Map();
const IMPORT_RX = /import\s+(?:type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g;
for (const m of corpusText.matchAll(IMPORT_RX)) {
  const set = known.get(m[3]) ?? new Set();
  if (m[1]) set.add("default");
  for (const n of (m[2] ?? "").split(",")) {
    const name = n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
    if (name) set.add(name);
  }
  known.set(m[3], set);
}

const ARTIFACTS = [
  /\bas an ai\b/i,
  /\b(the|this) (context|excerpt|provided (documentation|docs|text))\b/i,
  /\bINSUFFICIENT\b/,
  /\b(TODO|FIXME|TBD|lorem ipsum)\b/i,
  /<(your|placeholder)[^>]*>/i,
  /\bI hope this helps\b/i,
  /\bIn conclusion\b/i,
  /\b(this|the|training|fine-tuning) dataset\b|\btraining example\b|\bgenerated answer\b/i,
];
const COMMON = new Set("true false null undefined async await const let export import default return response request fetch url headers json string number boolean object array promise map set date error console".split(" "));


/** Check one answer for question q. Returns { hard, soft, links, code_blocks, chars }. */
export function checkAnswer(q, text) {
  const prose = text.replace(/```[\s\S]*?```/g, "");
  const code = [...text.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1], body: m[2] }));
  const hard = [];
  const soft = [];

  if (/^INSUFFICIENT\b/.test(text.trim())) hard.push("insufficient");
  if (text.length < 60) hard.push("too-short");
  if (text.length > 2600) soft.push("long");
  if ((text.match(/```/g) ?? []).length % 2) hard.push("unclosed-fence");
  for (const rx of ARTIFACTS) if (rx.test(text)) hard.push(`artifact:${rx.source.slice(0, 24)}`);

  // Links: at most one, must be a real Astro docs or Website Specification page.
  // Local dev-server URLs (localhost:4321) are examples, not links.
  // URLs inside code blocks or inline code are example values (site: "https://example.com"), not citations.
  const links = [...prose.replace(/`[^`\n]*`/g, "").matchAll(/https?:\/\/[^\s)>\]"'`]+/g)]
    .map((m) => m[0].replace(/[.,;:]$/, ""))
    .filter((l) => !/^https?:\/\/(localhost|127\.0\.0\.1|([a-z0-9-]+\.)*example\.[a-z]+)([:/]|$)/.test(l));
  if (links.length > 1) soft.push("multiple-links");
  for (const l of links) {
    const base = l.replace(/#.*$/, "").replace(/\/?$/, "/");
    const ok = docsUrls.has(base) || /^https:\/\/specification\.website\/spec\/[a-z0-9-]+\/[a-z0-9-]+\/$/.test(base);
    if (!ok) hard.push(`bad-link:${l.slice(0, 80)}`);
  }

  // Stale APIs (allowed only in migration answers that present them as old).
  const migration = q.type === "migration" || q.area.startsWith("upgrade");
  for (const r of rules) {
    if (!r.rx.test(text)) continue;
    if (migration && /\b(removed|deprecated|renamed|replace|no longer|instead|previously|old)\b/i.test(text)) soft.push(`stale-in-migration:${r.id}`);
    else hard.push(`stale:${r.id}`);
  }

  // Imports from astro / @astrojs modules must exist in the docs.
  const badImports = [];
  for (const blk of code) {
    for (const m of blk.body.matchAll(IMPORT_RX)) {
      const mod = m[3];
      if (!/^(astro($|:|\/)|@astrojs\/)/.test(mod)) continue;
      const set = known.get(mod);
      if (!set) { badImports.push(`${mod} (unknown module)`); continue; }
      for (const n of (m[2] ?? "").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").split(",")) {
        const name = n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (name && !set.has(name) && !vocab.includes(name.toLowerCase())) badImports.push(`${name} from ${mod}`);
      }
    }
  }
  if (badImports.length) hard.push(...badImports.map((b) => `bad-import:${b}`));

  // Backticked API-like identifiers in prose must appear somewhere in the docs/spec corpus.
  const unknown = [];
  for (const m of prose.matchAll(/`([^`\n]{2,60})`/g)) {
    const tok = m[1].trim().replace(/\(\)$/, "");
    if (!/^[A-Za-z_$@][\w$.:/@-]*$/.test(tok) || COMMON.has(tok.toLowerCase())) continue;
    // File paths are the asker's own project files, not APIs (src/pages/x.md, layouts/Base.astro).
    if (tok.includes("/") && !/^(astro|@astrojs)\b/.test(tok)) continue;
    if (/\.(astro|md|mdx|mdoc|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|css|scss|svelte|vue|html|png|jpe?g|svg|webp|avif|txt)$/i.test(tok)) continue;
    // Astro.props.<name> carries the component's own props; only Astro.<member> is an API surface.
    if (/^Astro\.props\./.test(tok)) continue;
    if (/@\d/.test(tok)) continue; // package@version
    // Dotted paths (security.csp.directives, event.newDocument): every segment must be a known word.
    if (tok.includes(".") && tok.split(".").every((s) => s && new RegExp(`\\b${s.replace(/[$]/g, "\\$")}\\b`, "i").test(vocab))) continue;
    if (!vocab.includes(tok.toLowerCase())) unknown.push(tok);
  }
  // Astro.* member access in code must exist in the docs.
  for (const blk of code) for (const m of blk.body.matchAll(/\bAstro\.(\w+)/g)) if (!vocab.includes(`astro.${m[1].toLowerCase()}`)) unknown.push(`Astro.${m[1]}`);
  if (unknown.length >= 2) hard.push(`unknown-apis:${unknown.slice(0, 4).join(",")}`);
  else if (unknown.length === 1) soft.push(`unknown-api:${unknown[0]}`);

  return { hard, soft, links: links.length, code_blocks: code.length, chars: text.length };
}

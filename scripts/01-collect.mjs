// Stage 1: authoritative sources.
//  - target version from the npm registry, confirmed against the docs' upgrade guide (Astro MCP)
//  - page inventory from the docs sitemap, with an area + candidate-question quota per page
//  - docs corpus: Astro MCP search results, grouped by page (work/corpus.jsonl)
//  - Website Specification topics (Specification MCP) for web-platform grounding (work/spec.jsonl)
import { join } from "node:path";
import { ROOT, WORK, ASTRO_VERSION, astroSearch, specCall, pMap, readJsonl, writeJsonl, writeJson, hash } from "./lib.mjs";

const TARGET_CANDIDATES = Number(process.env.CANDIDATES ?? 6200);

// --- version -----------------------------------------------------------------
const npm = await (await fetch("https://registry.npmjs.org/astro/latest")).json();
if (npm.version !== ASTRO_VERSION) {
  console.error(`npm latest is ${npm.version} but lib.mjs targets ${ASTRO_VERSION}; update ASTRO_VERSION first.`);
  process.exit(1);
}
const upg = await astroSearch(`upgrade to Astro v${ASTRO_VERSION.split(".")[0]}`);
const major = ASTRO_VERSION.split(".")[0];
if (!upg.some((r) => r.url.includes(`/upgrade-to/v${major}/`))) {
  console.error(`docs MCP has no upgrade guide for v${major}`);
  process.exit(1);
}
writeJson(join(ROOT, "sources", "version.json"), {
  astro: ASTRO_VERSION,
  checked_at: new Date().toISOString(),
  npm_latest: npm.version,
  docs_upgrade_guide: `https://docs.astro.build/en/guides/upgrade-to/v${major}/`,
  node_minimum: "22 (Astro v6+)",
  vite: "8 (Astro v7)",
});
console.log(`[version] Astro ${ASTRO_VERSION} confirmed (npm + docs upgrade guide)`);

// --- inventory ---------------------------------------------------------------
const sitemap = await (await fetch("https://docs.astro.build/sitemap-0.xml")).text();
const urls = [...sitemap.matchAll(/<loc>(https:\/\/docs\.astro\.build\/en\/[^<]+)<\/loc>/g)].map((m) => m[1].replace(/\/?$/, "/"));

function classify(path) {
  const rules = [
    [/^reference\/errors\//, "errors", 5],
    [/^guides\/cms\//, "cms", 3],
    [/^guides\/deploy\//, "deploy", 6],
    [/^guides\/integrations-guide\//, "integrations", 16],
    [/^guides\/migrate-to-astro\//, "migrate-from", 2],
    [/^guides\/upgrade-to\/v[67]$/, "upgrade", 45],
    [/^guides\/upgrade-to\//, "upgrade-old", 4],
    [/^tutorial\//, "tutorial", 2],
    [/^reference\/modules\//, "api-modules", 28],
    [/^reference\/experimental-flags\//, "experimental", 5],
    [/^reference\/legacy-flags/, "legacy", 3],
    [/^guides\/backend\//, "backend", 5],
    [/^guides\/media\//, "media", 4],
    [/^recipes\//, "recipes", 8],
    [/^reference\//, "reference", 28],
    [/^guides\//, "guides", 28],
  ];
  for (const [re, area, q] of rules) if (re.test(path)) return { area, weight: q };
  return { area: "basics", weight: 18 };
}

const pages = urls.map((url) => {
  const path = url.replace("https://docs.astro.build/en/", "").replace(/\/$/, "");
  const { area, weight } = classify(path);
  const query = path.split("/").slice(-2).join(" ").replace(/[-_]/g, " ").replace(/\bv(\d)\b/, "v$1");
  return { url, path, area, weight, query };
});

// --- docs corpus via the Astro MCP ---------------------------------------------
const corpus = new Map(); // key -> chunk
const add = (c) => {
  const key = hash(c.anchor + c.content, 16);
  if (!corpus.has(key)) corpus.set(key, { key, url: c.url, anchor: c.anchor, title: c.title, content: c.content });
};
let n = 0;
await pMap(
  pages,
  async (p) => {
    for (const q of [p.query, `${p.query} example`, `${p.query} configuration options`]) {
      for (const c of await astroSearch(q)) add(c);
    }
    // One more MCP search per section heading of the page, so long pages are covered
    // section by section (the page HTML is only used for its h2/h3 titles).
    const html = await (await fetch(p.url)).text().catch(() => "");
    const title = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) ?? [])[1]?.replace(/<[^>]+>/g, "").trim() ?? p.query;
    const heads = [...html.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/g)]
      .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/g, " ").trim())
      .filter((h) => h && !/^(on this page|related|see also|learn more)$/i.test(h))
      .slice(0, 25);
    for (const h of heads) for (const c of await astroSearch(`${title} ${h}`)) add(c);
    if (++n % 50 === 0) console.log(`[corpus] ${n}/${pages.length} pages queried, ${corpus.size} chunks`);
  },
  3,
);
const chunks = [...corpus.values()];
const byUrl = new Map();
for (const c of chunks) byUrl.set(c.url, (byUrl.get(c.url) ?? 0) + 1);
for (const p of pages) p.chunks = byUrl.get(p.url) ?? 0;

// Pages the MCP returned nothing for can't ground questions; drop their quota.
const usable = pages.filter((p) => p.chunks > 0);
const wsum = usable.reduce((s, p) => s + p.weight, 0);
for (const p of pages) p.quota = p.chunks > 0 ? Math.max(1, Math.round((p.weight / wsum) * TARGET_CANDIDATES * 0.9)) : 0;

writeJsonl(join(WORK, "corpus.jsonl"), chunks);

// --- Website Specification topics ----------------------------------------------
const topicsText = await specCall("list_topics", { limit: 500 });
// Entries look like: **[Title](https://specification.website/spec/<category>/<slug>/)** — status, category
const listed = [...topicsText.matchAll(/\]\((https:\/\/specification\.website\/spec\/([a-z0-9-]+)\/([a-z0-9-]+)\/)\)\*\*\s*—\s*([a-z]+)/g)];
const spec = [];
await pMap(
  listed,
  async ([, url, category, slug, status]) => {
    const md = await specCall("get_topic", { slug });
    const title = (md.match(/^title:\s*["']?(.+?)["']?\s*$/m) ?? [])[1] ?? slug;
    spec.push({ slug, title, category, status, url, content: md });
  },
  3,
);
writeJsonl(join(WORK, "spec.jsonl"), spec);
// About 10% of candidates come from web-platform topics that matter to Astro sites.
const specQuota = Math.round(TARGET_CANDIDATES * 0.1);

writeJson(join(ROOT, "sources", "inventory.json"), {
  astro_version: ASTRO_VERSION,
  docs_pages: pages.length,
  docs_pages_with_chunks: usable.length,
  corpus_chunks: chunks.length,
  spec_topics: spec.length,
  spec_question_quota: specQuota,
  pages: pages.map(({ url, area, chunks, quota }) => ({ url, area, chunks, quota })),
  spec: spec.map(({ slug, title, category, url }) => ({ slug, title, category, url })),
});

const byArea = {};
for (const p of pages) byArea[p.area] = (byArea[p.area] ?? 0) + p.quota;
console.log(`[collect] pages=${pages.length} usable=${usable.length} chunks=${chunks.length} spec_topics=${spec.length}`);
console.log(`[collect] candidate quota by area: ${JSON.stringify(byArea)} + spec ${specQuota}`);

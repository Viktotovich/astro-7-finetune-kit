// Answer-writing prompt and grounding context, shared by stage 3 and the refine loop (06c).
import { join } from "node:path";
import { WORK, ASTRO_VERSION, readJsonl, astroSearch } from "./lib.mjs";

const CTX = 8000;
const major = ASTRO_VERSION.split(".")[0];
const corpus = readJsonl(join(WORK, "corpus.jsonl"));
const spec = new Map(readJsonl(join(WORK, "spec.jsonl")).map((t) => [t.url, t]));

export const ANSWER_SYSTEM = `You are an Astro ${major} expert writing reference-quality answers (Astro ${ASTRO_VERSION}).
Rules:
- Use ONLY facts from CONTEXT. Do not invent APIs, options, imports, file names, or CLI flags. If CONTEXT lacks what is needed for an accurate answer, reply exactly: INSUFFICIENT
- Answer directly in the first sentence. Be concise and documentation-like: usually 40–200 words. No filler, no restating the question, no "In conclusion".
- Include a short code example only when it materially helps. Code must use current Astro ${major} syntax with correct imports, exactly as shown in CONTEXT.
- State version or runtime distinctions when they matter (e.g. removed in v6, on-demand vs prerendered, Node vs edge).
- Links: most answers need NO link. Add one only when the reader genuinely needs the authoritative reference for more detail (full option lists, API signatures, adapter/host specifics), as a final line "Docs: <url>" using only a URL from ALLOWED LINKS. Never add a link to a self-contained answer.
- Never mention "the context", "the documentation provided", or that you are an AI.`;

function overlap(q, text) {
  const words = new Set(q.toLowerCase().match(/[a-z0-9:._-]{4,}/g) ?? []);
  let s = 0;
  for (const w of words) if (text.toLowerCase().includes(w)) s++;
  return s;
}

/** Grounding for one question: MCP search hits + best chunks of its source page (+ spec topic). */
export async function contextFor(q, { size: max = CTX, extraQueries = [], pageChunks = 2 } = {}) {
  const hits = [];
  for (const s of [q.question, ...extraQueries]) hits.push(...(await astroSearch(s)).slice(0, 4));
  const page = q.source_kind === "docs" ? corpus.filter((c) => c.url === q.source_key) : [];
  page.sort((a, b) => overlap(q.question, b.content) - overlap(q.question, a.content));
  const picked = [];
  const seen = new Set();
  let size = 0;
  const t = spec.get(q.source_key);
  if (t) {
    const s = t.content.replace(/^---[\s\S]*?---/, "").slice(0, 2500);
    picked.push({ url: t.url, content: `[Web spec: ${t.title}]\n${s}` });
    size += s.length;
  }
  for (const c of [...hits, ...page.slice(0, pageChunks)]) {
    const k = c.content.slice(0, 120);
    if (seen.has(k) || size + c.content.length > max) continue;
    seen.add(k);
    picked.push(c);
    size += c.content.length;
  }
  return picked;
}

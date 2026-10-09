// Shared helpers: LM Studio chat/embeddings, MCP calls with disk cache, JSONL I/O.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, openSync, closeSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, setGlobalDispatcher } from "undici";
import { spawn } from "node:child_process";

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WORK = join(ROOT, "work");
export const LMS = process.env.LMS_BASE ?? "http://127.0.0.1:1234";
export const ASTRO_VERSION = "7.3.5";
export const MODELS = {
  fast: process.env.LOCAL_MODEL ?? "qwen3-coder-30b-a3b-instruct@q3_k_xl",
  embed: "text-embedding-nomic-embed-text-v1.5",
};
const MCP = {
  astro: "https://mcp.docs.astro.build/mcp",
  spec: "https://mcp.specification.website/mcp",
};

export const hash = (s, n = 10) => createHash("sha256").update(s).digest("hex").slice(0, n);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}

export function readJsonl(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function appendJsonl(p, obj) {
  ensureDir(dirname(p));
  appendFileSync(p, JSON.stringify(obj) + "\n");
}

export function writeJsonl(p, rows) {
  ensureDir(dirname(p));
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

export function readJson(p, fallback) {
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback;
}

export function writeJson(p, obj) {
  ensureDir(dirname(p));
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

/** Bounded-concurrency map that keeps going when one item throws. */
export async function pMap(items, fn, concurrency = 4) {
  let i = 0;
  let failed = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          await fn(items[idx], idx);
        } catch (e) {
          failed++;
          console.error(`  ! item ${idx}: ${String(e.message ?? e).slice(0, 200)}`);
        }
      }
    }),
  );
  return failed;
}

// ---- MCP ------------------------------------------------------------------

async function mcpCall(server, name, args) {
  const cacheFile = join(WORK, "mcp-cache", server, hash(name + JSON.stringify(args), 16) + ".json");
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, "utf8"));
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(MCP[server], {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      if (!r.ok) throw new Error(`MCP ${server} ${r.status}`);
      const body = await r.text();
      const line = body.split("\n").map((l) => l.replace(/^data: /, "")).find((l) => l.startsWith("{"));
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(`MCP ${server}: ${msg.error.message}`);
      const text = msg.result.content.map((c) => c.text ?? "").join("\n");
      ensureDir(dirname(cacheFile));
      writeFileSync(cacheFile, JSON.stringify(text));
      return text;
    } catch (e) {
      lastErr = e;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/** Astro docs search → [{url, title, content}] */
export async function astroSearch(query) {
  const text = await mcpCall("astro", "search_astro_docs", { query });
  const j = JSON.parse(text);
  return (j.search_results ?? []).map((r) => ({
    url: r.source_url.replace(/#.*$/, "").replace(/\/?$/, "/"),
    anchor: r.source_url,
    title: r.title,
    content: r.content,
  }));
}

export const specCall = (name, args = {}) => mcpCall("spec", name, args);

// ---- LM Studio --------------------------------------------------------------

const stats = { calls: 0, tokens: 0, ms: 0 };
export const llmStats = stats;

export async function chat(messages, { model = MODELS.fast, temperature = 0.4, maxTokens = 800, seed, json = false } = {}) {
  const body = { model, messages, temperature, max_tokens: maxTokens, stream: false };
  if (seed !== undefined) body.seed = seed;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const t0 = Date.now();
      const r = await fetch(`${LMS}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        // A hung local request would otherwise block its batch forever.
        signal: AbortSignal.timeout(Number(process.env.LOCAL_TIMEOUT_MS ?? 900000)),
      });
      if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      stats.calls++;
      stats.tokens += j.usage?.completion_tokens ?? 0;
      stats.ms += Date.now() - t0;
      const out = j.choices?.[0]?.message?.content ?? "";
      return json ? parseJsonLoose(out) : out;
    } catch (e) {
      lastErr = e;
      await sleep(2000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

// ---- OpenCode CLI (free cloud models) -------------------------------------------
// Batch content goes through stdin (attachments with -f hang headless runs). Each call
// gets its own empty working directory: concurrent runs in one folder block each other,
// and running inside the project makes opencode scan it.
const OPENCODE = process.env.OPENCODE_BIN ?? "C:/Users/VLADIM~1/AppData/Local/Temp/oc-cli2/node_modules/.bin/opencode.cmd";
const OC_ROOT = "C:/Users/Public/astro-dataset-oc";
let ocSlot = 0;

export function cloud(stdinText, { model = "opencode/big-pickle", timeoutMs = Number(process.env.CLOUD_TIMEOUT_MS ?? 180000) } = {}) {
  const cwd = join(OC_ROOT, `w${ocSlot++ % 16}`);
  ensureDir(cwd);
  return new Promise((resolve, reject) => {
    const p = spawn(OPENCODE, ["run", "-m", model, "\"Do not use any tools. Follow the TASK instructions given on stdin exactly.\""], { cwd, shell: true, windowsHide: true, env: { ...process.env, PWD: cwd, INIT_CWD: cwd } });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      // shell:true means p is cmd.exe; kill the whole tree or opencode.exe is orphaned.
      spawn("taskkill", ["/PID", String(p.pid), "/T", "/F"], { windowsHide: true });
      reject(new Error(`${model} timeout`));
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      out = out.replace(/\x1b\[[0-9;]*m/g, "").replace(/^[\s\S]*?> build · [^\n]*\n/, "");
      code === 0 && out.trim() ? resolve(out) : reject(new Error(`${model} exit ${code}: ${(err || out).slice(-300)}`));
    });
    p.stdin.end(stdinText);
  });
}

/** Try models in order until one returns output that `parse` accepts (non-null). */
// A model that fails (rate limit, timeout) cools down for a while so later batches skip it.
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 10 * 60 * 1000);
const coolingUntil = new Map();
export const isCooling = (m) => (coolingUntil.get(m) ?? 0) > Date.now();

/**
 * Strong cloud models only. Skips models that are cooling down. If every model is cooling:
 *  - local !== false: run the prompt on the local Qwen3-Coder-30B MoE right away;
 *  - local === false: wait for a cloud model to recover (used where independence matters).
 */
export async function cloudWithFallback(stdinText, models, parse, { local = true, maxRounds = 40 } = {}) {
  let lastErr;
  for (let round = 0; round < maxRounds; round++) {
    for (const model of models.filter((m) => !isCooling(m))) {
      try {
        const parsed = parse(await cloud(stdinText, { model }));
        if (parsed) return { parsed, model };
        lastErr = new Error(`${model}: unparseable output`);
      } catch (e) {
        lastErr = e;
        coolingUntil.set(model, Date.now() + COOLDOWN_MS);
      }
    }
    if (local && process.env.LOCAL_FALLBACK !== "0") {
      try {
        const parsed = parse(await chat([{ role: "user", content: stdinText }], { model: MODELS.fast, temperature: 0.3, maxTokens: 4000 }));
        if (parsed) return { parsed, model: `local/${MODELS.fast}` };
      } catch (e) {
        lastErr = e;
      }
    }
    if (round === maxRounds - 1) break;
    const next = Math.min(...models.map((m) => coolingUntil.get(m) ?? 0));
    await sleep(Math.max(30000, Math.min(next - Date.now(), COOLDOWN_MS)));
  }
  throw lastErr;
}

/** Split "=====TAG n=====" sections into {n: text}. */
export function splitSections(text, tag) {
  const out = {};
  const rx = new RegExp(`=====${tag} (\\d+)=====\\s*\\n([\\s\\S]*?)(?=\\n=====${tag} \\d+=====|$)`, "g");
  for (const m of text.matchAll(rx)) out[Number(m[1])] = m[2].trim();
  return out;
}

export async function embed(texts) {
  const r = await fetch(`${LMS}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODELS.embed, input: texts }),
  });
  if (!r.ok) throw new Error(`embed ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).data.map((d) => d.embedding);
}

/** Extract the first JSON array/object from model output. Returns null if none parses. */
export function parseJsonLoose(s) {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  for (const [open, close] of [["[", "]"], ["{", "}"]]) {
    const a = body.indexOf(open);
    const b = body.lastIndexOf(close);
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(body.slice(a, b + 1));
      } catch {}
    }
  }
  return null;
}

export function progress(label, done, total, t0) {
  const el = (Date.now() - t0) / 1000;
  const rate = done / Math.max(el, 1);
  const eta = rate > 0 ? (total - done) / rate : 0;
  const tps = stats.ms ? (stats.tokens / (stats.ms / 1000)).toFixed(0) : "-";
  console.log(`[${label}] ${done}/${total}  ${(el / 60).toFixed(1)}m elapsed  eta ${(eta / 60).toFixed(0)}m  per-call tok/s ${tps}`);
}

/** Free OpenCode cloud models, rotated per batch to stay under per-model rate limits. */
/** Strong free models only (nemotron-3.5-lightning and local 7B are excluded from generation and judging). */
export const FREE_MODELS = (process.env.FREE_MODELS ??
  "opencode/nemotron-3-ultra-free,opencode/longcat-2.5-preview-free,opencode/big-pickle,opencode/mimo-v2.6-flash-free").split(",");
export const rotate = (list, i) => [...list.slice(i % list.length), ...list.slice(0, i % list.length)];

/** Atomic job claim shared by parallel workers (cloud + local). Returns false if already taken. */
/** Release a claim so another run or worker can take the job again. */
export function unclaim(kind, key) {
  rmSync(join(WORK, "claims", kind, hash(key, 16)), { force: true });
}

export function claim(kind, key) {
  const dir = ensureDir(join(WORK, "claims", kind));
  try {
    closeSync(openSync(join(dir, hash(key, 16)), "wx"));
    return true;
  } catch {
    return false;
  }
}

/** Questions that passed the question review (02b), with the reviewer's improved wording applied. */
export function loadKeptQuestions() {
  const review = new Map(readJsonl(join(WORK, "qreview.jsonl")).map((r) => [r.id, r]));
  return readJsonl(join(WORK, "questions.jsonl"))
    .filter((q) => review.get(q.id)?.keep)
    .map((q) => ({ ...q, question: review.get(q.id).question ?? q.question, reviewer: review.get(q.id).reviewer }));
}

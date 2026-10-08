// Stage 5: type-check answer code blocks against real Astro 7.3.5 types (astro check in WSL).
// Snippets are often partial, so only errors that indicate a HALLUCINATED API are hard
// failures: unknown exports/modules, unknown members on Astro types, unknown config keys.
// Output: work/codecheck.jsonl  { id, hard: [...], soft: n }
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { WORK, readJsonl, writeJsonl } from "./lib.mjs";

const XFER = "C:/Users/Public/astro-dataset-check"; // no spaces: WSL sees it as /mnt/c/Users/Public/...
const WSL_XFER = "/mnt/c/Users/Public/astro-dataset-check";
const BATCH = 150;
mkdirSync(XFER, { recursive: true });
writeFileSync(join(XFER, "wsl-check.mjs"), readFileSync(new URL("./wsl-check.mjs", import.meta.url)));

const checks = new Map(readJsonl(process.env.CHECKS ?? join(WORK, "checks.jsonl")).map((c) => [c.id, c]));
const answers = readJsonl(process.env.ANSWERS ?? join(WORK, "answers.jsonl")).filter((a) => checks.get(a.id) && !checks.get(a.id).hard.length);
const done = new Map(readJsonl((process.env.CODECHECK ?? join(WORK, "codecheck.jsonl"))).map((r) => [r.id, r]));

const snippets = [];
for (const a of answers) {
  if (done.has(a.id)) continue;
  let n = 0;
  for (const m of a.answer.matchAll(/```(\w*)\n([\s\S]*?)```/g)) {
    const lang = m[1].toLowerCase();
    const body = m[2];
    if (!/import |define\w+\(|Astro\.|^---/m.test(body)) continue; // nothing API-shaped to check
    let ext;
    if (lang === "astro" || /^---\s*$/m.test(body.split("\n")[0])) ext = "astro";
    else if (["ts", "typescript", "js", "javascript", "mjs", "mts"].includes(lang)) ext = "ts";
    else continue; // jsx/tsx/vue/svelte/shell are not checked
    snippets.push({ id: a.id, file: `s_${a.id}_${n++}.${ext}`, content: body });
  }
  if (n === 0) done.set(a.id, { id: a.id, hard: [], soft: 0, checked: 0 });
}

const HALLUCINATION = (e) =>
  [2305, 2724, 2614].includes(e.code) ||
  (e.code === 2307 && /['"](astro($|[:/])|@astrojs\/)/.test(e.msg)) ||
  (e.code === 2339 && /Astro(Global|Cookies|Session|Props)|APIContext|ActionAPIContext|MiddlewareHandler|ImageMetadata/.test(e.msg)) ||
  ([2353, 2561].includes(e.code) && /Astro|Collection|Action|Integration|Image|Adapter|Loader|Session|Font|I18n|Route|Cache|Logger/.test(e.msg));

console.log(`[codecheck] answers=${answers.length} snippets=${snippets.length}`);
for (let i = 0; i < snippets.length; i += BATCH) {
  const batch = snippets.slice(i, i + BATCH);
  const name = `batch-${i / BATCH}.json`;
  writeFileSync(join(XFER, name), JSON.stringify(batch.map(({ file, content }) => ({ file, content }))));
  const r = spawnSync("wsl", ["-d", "Ubuntu", "--cd", "~", "--", "bash", "-lc", `~/.node22/bin/node ${WSL_XFER}/wsl-check.mjs ${WSL_XFER}/${name}`], { encoding: "utf8" });
  const outFile = join(XFER, name + ".out.json");
  if (!existsSync(outFile)) {
    console.error(`[codecheck] batch ${name} failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
    continue;
  }
  const res = JSON.parse(readFileSync(outFile, "utf8"));
  for (const s of batch) {
    const errs = res[s.file] ?? [];
    const row = done.get(s.id) ?? { id: s.id, hard: [], soft: 0, checked: 0 };
    row.checked++;
    for (const e of errs) {
      if (HALLUCINATION(e)) row.hard.push(`ts${e.code}: ${e.msg.slice(0, 160)}`);
      else row.soft++;
    }
    done.set(s.id, row);
  }
  writeJsonl((process.env.CODECHECK ?? join(WORK, "codecheck.jsonl")), [...done.values()]);
  console.log(`[codecheck] ${Math.min(i + BATCH, snippets.length)}/${snippets.length}  ${(r.stdout || "").trim()}`);
}
writeJsonl((process.env.CODECHECK ?? join(WORK, "codecheck.jsonl")), [...done.values()]);
const rows = [...done.values()];
console.log(`[codecheck] done: answers=${rows.length} hallucination-rejects=${rows.filter((r) => r.hard.length).length}`);

// Runs INSIDE WSL (Node 22) against ~/astro7-harness (Astro 7.3.5 + official integrations).
// Usage: node wsl-check.mjs <batch.json>  → writes <batch.json>.out.json
// batch: [{ file: "s_<id>_<n>.astro|ts", content }]
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const batchPath = process.argv[2];
const H = join(homedir(), "astro7-harness");
const SNIP = join(H, "src", "snip");
const batch = JSON.parse(readFileSync(batchPath, "utf8"));

rmSync(SNIP, { recursive: true, force: true });
mkdirSync(SNIP, { recursive: true });
for (const s of batch) writeFileSync(join(SNIP, s.file), s.content);

let out = "";
try {
  out = execFileSync(join(homedir(), ".node22", "bin", "npx"), ["astro", "check"], {
    cwd: H,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${join(homedir(), ".node22", "bin")}:${process.env.PATH}`, FORCE_COLOR: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout ?? "") + (e.stderr ?? ""); // astro check exits 1 when it finds errors
}
out = out.replace(/\x1b\[[0-9;]*m/g, "");

const results = {};
for (const s of batch) results[s.file] = [];
for (const m of out.matchAll(/^src\/snip\/([^:\n]+):(\d+):(\d+) - error ts\((\d+)\): (.*)$/gm)) {
  (results[m[1]] ??= []).push({ code: Number(m[4]), line: Number(m[2]), msg: m[5].slice(0, 300) });
}
writeFileSync(batchPath + ".out.json", JSON.stringify(results));
rmSync(SNIP, { recursive: true, force: true });
console.log(`checked ${batch.length} snippets, ${Object.values(results).filter((r) => r.length).length} with errors`);

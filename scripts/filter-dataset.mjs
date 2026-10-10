// Drop examples that fail validate.mjs's content rules (same regexes). Rewrites dataset.jsonl and dataset.meta.jsonl.
import { readFileSync, writeFileSync } from "node:fs";
const RULES = [
  [/\b(dataset|training (data|example)|fine-?tun)/i, "references the dataset/generation process"],
  [/\bINSUFFICIENT\b|```\s*$(?![\s\S]*```)/, "generation artifact"],
];
const rows = readFileSync("dataset.jsonl", "utf8").trim().split("\n").map(JSON.parse);
const meta = readFileSync("dataset.meta.jsonl", "utf8").trim().split("\n").map(JSON.parse);
const bad = new Set();
const why = {};
for (const r of rows) {
  const text = r.messages[1].content;
  const links = [...text.matchAll(/https?:\/\/[^\s)>\]"'`]+/g)].length;
  for (const [rx, label] of RULES) if (rx.test(text)) { bad.add(r.id); why[label] = (why[label] ?? 0) + 1; }
  if (links > 1) { bad.add(r.id); why["more than one link"] = (why["more than one link"] ?? 0) + 1; }
}
const keep = rows.filter(r => !bad.has(r.id));
const keepMeta = meta.filter(m => !bad.has(m.id));
writeFileSync("dataset.jsonl", keep.map(r => JSON.stringify(r)).join("\n") + "\n");
writeFileSync("dataset.meta.jsonl", keepMeta.map(m => JSON.stringify(m)).join("\n") + "\n");
console.log("dropped", bad.size, why, "kept", keep.length);

// Manual question review, working backwards from the end of the pool while 02b works forwards.
//   node scripts/02c-manual-qreview.mjs dump [N]   print the last N unreviewed questions as "k|type|difficulty|question"
//   node scripts/02c-manual-qreview.mjs apply < decisions
// Decisions, one per line, for the questions in the last dump; any question not mentioned is kept:
//   <k> d <reason>        drop
//   <k> i <new wording>   keep with improved wording
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { WORK, readJsonl, appendJsonl } from "./lib.mjs";

const OUT = join(WORK, "qreview.jsonl");
const LAST = join(WORK, "manual-qreview-last.json");
const REVIEWER = "manual/claude-opus-5-5";
const reviewed = () => new Set(readJsonl(OUT).map((r) => r.id));

const [cmd, arg] = process.argv.slice(2);
if (cmd === "dump") {
  const done = reviewed();
  const todo = readJsonl(join(WORK, "questions.jsonl")).filter((q) => !done.has(q.id));
  const slice = todo.slice(-Number(arg ?? 150));
  writeFileSync(LAST, JSON.stringify(slice.map((q) => q.id)));
  console.log(`unreviewed=${todo.length}`);
  slice.forEach((q, k) => console.log(`${k + 1}|${q.type}|${q.difficulty[0]}|${q.question}`));
} else if (cmd === "apply") {
  const ids = JSON.parse(readFileSync(LAST, "utf8"));
  const dec = new Map();
  for (const line of readFileSync(0, "utf8").split("\n")) {
    const m = line.trim().match(/^(\d+)\s+([di])\s+(.+)$/);
    if (m) dec.set(Number(m[1]), { kind: m[2], text: m[3].trim() });
  }
  const done = reviewed();
  let kept = 0, dropped = 0, skipped = 0;
  ids.forEach((id, i) => {
    if (done.has(id)) return skipped++;
    const d = dec.get(i + 1);
    if (d?.kind === "d") {
      dropped++;
      appendJsonl(OUT, { id, keep: false, reason: d.text.slice(0, 120), reviewer: REVIEWER });
    } else {
      kept++;
      appendJsonl(OUT, { id, keep: true, reason: "manual keep", question: d?.kind === "i" ? d.text : undefined, reviewer: REVIEWER });
    }
  });
  console.log(`kept=${kept} dropped=${dropped} skipped(already reviewed)=${skipped}`);
} else {
  console.error("usage: dump [N] | apply < decisions");
  process.exit(1);
}

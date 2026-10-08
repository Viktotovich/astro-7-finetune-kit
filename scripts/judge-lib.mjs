// Judge prompt + one-batch judging call, shared by stage 6 and the refine loop (06c).
import { ASTRO_VERSION, astroSearch, parseJsonLoose, cloudWithFallback, rotate, appendJsonl } from "./lib.mjs";

const major = ASTRO_VERSION.split(".")[0];
export const JUDGE_INSTRUCTIONS = `You are a senior Astro ${major} reviewer (Astro ${ASTRO_VERSION}, Vite 8, Node 22+). Review each Q/A ITEM below for a fine-tuning dataset.
Reply with ONLY a JSON array, one object per item, no prose:
{"i": <item number>, "verdict": "pass" | "fix" | "reject", "accuracy": 1-5, "version": 1-5, "usefulness": 1-5, "concise": 1-5, "issues": "<short>", "fixed_answer": "<only when verdict is fix>"}
Judge against the item's CONTEXT (current Astro docs / web spec excerpts) and your knowledge of Astro ${major}:
- accuracy: every claim, API, import, option, CLI flag must be correct for Astro ${major}. Anything invented or from an older Astro version (unless the question is explicitly about migration) → fix or reject.
- version: no removed/deprecated APIs presented as current (e.g. Astro.glob, output:'hybrid', <ViewTransitions />, legacy content collections, entry.render(), z from astro:content, @astrojs/db).
- usefulness: a realistic developer question with real training value. Trivia, vague, or near-duplicate-of-docs-heading questions → reject.
- concise: documentation-style, direct first sentence, no filler; at most one link and only if it helps.
Use "fix" when the question is good and the answer is fixable: then fixed_answer must be the complete corrected answer (same style rules, current syntax, correct imports, at most one link copied from the item's CONTEXT URLs, no mention of context/docs provided). Use "reject" when the question itself is bad or unanswerable from the context.`;

/**
 * Judge items [{ id, question, answer, sources, model }] with one cloud call by a model other than the writer.
 * Returns verdict rows { id, verdict, accuracy, version, usefulness, concise, issues, fixed_answer, judge }.
 */
export async function judgeBatch(items, models, bi = 0) {
  let doc = "";
  for (const [i, a] of items.entries()) {
    const ctx = (await astroSearch(a.question)).slice(0, 3).map((c) => `<<${c.url}>>\n${c.content}`).join("\n\n").slice(0, 3500);
    doc += `

===== ITEM ${i + 1} =====
QUESTION:
${a.question}

ANSWER:
${a.answer}

CONTEXT URLS: ${(a.sources ?? []).join(" ")}
CONTEXT:
${ctx}
`;
  }
  const writer = String(items[0].model ?? "");
  const { parsed, model } = await cloudWithFallback(
    `TASK:
${JUDGE_INSTRUCTIONS}
${doc}`,
    rotate(models.filter((m) => m !== writer), bi),
    (t) => {
      const a = parseJsonLoose(t);
      return Array.isArray(a) && a.length ? a : null;
    },
    { local: !writer.startsWith("local/") }, // never let the local model judge its own answers
  );
  const rows = [];
  for (const r of parsed) {
    const a = items[Number(r.i) - 1];
    if (!a || !["pass", "fix", "reject"].includes(r.verdict)) continue;
    rows.push({
      id: a.id,
      verdict: r.verdict,
      accuracy: +r.accuracy || 0,
      version: +r.version || 0,
      usefulness: +r.usefulness || 0,
      concise: +r.concise || 0,
      issues: String(r.issues ?? "").slice(0, 400),
      fixed_answer: r.verdict === "fix" ? String(r.fixed_answer ?? "") : undefined,
      judge: model,
    });
  }
  return rows;
}

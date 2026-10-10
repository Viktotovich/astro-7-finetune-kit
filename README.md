# astro-dataset (v0.1, partial)

Question-and-answer pairs about Astro 7 (7.3.5), grounded in the Astro docs and the Web Specifications, for fine-tuning a small model as a Q&A helper.

**Status: v0.1 snapshot, 1,467 examples. The target is 3,500, so this is not the final dataset.** The validator is expected to fail on the count until the target is reached.

## Files

- `dataset.jsonl`: one `{id, messages: [user, assistant]}` per line.
- `dataset.meta.jsonl`: per-example metadata, joined by `id` (area, difficulty, source page, model that wrote the answer, judge scores).
- `metadata.json`: dataset-level counts.
- `scripts/`: the pipeline. `run-pipeline.sh` runs the stages in order.

## How examples were made

1. Questions generated from Astro docs and spec excerpts, then reviewed (keep/drop).
2. Answers written from the same excerpts by a local model (Qwen3-Coder-30B) or free cloud models.
3. Deterministic checks: stale APIs, invented identifiers, link rules, forbidden phrases.
4. `astro check` on code blocks against Astro 7 types.
5. Independent judge scores (accuracy, version, usefulness, concision). A model never judges its own answers. 427 judge verdicts were written by hand.
6. Semantic de-duplication (cosine > 0.9) and content rules (no generation artifacts, at most one link, no references to the dataset itself).

## Known limits

- Some judge verdicts come from a local model that was prone to over-passing. Those rows are tagged `local/...` in the pipeline data.
- Answers from free cloud models were used. Their terms on training with outputs are not confirmed.
- No human review of the full set. Spot checks only.
- Difficulty and area balance are not yet at target.

## Licenses

- Code: Apache-2.0 (`LICENSE`).
- Data: CC BY 4.0 (`DATA-LICENSE`). Upstream notices in `NOTICE`.

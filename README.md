# astro-7-finetune-kit

Q&A dataset and pipeline for fine-tuning a small language model on Astro 7 (Astro 7.3.5). The goal is a dataset of 3,500 grounded question/answer pairs, with a GGUF release of the resulting model.

**Status: work in progress.** `data/` is a snapshot of the pipeline as it stood on 2026-10-08. It is not the final dataset. The judge stage is incomplete, the feedback (refine) loop and the selection step have not run, and `dataset.jsonl` does not exist yet.

## Layout

- `data/` - pipeline outputs: questions, question review, answers, deterministic checks, `astro check` results, judge verdicts, refine rows, and a review sample.
- `scripts/` - pipeline stages (`run-pipeline.sh` runs them in order) and shared libraries.
- `sources/` - inventory of the Astro docs pages, stale-API rules, version info, and the manual review log.
- `RESUME.md` - run notes and how to resume a stopped run.

## Not included

- The raw Astro docs and Website Specification text used as grounding. Both can be re-fetched from the docs and specification MCP servers.
- Intermediate work files (claims, caches).

## Licenses

- Code (`scripts/`, the release kit): Apache-2.0, see `LICENSE`.
- Data (`data/`): CC BY 4.0, see `DATA-LICENSE`. Upstream notices are listed in `NOTICE`.
- Model weights: the license of the base model they are trained from.

**Open question before any public release:** several answers were written by free OpenCode-hosted models. The OpenCode privacy page names Big Pickle, MiMo-V2.6-Flash and Nemotron 3 Ultra as models whose collected data may be used to improve the model during the free period. The terms for using model outputs are not confirmed. Keep this repository private until that is resolved.

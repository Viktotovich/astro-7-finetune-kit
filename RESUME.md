# Resuming the pipeline

Stopped cleanly on 2026-10-06 at 02:31. State at shutdown:

| Stage | Done |
|---|---|
| 01 collect (Astro MCP corpus, Spec MCP topics) | complete: 422 pages, 1,613 chunks, 169 spec topics |
| 02 questions | 5,060 of ~6,100 candidates |
| 02b question review → 07 select | not started |

Every stage is resumable: re-running continues from the files in `work/`. Data files were checked
for partial lines at shutdown, and the job-claim folder was cleared. Completed work lives in the
output files, so nothing is lost or repeated.

## Restart

1. **LM Studio** (CUDA engine, not Vulkan; the Vulkan engine is about 4x slower on this GPU):

   ```bash
   ~/.lmstudio/bin/lms.exe runtime select llama.cpp-win-x86_64-nvidia-cuda12-avx2@2.41.0
   ~/.lmstudio/bin/lms.exe server start --port 1234
   ~/.lmstudio/bin/lms.exe load "qwen3-coder-30b-a3b-instruct@q3_k_xl" --context-length 16384 --parallel 1 --identifier "qwen3-coder-30b-a3b-instruct@q3_k_xl" -y
   ~/.lmstudio/bin/lms.exe load text-embedding-nomic-embed-text-v1.5 -y
   ```

   Close Firefox and other heavy apps first: the 30B MoE leaves very little free RAM.

2. **WSL** must be available (`wsl -d Ubuntu`). The Astro 7.3.5 type-check harness lives in `~/astro7-harness` with Node 22 in `~/.node22`.

3. **OpenCode CLI 1.18.34** is expected at `%TEMP%\oc-cli2`. If Windows cleared the temp folder, reinstall it:

   ```bash
   npm install --prefix "$(cygpath -w "$TMP")\\oc-cli2" opencode-ai@1.18.34
   ```

4. **Start the cloud pipeline and the local worker** from this folder:

   ```bash
   nohup bash scripts/run-pipeline.sh >> work/pipeline.log 2>&1 &
   nohup bash scripts/local-worker.sh > work/local-worker.log 2>&1 &
   ```

5. **Check progress:**

   ```bash
   for f in questions qreview answers checks codecheck judge; do printf "%s=%s " $f $(cat work/$f.jsonl 2>/dev/null | wc -l); done
   ```

## Remaining after the pipeline

- Manual adversarial review of samples from every area; corrections go in `sources/manual-review.jsonl`.
- `README.md` (target version, method, schema, coverage, Unsloth usage).
- `node scripts/validate.mjs` must pass with exactly 3,500 examples.

## Round 2 questions (started 2026-10-06)

Round 1 kept only 2,646 of ~6,000 candidates, too few for 3,500 after answer and judge gates.
Round 2 adds about 4,300 candidates from the core areas, using cloud models only (resumable):

    ROUND=2 EXTRA=1 LOCAL_FALLBACK=0 CONC=3 AREAS=guides,reference,api-modules,basics,integrations,recipes,tutorial,backend,experimental,migrate-from,upgrade,spec:performance,spec:security,spec:accessibility,spec:i18n,spec:seo,spec:foundations,spec:resilience nohup node scripts/02-questions.mjs > work/questions-r2.log 2>&1 &

Then review them: `node scripts/02c-manual-qreview.mjs dump 150` / `apply` (manual, from the end) alongside
`node scripts/02b-qreview.mjs` (models, from the start). Both skip anything already reviewed. Then rerun from answers:
`FROM=qreview nohup bash scripts/run-pipeline.sh >> work/pipeline.log 2>&1 &`.

## Refine loop (stage 6c, added 2026-10-06)

Failed answers are not dropped. `scripts/06c-refine.mjs` (run by run-pipeline.sh after the fixed-answer
recheck) rewrites every answer that is INSUFFICIENT, fails a hard check or astro check, or is rejected /
low-scored by the judge. The writer gets the exact reasons and a wider context; the rewrite is re-checked,
type-checked and judged by a different model, up to 4 rounds (`MAX_ROUNDS`). A judge "fix" is re-verified.
Questions the judge rates as low-value twice are given up (a better answer cannot fix a bad question).
State: work/refine.jsonl (last row per id). Shared pieces: check-lib.mjs, judge-lib.mjs, answer-lib.mjs.

## Note (2026-10-07): judge/refine run cloud-only
Local Qwen as judge fallback stalls the judge (8-item judge prompts are far too slow locally, and Qwen is
busy answering). Run judge onward with `LOCAL_FALLBACK=0`; give Qwen the answer work instead
(`BACKEND=local CONC=2 node scripts/03-answers.mjs`, one worker only, after releasing 'a' claims).
Tried a local Qwen judge (scripts/06-judge-local.mjs) during a cloud outage: it gave 5/5 pass to everything, so its verdicts were removed. The judge stays cloud-only; if the free tier is down, wait.

## Paused 2026-10-08 01:16 (user)
State: 3,117 kept questions all answered, checked and astro-checked; judge at 960 rows (1,706 to judge
when it stopped). Free cloud models were rate-limited from ~15:00 on 2026-10-07. Round-2 generation is
paused (116 new questions made, 111 manually reviewed, 74 kept and answered). To resume:
1. Load Qwen: `lms load qwen3-coder-30b-a3b-instruct --identifier qwen3-coder-30b-a3b-instruct@q3_k_xl --context-length 16384 --parallel 2 -y`
   and `lms server start --port 1234` (only needed for local answering; the judge/refine run cloud-only).
2. `LOCAL_FALLBACK=0 FROM=judge CONC=4 ANSWER_BATCH=4 CLOUD_TIMEOUT_MS=300000 COOLDOWN_MS=240000 nohup bash scripts/run-pipeline.sh >> work/pipeline.log 2>&1 &`
   (add JUDGE_CONC=2 if the free tier is still throttled).

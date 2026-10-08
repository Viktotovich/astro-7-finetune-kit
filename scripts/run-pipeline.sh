#!/usr/bin/env bash
# Unattended pipeline after 01-collect. Every stage is resumable; re-running continues.
# Needs LM Studio with qwen3-coder-30b-a3b-instruct + text-embedding-nomic-embed-text-v1.5,
# WSL Ubuntu with ~/astro7-harness, and the OpenCode CLI (free cloud models).
set -euo pipefail
cd "$(dirname "$0")/.."
log() { echo "[$(date +%H:%M:%S)] $*"; }
# FROM=<stage> skips the stages before it (e.g. FROM=answers after a restart).
skip() { [ -n "${FROM:-}" ] && [ "$1" != "$FROM" ] && return 0; FROM=; return 1; }

skip questions || { log "questions";  CONC=${CONC:-4} node scripts/02-questions.mjs; }
skip qreview   || { log "qreview";    node scripts/02b-qreview.mjs; }
skip answers   || { log "answers";    CONC=${CONC:-4} node scripts/03-answers.mjs; }
skip checks    || { log "checks";     node scripts/04-checks.mjs; }
skip codecheck || { log "codecheck";  node scripts/05-codecheck.mjs; }
skip judge     || { log "judge";      node scripts/06-judge.mjs; }
skip fixed     || { log "fixed";      node scripts/06b-fixed.mjs; }
skip recheck   || { log "recheck fixed"
  ANSWERS=work/fixed-answers.jsonl CHECKS=work/checks-fixed.jsonl node scripts/04-checks.mjs
  ANSWERS=work/fixed-answers.jsonl CHECKS=work/checks-fixed.jsonl CODECHECK=work/codecheck-fixed.jsonl node scripts/05-codecheck.mjs; }
skip refine    || { log "refine";     node scripts/06c-refine.mjs; }
skip select    || { log "select";     node scripts/07-select.mjs; }
log "validate";   node scripts/validate.mjs
log "done"

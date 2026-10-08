#!/usr/bin/env bash
# Keeps the local Qwen3-Coder-30B MoE busy alongside run-pipeline.sh (cloud), taking jobs
# from the other end of the queue. Atomic claims prevent duplicate work.
set -uo pipefail
cd "$(dirname "$0")/.."
BACKEND=local REVERSE=1 CONC=1 node scripts/02-questions.mjs
until grep -q "] answers" work/pipeline.log; do sleep 60; done
sleep 30
BACKEND=local REVERSE=1 CONC=1 node scripts/03-answers.mjs

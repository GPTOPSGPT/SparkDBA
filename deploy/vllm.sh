#!/usr/bin/env bash
# Nemotron 3.5 Lightning NVFP4 on 1x DGX Spark (recipe from the model README), localhost only.
# VLLM_VENV: a Python env with vllm 0.28; NEMOTRON_DIR: the downloaded checkpoint (both in $SPARKDBA_HOME/.env).
set -a; . "${SPARKDBA_HOME:-/opt/sparkdba}/.env"; set +a
source "${VLLM_VENV:?set VLLM_VENV to the vllm env}/bin/activate"
exec vllm serve "${NEMOTRON_DIR:?set NEMOTRON_DIR to the checkpoint}" \
  --served-model-name nemotron \
  --host 127.0.0.1 --port 8000 \
  --max-model-len 65536 \
  --moe-backend marlin --kv-cache-dtype fp8 --enable-prefix-caching \
  --gpu-memory-utilization 0.60 \
  --mamba-backend flashinfer --mamba-cache-mode align \
  --reasoning-parser nemotron_v3 --tool-call-parser qwen3_coder --enable-auto-tool-choice

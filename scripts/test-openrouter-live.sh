#!/usr/bin/env bash
# scripts/test-openrouter-live.sh — Lapis B live via MiniRoutingAI gateway
# Prasyarat: gateway sudah running di http://localhost:3000, OPENROUTER_API_KEY di .env
set -e
BASE="http://localhost:3000"
echo "=== Cek debug/routes (harus ada providers & reasoning) ==="
curl -s $BASE/debug/routes | jq '.routes.balanced.fallbacks[] | select(.provider=="openrouter")'

echo ""
echo "=== T-01 deepseek non-stream via gateway ==="
curl -s $BASE/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash-0731","messages":[{"role":"user","content":"How many r are in strawberry? Answer in one sentence."}],"max_tokens":64}' | jq '.choices[0].message.content, .model, .usage'

echo ""
echo "=== T-02 z-ai non-stream via gateway ==="
curl -s $BASE/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"z-ai/glm-5.3-flash","messages":[{"role":"user","content":"How many r are in strawberry? Answer in one sentence."}],"max_tokens":64}' | jq '.choices[0].message.content, .model, .usage'

echo ""
echo "=== T-03 deepseek stream ==="
curl -N -s $BASE/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash-0731","messages":[{"role":"user","content":"How many r are in strawberry?"}],"stream":true}' | head -n 20

echo ""
echo "=== T-04 z-ai stream ==="
curl -N -s $BASE/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"z-ai/glm-5.3-flash","messages":[{"role":"user","content":"How many r are in strawberry?"}],"stream":true}' | head -n 20

echo ""
echo "=== T-06 negatif nvidia (tidak pin) ==="
curl -s $BASE/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"nvidia/nemotron-3-ultra-550b-a55b","messages":[{"role":"user","content":"hi"}],"max_tokens":16}' | jq '.model, .choices[0].message.content' | head -n 5

echo ""
echo "=== Metrics ==="
curl -s $BASE/metrics | jq '.totalRequests, .perProvider' | head -n 30

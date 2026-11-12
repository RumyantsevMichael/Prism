#!/bin/bash
# Probe: one Codex exec run against the scripted Responses API (fake-responses.mjs), never a real model. Set CODEX_BIN to the Codex under test and MCPEXTRA to an env_vars line.
# Examples: ./run-codex.sh cx "[]" gpt-5.1-codex exec --json --approve-for-me hello, then read the rollout turn_context under w-cx/codex-home/sessions.
# usage: run-codex.sh NAME PLAN MODEL -- codex args (run in w-NAME/proj, reusing CODEX_HOME if present)
P=$(cd "$(dirname "$0")" && pwd); cd "$P"
NAME=$1; PLAN=$2; MODEL=$3; shift 3
D=$PWD/w-$NAME; mkdir -p $D/home $D/codex-home $D/proj; [ -d $D/proj/.git ] || (cd $D/proj && git init -q)
C=${CODEX_BIN:-codex}
PORT=$((20000 + RANDOM % 20000))
PLAN="$PLAN" LOG=$D/api.log PORT=$PORT node fake-responses.mjs > $D/fake.out 2>&1 & FAKE=$!; sleep 0.5
printf 'model = "%s"\nopenai_base_url = "http://127.0.0.1:%s/v1"\n' "$MODEL" $PORT > $D/codex-home/config.toml
cat >> $D/codex-home/config.toml <<T
[mcp_servers.envprobe]
command = "node"
args = ["$P/env-mcp.mjs"]
env = { ENV_OUT = "$D/mcp-env.json" }
$MCPEXTRA
T
E="env -i PATH=$PATH HOME=$D/home CODEX_HOME=$D/codex-home NO_PROXY=127.0.0.1 no_proxy=127.0.0.1 PRISM_LAUNCH=launch-probe"
echo sk-probe | $E $C login --with-api-key >/dev/null 2>&1
cd $D/proj; $E timeout 90 $C "$@" < /dev/null > $D/out-$NAME.jsonl 2> $D/err.txt; echo "exit=$?"
kill $FAKE

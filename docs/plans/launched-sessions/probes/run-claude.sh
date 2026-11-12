#!/bin/bash
# Probe: one Claude Code print-mode run against the scripted Messages API (fake-messages.mjs), never a real model; PLAN lists the tool calls the scripted model makes.
# Example: ./run-claude.sh auto "$PLAN" -p hello --session-id <uuid> --output-format stream-json --verbose --permission-mode auto --permission-prompts none
# usage: run-claude.sh NAME PLAN_JSON -- claude args...
P=$(cd "$(dirname "$0")" && pwd); cd "$P"
NAME=$1; PLAN=$2; shift 2
D=$PWD/w-$NAME; rm -rf $D; mkdir -p $D/home $D/config $D/proj $D/app
( cd $D/proj && git init -q && git commit -q --allow-empty -m init -c user.name=x -c user.email=x@x 2>/dev/null || git -c user.name=x -c user.email=x@x commit -q --allow-empty -m init )
PORT=$((20000 + RANDOM % 20000))
PLAN="$PLAN" LOG=$D/api.log PORT=$PORT node fake-messages.mjs > $D/fake.out 2>&1 &
FAKE=$!
sleep 0.5
cat > $D/mcp.json <<J
{"mcpServers":{"envprobe":{"command":"node","args":["$PWD/env-mcp.mjs"],"env":{"ENV_OUT":"$D/mcp-env.json"}}}}
J
cd $D/proj
env -i PATH=$PATH HOME=$D/home CLAUDE_CONFIG_DIR=$D/config PRISM_REVIEW_APP_DIR=$D/app PRISM_REVIEW_BROWSER_ON_START=off PRISM_LAUNCH=launch-probe ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT ANTHROPIC_API_KEY=sk-ant-probe NO_PROXY=127.0.0.1 ENABLE_TOOL_SEARCH=false timeout 90 claude "$@" --mcp-config $D/mcp.json < /dev/null > $D/out.jsonl 2> $D/err.txt
echo "exit=$?" > $D/exit.txt
kill $FAKE
cat $D/exit.txt

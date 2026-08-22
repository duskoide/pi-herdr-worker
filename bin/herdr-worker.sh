#!/usr/bin/env bash
# herdr-worker.sh - Spawn a pi agent in a new Herdr tab
#
# Usage: herdr-worker.sh <agent-name> <prompt> [--model <model>] [--thinking <level>] [--timeout <ms>]
#
# Example:
#   herdr-worker.sh pi-test "Run tests and report results"
#   herdr-worker.sh pi-reviewer "Review the code changes" --model gpt-4o
#   herdr-worker.sh pi-builder "Build project" --model claude-sonnet-5 --timeout 180000

set -euo pipefail

# Check Herdr environment
if [[ "${HERDR_ENV:-}" != "1" ]]; then
  echo "Error: Not running in Herdr environment" >&2
  exit 1
fi

# Parse required arguments
AGENT_NAME="${1:?Usage: herdr-worker.sh <agent-name> <prompt> [--model <model>] [--thinking <level>] [--timeout <ms>]}"
PROMPT="${2:?Usage: herdr-worker.sh <agent-name> <prompt> [--model <model>] [--thinking <level>] [--timeout <ms>]}"

# Parse optional arguments. Defaults come from the same portable config used by
# the extension; explicit CLI flags override them.
CONFIG_PATH="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/herdr-worker.json"
MODEL=""
THINKING=""
TIMEOUT=""
if [[ -f "$CONFIG_PATH" ]]; then
  MODEL=$(jq -r '.defaultModel // empty' "$CONFIG_PATH")
  THINKING=$(jq -r '.defaultThinking // empty' "$CONFIG_PATH")
  TIMEOUT=$(jq -r '.defaultTimeout // empty' "$CONFIG_PATH")
fi
TIMEOUT="${TIMEOUT:-120000}"
shift 2 || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      [[ $# -ge 2 ]] || { echo "Error: --model requires a value" >&2; exit 1; }
      MODEL="$2"
      shift 2
      ;;
    --thinking)
      [[ $# -ge 2 ]] || { echo "Error: --thinking requires a value" >&2; exit 1; }
      THINKING="$2"
      case "$THINKING" in
        off|minimal|low|medium|high|xhigh|max) ;;
        *) echo "Error: invalid thinking level: $THINKING" >&2; exit 1 ;;
      esac
      shift 2
      ;;
    --timeout)
      [[ $# -ge 2 ]] || { echo "Error: --timeout requires a value" >&2; exit 1; }
      TIMEOUT="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# Enforce the configured model allowlist when present.
if [[ -n "$MODEL" && -f "$CONFIG_PATH" ]]; then
  if ! jq -e --arg model "$MODEL" '
    (.allowedModels // []) as $allowed |
    ($allowed | length) == 0 or
    any($allowed[]; . == $model or . == ($model | split("/")[-1]) or endswith("/" + ($model | split("/")[-1])))
  ' "$CONFIG_PATH" >/dev/null; then
    echo "Error: model is not allowed by $CONFIG_PATH: $MODEL" >&2
    exit 1
  fi
fi

# Validate agent name (lowercase, hyphens, max 31 chars)
if [[ ! "$AGENT_NAME" =~ ^[a-z][a-z0-9_-]{0,30}$ ]]; then
  echo "Error: Agent name must be lowercase letters, numbers, hyphens; max 31 chars" >&2
  exit 1
fi

# Resolve the calling pane's workspace explicitly. Without --workspace, Herdr
# may create the tab in whichever workspace the UI currently has focused.
CURRENT=$(herdr pane current --current)
WORKSPACE_ID=$(echo "$CURRENT" | jq -r '.result.pane.workspace_id')
if [[ -z "$WORKSPACE_ID" || "$WORKSPACE_ID" == "null" ]]; then
  echo "Error: Could not resolve the calling Herdr workspace" >&2
  exit 1
fi

# Create a dedicated temporary tab in the calling workspace without taking focus.
CREATED=$(herdr tab create --workspace "$WORKSPACE_ID" --cwd "$PWD" --label "$AGENT_NAME" --no-focus)
TAB_ID=$(echo "$CREATED" | jq -r '.result.tab.tab_id')
TAB_WORKSPACE_ID=$(echo "$CREATED" | jq -r '.result.tab.workspace_id')
NEW_PANE_ID=$(echo "$CREATED" | jq -r '.result.root_pane.pane_id')
PANE_WORKSPACE_ID=$(echo "$CREATED" | jq -r '.result.root_pane.workspace_id')

if [[ -z "$TAB_ID" || "$TAB_ID" == "null" || -z "$NEW_PANE_ID" || "$NEW_PANE_ID" == "null" ]]; then
  echo "Error: Could not create new worker tab" >&2
  exit 1
fi
if [[ "$TAB_WORKSPACE_ID" != "$WORKSPACE_ID" || "$PANE_WORKSPACE_ID" != "$WORKSPACE_ID" || "$TAB_ID" != "$WORKSPACE_ID":* || "$NEW_PANE_ID" != "$WORKSPACE_ID":* ]]; then
  herdr tab close "$TAB_ID" >/dev/null 2>&1 || true
  echo "Error: Worker tab escaped calling workspace $WORKSPACE_ID" >&2
  exit 1
fi

# Start pi agent (with optional model and thinking level).
# Use an array so model names cannot be interpreted as shell syntax.
START_ARGS=(agent start "$AGENT_NAME" --kind pi --pane "$NEW_PANE_ID" --)
if [[ -n "$MODEL" ]]; then
  START_ARGS+=(--model "$MODEL")
fi
if [[ -n "$THINKING" ]]; then
  START_ARGS+=(--thinking "$THINKING")
fi

START_RESULT=$(herdr "${START_ARGS[@]}")
AGENT_STATUS=$(echo "$START_RESULT" | jq -r '.result.agent.agent_status')

if [[ "$AGENT_STATUS" == "unknown" ]]; then
  echo "Error: Failed to start agent" >&2
  exit 1
fi

# Send prompt
PROMPT_RESULT=$(herdr agent prompt "$NEW_PANE_ID" "$PROMPT" --wait --timeout "$TIMEOUT")
PROMPT_STATUS=$(echo "$PROMPT_RESULT" | jq -r '.type')

if [[ "$PROMPT_STATUS" != "agent_prompted" ]]; then
  echo "Error: Failed to send prompt" >&2
  exit 1
fi

# Read response
RESPONSE=$(herdr agent read "$NEW_PANE_ID" --source recent-unwrapped --lines 100)

# Output results
cat <<EOF
{
  "workspace_id": "$WORKSPACE_ID",
  "tab_id": "$TAB_ID",
  "pane_id": "$NEW_PANE_ID",
  "agent_name": "$AGENT_NAME",
  "model": "${MODEL:-parent}",
  "thinking": "${THINKING:-parent}",
  "status": "completed",
  "response": $(echo "$RESPONSE" | jq -Rs .)
}
EOF

# Cleanup: close the tab (this also stops the agent).
herdr tab close "$TAB_ID" > /dev/null 2>&1 || true

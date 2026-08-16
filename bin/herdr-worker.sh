#!/usr/bin/env bash
# herdr-worker.sh - Spawn a pi agent in a new Herdr pane
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

# Parse optional arguments
MODEL=""
THINKING=""
TIMEOUT="120000"
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

# Validate agent name (lowercase, hyphens, max 31 chars)
if [[ ! "$AGENT_NAME" =~ ^[a-z][a-z0-9_-]{0,30}$ ]]; then
  echo "Error: Agent name must be lowercase letters, numbers, hyphens; max 31 chars" >&2
  exit 1
fi

# Get current pane context
CURRENT_PANE=$(herdr pane current --current)
PANE_ID=$(echo "$CURRENT_PANE" | jq -r '.result.pane.pane_id')

if [[ -z "$PANE_ID" ]]; then
  echo "Error: Could not get current pane ID" >&2
  exit 1
fi

# Create new pane
NEW_PANE=$(herdr pane split --current --direction right --cwd "$PWD" --no-focus)
NEW_PANE_ID=$(echo "$NEW_PANE" | jq -r '.result.pane.pane_id')

if [[ -z "$NEW_PANE_ID" ]]; then
  echo "Error: Could not create new pane" >&2
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
PROMPT_RESULT=$(herdr agent prompt "$AGENT_NAME" "$PROMPT" --wait --timeout "$TIMEOUT")
PROMPT_STATUS=$(echo "$PROMPT_RESULT" | jq -r '.type')

if [[ "$PROMPT_STATUS" != "agent_prompted" ]]; then
  echo "Error: Failed to send prompt" >&2
  exit 1
fi

# Read response
RESPONSE=$(herdr agent read "$AGENT_NAME" --source recent-unwrapped --lines 100)

# Output results
cat <<EOF
{
  "pane_id": "$NEW_PANE_ID",
  "agent_name": "$AGENT_NAME",
  "model": "${MODEL:-parent}",
  "thinking": "${THINKING:-parent}",
  "status": "completed",
  "response": $(echo "$RESPONSE" | jq -Rs .)
}
EOF

# Cleanup: Close the pane (this also stops the agent)
herdr pane close "$NEW_PANE_ID" > /dev/null 2>&1 || true

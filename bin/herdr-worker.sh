#!/usr/bin/env bash
# herdr-worker.sh - Spawn a pi agent in a new Herdr pane
#
# Usage: herdr-worker.sh <agent-name> <prompt> [--model <model>] [--role <role>] [--thinking <level>] [--timeout <ms>]
#
# The --role flag reads a role definition from .pi/agents/<role>.md (project),
# .agents/agents/<role>.md (workspace), or ~/.pi/agent/agents/<role>.md (global),
# and injects its system prompt (plus optional model/thinking/tools frontmatter).
#
# Example:
#   herdr-worker.sh pi-test "Run tests and report results"
#   herdr-worker.sh pi-reviewer "Review the code changes" --model gpt-4o --role reviewer
#   herdr-worker.sh pi-builder "Build project" --model claude-sonnet-5 --timeout 180000

set -euo pipefail

# Check Herdr environment
if [[ "${HERDR_ENV:-}" != "1" ]]; then
  echo "Error: Not running in Herdr environment" >&2
  exit 1
fi

# Parse required arguments
AGENT_NAME="${1:?Usage: herdr-worker.sh <agent-name> <prompt> [--model <model>] [--role <role>] [--thinking <level>] [--timeout <ms>]}"
PROMPT="${2:?Usage: herdr-worker.sh <agent-name> <prompt> [--model <model>] [--role <role>] [--thinking <level>] [--timeout <ms>]}"

# Parse optional arguments
MODEL=""
ROLE=""
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
    --role)
      [[ $# -ge 2 ]] || { echo "Error: --role requires a value" >&2; exit 1; }
      ROLE="$2"
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

# ---------------------------------------------------------------------------
# Role resolution: load a role file's system prompt and optional frontmatter.
# ---------------------------------------------------------------------------
find_role_file() {
  local role="$1"
  local candidates=(
    "$PWD/.pi/agents/$role.md"
    "$PWD/.agents/agents/$role.md"
    "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/agents/$role.md"
  )
  local c
  for c in "${candidates[@]}"; do
    [[ -f "$c" ]] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

# Extract a frontmatter value by key. YAML is too rich for awk here; this
# handles simple `key: value` and `key: "value"` lines, which covers the
# fields role files actually use for the CLI.
frontmatter_value() {
  local path="$1"
  local key="$2"
  awk -v key="$key" '
    $0 == "---" { in_fm = !in_fm; next }
    in_fm && index($0, key ":") == 1 {
      sub("^" key ":[ ]*", "")
      gsub(/^["'"'"']|["'"'"']$/, "")
      print
      exit
    }
  ' "$path"
}

# Everything after the closing frontmatter fence is the body. If the file has
# no frontmatter, the whole file is the body.
role_body() {
  local path="$1"
  awk '
    NR == 1 && /^---[[:space:]]*$/ { has_fm = 1 }
    has_fm == 1 && /^---[[:space:]]*$/ { fence++; next }
    fence == 1 { next }
    fence >= 2 || (has_fm == 0) { print }
  ' "$path"
}

ROLE_SYSTEM_PROMPT=""
if [[ -n "$ROLE" ]]; then
  ROLE_FILE="$(find_role_file "$ROLE" || true)"
  if [[ -z "$ROLE_FILE" ]]; then
    echo "Error: Role '$ROLE' not found (looked in .pi/agents, .agents/agents, ~/.pi/agent/agents)" >&2
    exit 1
  fi
  ROLE_SYSTEM_PROMPT="$(role_body "$ROLE_FILE")"
  # Role frontmatter supplies defaults only when the matching flag is absent.
  local_role_model="$(frontmatter_value "$ROLE_FILE" model)"
  local_role_thinking="$(frontmatter_value "$ROLE_FILE" thinking)"
  [[ -z "$MODEL" && -n "$local_role_model" ]] && MODEL="$local_role_model"
  [[ -z "$THINKING" && -n "$local_role_thinking" ]] && THINKING="$local_role_thinking"
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

# Start pi agent (with optional model, thinking level, and role system prompt).
# Use an array so model names and prompt text cannot be interpreted as shell syntax.
START_ARGS=(agent start "$AGENT_NAME" --kind pi --pane "$NEW_PANE_ID" --)
if [[ -n "$MODEL" ]]; then
  START_ARGS+=(--model "$MODEL")
fi
if [[ -n "$THINKING" ]]; then
  START_ARGS+=(--thinking "$THINKING")
fi
if [[ -n "$ROLE_SYSTEM_PROMPT" ]]; then
  START_ARGS+=(--append-system-prompt "$ROLE_SYSTEM_PROMPT")
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
  "role": "${ROLE:-none}",
  "thinking": "${THINKING:-parent}",
  "status": "completed",
  "response": $(echo "$RESPONSE" | jq -Rs .)
}
EOF

# Cleanup: Close the pane (this also stops the agent)
herdr pane close "$NEW_PANE_ID" > /dev/null 2>&1 || true

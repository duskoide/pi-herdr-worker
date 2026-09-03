# pi-herdr-worker

Spawn pi agents in isolated Herdr panes — one-shot delegations in their own tabs, or temporary agents in split panes.

## Installation

```bash
pi install npm:pi-herdr-worker
```

Or via git:

```bash
pi install git:github.com/duskoide/pi-herdr-worker
```

The extension adds two always-available tools for delegating work to pi subagents that run in Herdr-managed panes:

- **`worker_delegate`** — spawn a fresh one-shot pi subagent in its own Herdr tab. Best for implementation, testing, and review work that benefits from a clean context window. Multiple disjoint-path delegations run concurrently (up to `max-concurrent`).
- **`spawn_pi`** — spawn a temporary pi agent in a split pane. Best for short-lived, independent tasks that don't need a coordinated plan.

At session start the extension injects a concise `worker_delegate` / `spawn_pi` primer into the system prompt so the orchestrator knows when to delegate — without first having to read the skill.

```text
worker_delegate({
  prompt: "Implement the API and tests",
  paths: ["src/api.ts", "tests/api.test.ts"],
})

worker_delegate({
  prompt: "Review the auth module",
  role: "reviewer",
})

spawn_pi({ prompt: "Run npm test and report failures" })
```

## Requirements

- Pi must be running inside a Herdr-managed pane (`HERDR_ENV=1`)
- Herdr must be installed and running
- The requested models must be available and authenticated in Pi

## Delegating work

`worker_delegate` accepts a `paths` array — files or directories the task may modify. Use repository-relative paths.

- Tasks with **disjoint** `paths` may execute concurrently on separate subagents, up to `max-concurrent`.
- Tasks with **overlapping** `paths`, and tasks without `paths`, wait for conflicting work to finish.
- Treat shared configuration, lockfiles, generated files, and broad test/build commands as exclusive by omitting `paths`.

```text
worker_delegate({
  prompt: "Implement the API and tests",
  paths: ["src/api.ts", "tests/api.test.ts"],
})

worker_delegate({
  prompt: "Run the full test suite and report failures",
})
```

Every delegation spawns a subagent, waits for its report, and closes the tab. Each call is a complete handoff: prompts must be self-contained — subagents have no memory of this conversation.

## Roles

A **role** is a persona — a custom system prompt (and optional `model`, `thinking`, and `tools`) for a spawned subagent. Roles are defined as pi-style agent markdown files, so they double as native subagent types if you also use a subagent extension.

Discovery order (later entries override earlier ones):

1. Built-in `worker` — the generic one-shot implementation worker.
2. Global `~/.pi/agent/agents/<role>.md`
3. Workspace `<cwd>/.agents/agents/<role>.md`
4. Project `<cwd>/.pi/agents/<role>.md` (highest priority)

A role file uses YAML frontmatter plus a markdown body:

```markdown
---
description: Reviews code for correctness, security, and conventions
model: anthropic/claude-sonnet-4-5
thinking: medium
tools: read, bash, grep, find, ls
prompt_mode: append
---

You are a senior code reviewer. Focus on correctness, security, and
adherence to project conventions. Report findings as a numbered list.
```

Supported frontmatter fields:

| Field | Effect |
|---|---|
| `description` | Shown in `/worker-config roles` and the role picker |
| `name` | The role's type; defaults to the filename. Colons are reserved |
| `model` | `--model` for the subagent (overrides the subagent default model) |
| `thinking` | `--thinking` level (overrides the subagent default thinking) |
| `tools` | `--tools` allowlist (comma-separated; `all`/`*` = no flag) |
| `prompt_mode` | `replace` (default): body is the subagent's system prompt. `append`: body is appended to the built-in worker preamble |
| `enabled` | `false` disables the role |

Pick a role per delegation, or set a default:

```text
worker_delegate({ prompt: "Implement the API and tests", role: "impl" })
worker_delegate({ prompt: "Review the auth module", role: "reviewer" })
/worker-config default-role impl
```

An unknown role falls back to the built-in generic worker with a warning rather than failing the task.

## Configuration

The interactive settings UI is opened with `/worker-config` (no arguments). Pick the subagent model and thinking level (with an inherit-from-parent option), pick the default role, set `max-concurrent`, and reset all overrides. The panel edits a draft; press **Ctrl+S** to save and **Esc** to discard. Use ↑↓ to navigate and Enter to cycle or open a picker.

The one-line subcommands remain available (useful for scripting and quick tweaks; these apply immediately):

```text
/worker-config                   # open the settings UI
/worker-config ui                # open the settings UI
/worker-config show
/worker-config default-role <role>
/worker-config max-concurrent <n>
/worker-config roles
/worker-config worker-model <provider/model>
/worker-config worker-thinking <off|minimal|low|medium|high|xhigh|max>
/worker-config reset
```

Worker model/thinking overrides and the default role persist in the global Pi `settings.json` under `herdrWorker`; inherited values remain omitted.

## Temporary spawn commands

For an independent one-shot task outside a coordinated plan, use the slash commands:

```text
/spawn Run tests and report failures --role reviewer
/spawn Review code pi-reviewer claude-sonnet-5
/spawnp Run the linter and fix errors
/spawnlist
/spawnkill pi-test-runner
```

`spawn_pi` is also available as a tool:

```text
spawn_pi({
  prompt: "Run tests and report any failures",
  name: "pi-test-runner",
  role: "reviewer",
  model: "gpt-4o",
  timeout: 180000,
  direction: "right",
})
```

## Command line helper

```bash
~/.pi/agent/bin/herdr-worker.sh <agent-name> "<prompt>" [--model <model>] [--role <role>] [--timeout <ms>]

~/.pi/agent/bin/herdr-worker.sh pi-test "Run npm test and report results" \
  --model openai/gpt-4o --role reviewer --timeout 180000
```

## How spawning works

1. Split the current pane without taking focus (or spawn a subagent in a new tab for a delegated task).
2. Start a fresh pi agent with the requested model/thinking/role settings.
3. Send the prompt and wait for its response.
4. Read the response and close the temporary pane/tab.

## License

MIT

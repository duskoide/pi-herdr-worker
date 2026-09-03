# pi-herdr-worker

Spawn pi agents in isolated Herdr panes, or run pi as an orchestrator that delegates implementation work to fresh, one-shot subagents.

## Installation

```bash
pi install npm:pi-herdr-worker
```

Or via git:

```bash
pi install git:github.com/duskoide/pi-herdr-worker
```

Pi starts in **regular mode** for every session. Brain mode is session-only: it never persists across restarts, reloads, or session switches.

## Brain mode

Brain mode switches the **current session into the brain (orchestrator) role**. Instead of a reusable worker, every delegation spawns a **fresh, one-shot subagent** that completes the task, returns its report, and is closed. This gives each task a clean context and guarantees no cross-task state leaks.

- **Brain** — the current pi session, after it changes role. It plans, delegates, inspects results, and reports to the user. It does not do implementation work itself.
- **Subagent** — a fresh pi spawned in a new Herdr tab for a single delegated task. It runs to completion, returns its report, and the tab is closed. It has no memory of this conversation, so delegation prompts must be self-contained.

Enable and configure it with the interactive settings UI or one-line subcommands.

Run `/worker-config` with no arguments to open the settings UI — an interactive panel where you can:

- Toggle **Mode** between `regular` and `brain` (Enter cycles).
- Pick the **Brain model** and **Subagent model** from a searchable list of available models (Enter opens the picker; start typing to filter by name, backspace to edit; the subagent model can inherit the brain model).
- Set the **Brain thinking** and **Subagent thinking** levels from a picker.
- Pick the **Default role** — the persona applied when `worker_delegate` omits `role`.
- Set **Max concurrent** — the upper bound on subagents running at once.
- **Reset overrides** back to inheriting the current session's model/thinking.

The panel edits a **draft** — nothing is applied while you navigate. A status line shows `● unsaved changes` once you edit anything. Press **Ctrl+S** to save: the extension then switches the session model/mode. Press **Esc** to discard the draft and close without changes. Use ↑↓ to navigate and Enter to cycle or open a picker.

The one-line subcommands remain available (useful for scripting and quick tweaks; these apply immediately):

```text
/worker-config              # open the settings UI
/worker-config ui           # open the settings UI
/worker-config show
/worker-config mode brain
/worker-config default-role reviewer
/worker-config max-concurrent 4
/worker-config roles
/worker-config brain-model anthropic/claude-sonnet-4-5
/worker-config brain-thinking high
/worker-config worker-model openai/gpt-4o
/worker-config worker-thinking medium
```

`/worker-config mode brain` changes the current session's role to brain. The brain receives an explicit orchestrator system instruction and its mutation tools (`write`, `edit`, `bash`, patching, delete, and move) are blocked. Use the `worker_delegate` tool for implementation or validation tasks; each call spawns a one-shot subagent whose report comes back to the brain.

Worker model/thinking overrides and the default role persist in the global Pi `settings.json` under `herdrWorker`; inherited values remain omitted. Brain/regular mode is never persisted and every new session starts in regular mode.

## Roles

A **role** is a persona — a custom system prompt (plus optional model, thinking level, and tool allowlist) for a spawned subagent. Roles are defined as pi-style agent markdown files, so they double as native subagent types if you also use a subagent extension.

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

The role name is used as the subagent's session name, so spawned tabs are easy to identify in Herdr.

Pick a role per delegation, or set a default:

```text
worker_delegate({ prompt: "Implement the API and tests", role: "impl" })
worker_delegate({ prompt: "Review the auth module", role: "reviewer" })
/worker-config default-role impl
```

An unknown role falls back to the built-in generic worker with a warning rather than failing the task.

## Delegating work

`worker_delegate` accepts an optional `paths` array. Use repository-relative paths (or directories) for files the task may modify:

```text
worker_delegate({
  prompt: "Implement the API and tests",
  paths: ["src/api.ts", "tests/api.test.ts"]
})
```

Tasks with disjoint `paths` may execute concurrently on separate subagents, up to `max-concurrent`. Tasks with overlapping paths, and tasks without `paths`, wait for conflicting work to finish. Treat shared configuration, lockfiles, generated files, and broad test/build commands as exclusive by omitting `paths`.

Each delegation spawns a subagent, waits for its report, and closes the tab:

```text
worker_delegate({ prompt: "Run the full test suite and report failures" })
```

Return to direct work with:

```text
/worker-config mode regular
```

Active subagents run to completion even after switching to regular mode; their tabs close when each task finishes. On session shutdown, owned subagent tabs are closed and queued delegations are rejected.

## Temporary spawn commands

These commands remain available in both modes for short-lived, independent tasks:

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
  direction: "right"
})
```

## Command line helper

```bash
~/.pi/agent/bin/herdr-worker.sh <agent-name> "<prompt>" [--model <model>] [--role <role>] [--timeout <ms>]

~/.pi/agent/bin/herdr-worker.sh pi-test "Run npm test and report results" \
  --model openai/gpt-4o --role reviewer --timeout 180000
```

## Requirements

- Pi must be running inside a Herdr-managed pane (`HERDR_ENV=1`)
- Herdr must be installed and running
- The requested models must be available and authenticated in Pi

## How temporary spawning works

1. Split the current pane without taking focus (or spawn a subagent in a new tab for a delegated task).
2. Start a fresh pi agent with the requested model/thinking/role settings.
3. Send the prompt and wait for its response.
4. Read the response and close the temporary pane/tab.

## License

MIT

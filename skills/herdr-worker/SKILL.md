---
name: herdr-worker
description: Spawns one-shot pi subagents in new Herdr tabs, or temporary pi agents in split panes for isolated tasks. Switch the current session to brain mode when it should orchestrate and delegate work instead of doing it directly.
---

# Herdr Spawn

This extension supports two session-only modes:

- **regular** (default): the current pi session can inspect, edit, test, and execute work directly.
- **brain**: the current session **changes role to the brain/orchestrator** and delegates implementation work to fresh one-shot subagents.

## Brain-mode workflow

1. Start Pi. The extension initializes in regular mode.
2. Configure the roles with `/worker-config`:
   - `mode regular|brain`
   - `default-role <role>`
   - `max-concurrent <n>`
   - `brain-model <provider/model>`
   - `brain-thinking <off|minimal|low|medium|high|xhigh|max>`
   - `worker-model <provider/model>`
   - `worker-thinking <off|minimal|low|medium|high|xhigh|max>`
3. Entering brain mode switches the session to the brain role.
4. In brain mode, the brain plans and delegates through `worker_delegate`. Each call spawns a **fresh one-shot subagent** in its own Herdr tab, waits for its report, and closes the tab. Pass `paths` for files/directories a task may modify: disjoint scopes can run concurrently on separate subagents (up to `max-concurrent`); overlapping scopes are serialized; omitted scopes are exclusive. Pass `role` to select a persona defined in `.pi/agents/<role>.md`.
5. Worker model/thinking overrides and the default role persist in the global Pi `settings.json` under `herdrWorker`. Inherited values remain omitted. Mode is never persisted and every session starts in regular mode.
6. The brain must not perform non-trivial mutations. Write, edit, bash, patch, delete, and move tool calls are blocked; trivial coordination is still possible through commands and status updates.
7. Subagents have no memory of the brain's conversation. Build complete, self-contained delegation prompts; inspect and summarize each report before the next delegation.

Brain mode requires `HERDR_ENV=1`. Model choices are applied when the subagent spawns; a role file may override the subagent default model/thinking/tools. Brain model and thinking settings apply to the current pi session.

## Delegating a task

Use the `worker_delegate` tool with a complete, self-contained task, including the relevant files, desired behavior, and validation command. Each subagent can inspect files, edit source, run tests, and report back. Keep one coherent implementation or validation objective per delegation.

Example delegation:

```text
Implement the worker-mode configuration command in extensions/herdr-worker.ts.
Preserve the existing temporary /spawn commands. Run the strongest available
TypeScript or Pi extension smoke check and report changed files and failures.
```

Choose a role when a specialized persona is appropriate:

```text
worker_delegate({ prompt: "Review the auth module for security", role: "reviewer" })
```

Roles are read from `.pi/agents/<name>.md` (project), `.agents/agents/<name>.md` (workspace), and `~/.pi/agent/agents/<name>.md` (global); project wins. The role file supplies a custom system prompt and optional model/thinking/tools.

## Roles

Role files use pi's agent markdown format: YAML frontmatter plus a markdown body. Supported fields include `description`, `name`, `model`, `thinking`, `tools`, `prompt_mode` (`replace` or `append`), and `enabled`. The built-in `worker` role is the generic implementation worker. See the project README for the full table.

## Temporary-spawn workflow

The extension also keeps `/spawn`, `/spawnp`, `/spawnlist`, `/spawnkill`, and `spawn_pi` for short-lived or independent tasks. These create a temporary pane, run one prompt, return its output, and close the pane.

Temporary agents can receive a model, thinking level, and role from the command-line helper:

```bash
~/.pi/agent/bin/herdr-worker.sh <agent-name> "<prompt>" \
  [--model <provider/model>] [--role <role>] [--timeout <ms>]
```

## Safety and lifecycle

Subagents are scoped to the current extension/session instance. Each one-shot subagent owns a Herdr tab that is closed after its task completes — including on mode exit, reload, session replacement, or quit. Queued delegations are rejected on shutdown. Delegations use argument-safe Herdr process calls and have a default timeout of five minutes.

All Herdr workflows require pi to be running inside a Herdr-managed pane (`HERDR_ENV=1`).

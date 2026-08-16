---
name: herdr-worker
description: Spawns a persistent pi worker in a new Herdr tab, or a temporary pi agent for isolated tasks. Switch the current session to brain mode when it should orchestrate and delegate work instead of doing it directly.
---

# Herdr Spawn

This extension supports two session-only modes:

- **regular** (default): the current pi session can inspect, edit, test, and execute work directly.
- **brain**: the current session **changes role to the brain/orchestrator** and one persistent pi is spawned in a new Herdr tab as the **worker**.

## Brain-mode workflow

1. Start Pi. The extension initializes in regular mode.
2. Configure the roles with `/worker-config`:
   - `mode regular|brain`
   - `brain-model <provider/model>`
   - `brain-thinking <off|minimal|low|medium|high|xhigh|max>`
   - `worker-model <provider/model>`
   - `worker-thinking <off|minimal|low|medium|high|xhigh|max>`
3. Entering brain mode switches the current session to the brain role, creates a new worker tab, and keeps it alive for the session.
4. In brain mode, the brain plans and delegates through `worker_delegate`. Delegations are serialized and the worker reports back after each task.
5. The brain must not perform non-trivial mutations. Write, edit, bash, patch, delete, and move tool calls are blocked; trivial coordination is still possible through commands and status updates.
6. Close the worker (agent + Herdr tab) when you no longer need it:
   - `worker_delegate({ prompt: "...", closeAfter: true })` closes it right after the delegated task finishes.
   - `/worker-config close` closes it on demand while staying in brain mode; the next delegation spawns a fresh worker.
   - `/worker-config mode regular` switches the session back to direct work and closes the worker. Session shutdown also performs best-effort cleanup.

Brain mode requires `HERDR_ENV=1`. Model choices are applied when the worker starts; changing the worker model or thinking level while active restarts the worker so the new settings take effect. Brain model and thinking settings apply to the current pi session.

## Delegating a task

Use the `worker_delegate` tool with a complete task, including the relevant files, desired behavior, and validation command. The worker can inspect files, edit source, run tests, and report back. Keep one coherent implementation or validation objective per delegation.

Example delegation:

```text
Implement the worker-mode configuration command in extensions/herdr-worker.ts.
Preserve the existing temporary /spawn commands. Run the strongest available
TypeScript or Pi extension smoke check and report changed files and failures.
```

## Temporary-spawn workflow

The extension also keeps `/spawn`, `/spawnp`, `/spawnlist`, `/spawnkill`, and `spawn_pi` for short-lived or independent tasks. These create a temporary pane, run one prompt, return its output, and close the pane.

Temporary agents can receive a model and thinking level from the command-line helper:

```bash
~/.pi/agent/bin/herdr-worker.sh <agent-name> "<prompt>" \
  [--model <provider/model>] [--thinking <level>] [--timeout <ms>]
```

## Safety and lifecycle

The worker is scoped to the current extension/session instance. It is not persisted to disk and is closed on mode exit, reload, session replacement, or quit. Delegations use argument-safe Herdr process calls and have a default timeout of five minutes.

All Herdr workflows require pi to be running inside a Herdr-managed pane (`HERDR_ENV=1`).

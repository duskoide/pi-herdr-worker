---
name: herdr-worker
description: Spawns a persistent pi worker in a new Herdr tab, or a temporary pi agent for isolated tasks. Switch the current session to brain mode when it should orchestrate and delegate work instead of doing it directly.
---

# Herdr Spawn

This extension supports two session-only modes:

- **regular** (default): the current pi session can inspect, edit, test, and execute work directly.
- **brain**: the current session **changes role to the brain/orchestrator** and one persistent pi is spawned in a new Herdr tab as the **worker**.

## Brain-mode workflow

1. Start Pi. The extension initializes in regular mode and loads worker defaults from `~/.pi/agent/herdr-worker.json`.
2. The agent can enter brain mode itself with `worker_mode({ action: "brain" })`; no user slash command is required. Calling `worker_delegate` also enters brain mode automatically.
3. A persistent worker starts in a dedicated Herdr tab created with the calling brain pane's exact workspace ID. Delegations target its workspace-qualified pane ID. If the brain moves workspaces, the old worker is replaced in the new workspace. Delegations reuse it and are serialized.
4. Delegate one coherent objective at a time with an explicit role: `general`, `explore`, `plan`, `impl`, `test`, `review`, or `simplify`.
5. In brain mode, only coordination and read-only tools remain active; every other tool call is blocked.
6. Return to direct work with `worker_mode({ action: "regular" })`, or close only the worker with `worker_mode({ action: "close" })`.

Manual `/worker-config` commands and the settings UI remain available for session-only overrides. Worker-model overrides must be allowed by `herdr-worker.json`; changing live worker settings restarts it.

Brain mode requires `HERDR_ENV=1`. Mode itself remains session-only and resets on reload, session replacement, or restart.

## Delegating a task

Use the `worker_delegate` tool with a role and a complete task, including relevant files, desired behavior, constraints, and validation command. The worker can inspect files, edit source when its role permits it, run tests, and report back.

```text
worker_delegate({
  role: "impl",
  prompt: "Implement the approved behavior in extensions/herdr-worker.ts. Run the strongest available TypeScript or Pi extension smoke check and report changed files and failures."
})
```

## Temporary-spawn workflow

The extension also keeps `/spawn`, `/spawnp`, `/spawnlist`, `/spawnkill`, and `spawn_pi` for short-lived or independent tasks. These explicitly resolve the caller's current workspace, create a temporary tab there, run one prompt, return its output, and close the tab. They use `herdr-worker.json` defaults unless explicitly overridden and do not use session-only `/worker-config` overrides.

```bash
~/.pi/agent/bin/herdr-worker.sh <agent-name> "<prompt>" \
  [--model <provider/model>] [--thinking <level>] [--timeout <ms>]
```

## Safety and lifecycle

The worker is scoped to the current extension/session instance. It is not persisted to disk and is closed on mode exit, reload, session replacement, or quit. Delegations are argument-safe, serialized, and use the configured timeout. Worker failures throw so Pi records a real tool error.

All Herdr workflows require pi to be running inside a Herdr-managed pane (`HERDR_ENV=1`).

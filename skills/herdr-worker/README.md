# Herdr Worker Skill

Spawn pi subagents in isolated Herdr panes — one-shot delegations in their own tabs, or temporary agents in split panes.

## Quick Start

After installing this package with `pi install npm:pi-herdr-worker`, two delegation tools become available in every session:

```text
worker_delegate({ prompt: "Implement the API and tests", paths: ["src/api.ts", "tests/api.test.ts"] })
worker_delegate({ prompt: "Review the auth module", role: "reviewer" })
spawn_pi({ prompt: "Run npm test and report failures" })
```

- **`worker_delegate`** spawns a fresh one-shot pi subagent in its own Herdr tab, waits for its report, and closes the tab. Pass `paths` to enable parallel execution of disjoint scopes (bounded by `max-concurrent`); pass `role` to pick a persona from `.pi/agents/<role>.md`.
- **`spawn_pi`** spawns a temporary pi agent in a split pane for short-lived, independent tasks; it closes the pane when it returns.

Configure defaults with `/worker-config`:

```text
/worker-config show
/worker-config default-role <role>
/worker-config max-concurrent <n>
/worker-config worker-model <provider/model>
/worker-config worker-thinking <level>
/worker-config roles
```

## Roles

A **role** is a persona — a custom system prompt (and optional `model`, `thinking`, `tools`) for a spawned subagent. Roles live in `.pi/agents/<role>.md` (project), `.agents/agents/<role>.md` (workspace), or `~/.pi/agent/agents/<role>.md` (global); project wins.

```text
worker_delegate({ prompt: "Implement the API and tests", role: "impl" })
worker_delegate({ prompt: "Review the auth module", role: "reviewer" })
/worker-config default-role impl
```

## Temporary agents

For an independent one-shot task outside a coordinated plan, use the slash commands:

```text
/spawn Run tests and report failures
/spawnp Run the linter and fix errors
/spawnlist
/spawnkill pi-test-runner
```

## Requirements

- Pi must be running inside a Herdr-managed pane (`HERDR_ENV=1`)
- Herdr must be installed and running
- Requested models must be available and authenticated

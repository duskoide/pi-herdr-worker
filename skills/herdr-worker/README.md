# Herdr Worker Skill

Spawn pi subagents in isolated Herdr panes — one-shot delegations in their own tabs, or temporary agents in split panes.

## Quick Start

After installing this package with `pi install npm:pi-herdr-worker`, Pi starts in regular mode. Configure the session-only brain/worker workflow with:

```text
/worker-config show
/worker-config mode brain
/worker-config default-role <role>
/worker-config max-concurrent <n>
/worker-config brain-model <provider/model>
/worker-config brain-thinking <level>
/worker-config worker-model <provider/model>
/worker-config worker-thinking <level>
/worker-config roles
```

In brain mode, the current session **changes role to the brain/orchestrator** and delegates implementation, testing, and review work through `worker_delegate`. Every delegation spawns a **fresh one-shot pi subagent** in its own Herdr tab, runs the task, returns its report, and closes the tab. The brain's mutation tools are blocked in this mode.

Roles are personas defined in `.pi/agents/<role>.md`; a role supplies a custom system prompt and optional model/thinking/tools. Pick one per delegation or set a default:

```text
worker_delegate({ prompt: "Implement the API and tests", role: "impl" })
/worker-config default-role impl
```

Return to direct work with:

```text
/worker-config mode regular
```

## Temporary agents

For an independent one-shot task, use:

```text
/spawn Run tests and report failures
/spawnp Run the linter and fix errors
/spawnlist
/spawnkill pi-test-runner
```

These commands create a temporary pane, start a pi agent, wait for its response, and close the pane.

## Requirements

- Pi must be running inside a Herdr-managed pane (`HERDR_ENV=1`)
- Herdr must be installed and running
- Requested models must be available and authenticated

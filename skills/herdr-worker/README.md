# Herdr Worker Skill

Run pi agents in isolated Herdr panes, including the persistent worker used by worker mode.

## Quick Start

After installing this package with `pi install npm:pi-herdr-worker`, Pi starts in regular mode. Configure the session-only worker workflow with:

```text
/worker-config show
/worker-config mode worker
/worker-config brain-model <provider/model>
/worker-config brain-thinking <level>
/worker-config worker-model <provider/model>
/worker-config worker-thinking <level>
```

In worker mode, the current session is the brain/orchestrator and delegates implementation, testing, and review work through `worker_delegate`. One worker pi stays in a sibling pane and receives serialized tasks. The brain's mutation tools are blocked in this mode.

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

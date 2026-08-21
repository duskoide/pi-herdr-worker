# Herdr Worker Skill

Run Pi agents in dedicated Herdr tabs, including the persistent worker used by brain mode and independent temporary workers.

## Quick Start

Pi starts in regular mode. The agent can switch itself into brain mode without asking the user to type a slash command:

```text
worker_mode({ action: "brain" })
```

Calling `worker_delegate` also enters brain mode automatically. Manual `/worker-config` commands remain available for interactive configuration and status.

Worker defaults are loaded from `~/.pi/agent/herdr-worker.json`; the extension applies its default model, thinking level, timeout, and allowed-model list to persistent and temporary workers.

In brain mode, the current session is the orchestrator. One persistent worker Pi is spawned in a new Herdr tab and receives serialized, role-specific tasks. The brain retains only coordination and read-only tools; other calls are blocked.

Delegate with an explicit role:

```text
worker_delegate({
  role: "impl",
  prompt: "Implement the approved change in the listed files and run the specified tests."
})
```

Roles are `general`, `explore`, `plan`, `impl`, `test`, `review`, and `simplify`. Explore, plan, review, and simplify are instructed to remain read-only. Delegation waits are asynchronous, report live status, support cancellation, and return only the worker's concise final report rather than its full terminal history.

Close the worker when done:

```text
worker_delegate({ role: "test", prompt: "Run tests and report failures", closeAfter: true })
worker_mode({ action: "regular" })
```

`/worker-config close` and `/worker-config mode regular` are equivalent manual controls.

## Temporary agents

For independent one-shot work, use `/spawn`, `/spawnp`, or `spawn_pi`. Each creates a dedicated temporary Herdr tab, starts a Pi agent with the configured defaults unless explicitly overridden, waits for its response, and closes the tab. Temporary workers share the checkout, so do not run concurrent mutations against the same files.

## Requirements

- Pi must run inside a Herdr-managed pane (`HERDR_ENV=1`)
- Herdr must be installed and running
- Requested/default models must be available and authenticated

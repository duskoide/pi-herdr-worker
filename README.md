# pi-herdr-spawn

Spawn pi agents in isolated Herdr panes, or run pi as an orchestrator that delegates implementation work to one persistent worker.

## Installation

```bash
pi install npm:pi-herdr-spawn
```

Or via git:

```bash
pi install git:github.com/duskoide/pi-herdr-spawn
```

Pi starts in **regular mode** for every session. Worker mode is session-only: it never persists across restarts, reloads, or session switches.

## Worker mode

Worker mode separates the current session into two roles:

- **Brain** — the current pi session. It plans, delegates, inspects results, and reports to the user.
- **Worker** — one persistent pi instance in a sibling Herdr pane. It performs implementation, testing, reviews, and other non-trivial work.

Enable and configure it with one command:

```text
/worker-config show
/worker-config mode worker
/worker-config brain-model anthropic/claude-sonnet-4-5
/worker-config brain-thinking high
/worker-config worker-model openai/gpt-4o
/worker-config worker-thinking medium
```

`/worker-config mode worker` creates the worker pane. Delegations reuse that worker and are serialized so tasks cannot race over the same checkout. The brain receives an explicit orchestrator system instruction and mutation tools (`write`, `edit`, `bash`, patching, delete, and move) are blocked. Use the `worker_delegate` tool for implementation or validation tasks. The worker returns its report to the brain, which can then decide the next delegation.

Return to direct work with:

```text
/worker-config mode regular
```

This closes the persistent worker. The worker is also closed during session shutdown. If Pi is not running inside Herdr (`HERDR_ENV=1`), worker mode reports an error and remains disabled.

## Temporary spawn commands

These commands remain available in both modes for short-lived, independent tasks:

```text
/spawn Run tests and report failures
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
  model: "gpt-4o",
  timeout: 180000,
  direction: "right"
})
```

## Command line helper

```bash
~/.pi/agent/bin/herdr-spawn.sh <agent-name> "<prompt>" [--model <model>] [--thinking <level>] [--timeout <ms>]

~/.pi/agent/bin/herdr-spawn.sh pi-test "Run npm test and report results" \
  --model openai/gpt-4o --thinking medium --timeout 180000
```

## Requirements

- Pi must be running inside a Herdr-managed pane (`HERDR_ENV=1`)
- Herdr must be installed and running
- The requested models must be available and authenticated in Pi

## How temporary spawning works

1. Split the current pane without taking focus.
2. Start a fresh pi agent with the requested model/thinking settings.
3. Send the prompt and wait for its response.
4. Read the response and close the temporary pane.

## License

MIT

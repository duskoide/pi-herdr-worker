# pi-herdr-worker

Spawn pi agents in isolated Herdr panes, or run pi as an orchestrator that delegates implementation work to one persistent worker in its own tab.

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

Brain mode switches the **current session into the brain (orchestrator) role** and pairs it with one spawned worker:

- **Brain** — the current pi session, after it changes role. It plans, delegates, inspects results, and reports to the user. It does not do implementation work itself.
- **Worker** — one persistent pi instance spawned in a new Herdr tab. It performs implementation, testing, reviews, and other non-trivial work.

Enable and configure it with the interactive settings UI or one-line subcommands.

Run `/worker-config` with no arguments to open the settings UI — an interactive panel where you can:

- Toggle **Mode** between `regular` and `brain` (Enter cycles).
- Pick the **Brain model** and **Worker model** from a searchable list of available models (Enter opens the picker; start typing to filter by name, backspace to edit; the worker model can inherit the brain model).
- Set the **Brain thinking** and **Worker thinking** levels from a picker.
- **Reset overrides** back to inheriting the current session's model/thinking.

The panel edits a **draft** — nothing is applied while you navigate. A status line shows `● unsaved changes` once you edit anything. Press **Ctrl+S** to save: the extension then switches the session model/mode and, if needed, reloads the worker with the new settings. Press **Esc** to discard the draft and close without changes. Use ↑↓ to navigate and Enter to cycle or open a picker.

The one-line subcommands remain available (useful for scripting and quick tweaks; these apply immediately):

```text
/worker-config              # open the settings UI
/worker-config ui           # open the settings UI
/worker-config show
/worker-config mode brain
/worker-config brain-model anthropic/claude-sonnet-4-5
/worker-config brain-thinking high
/worker-config worker-model openai/gpt-4o
/worker-config worker-thinking medium
```

`/worker-config mode brain` changes the current session's role to brain and spawns the worker in a new Herdr tab. Delegations reuse that worker and are serialized so tasks cannot race over the same checkout. The brain receives an explicit orchestrator system instruction and its mutation tools (`write`, `edit`, `bash`, patching, delete, and move) are blocked. Use the `worker_delegate` tool for implementation or validation tasks. The worker returns its report to the brain, which can then decide the next delegation.

Delegate and close the worker (agent + Herdr tab) in one step by passing `closeAfter: true`:

```text
worker_delegate({ prompt: "Run the full test suite and report failures", closeAfter: true })
```

Close the worker on demand while staying in brain mode (the next delegation spawns a fresh worker):

```text
/worker-config close
```

Return to direct work with:

```text
/worker-config mode regular
```

This closes the persistent worker and its Herdr tab. The worker is also closed during session shutdown. If Pi is not running inside Herdr (`HERDR_ENV=1`), brain mode reports an error and remains disabled.

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
~/.pi/agent/bin/herdr-worker.sh <agent-name> "<prompt>" [--model <model>] [--thinking <level>] [--timeout <ms>]

~/.pi/agent/bin/herdr-worker.sh pi-test "Run npm test and report results" \
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

---
name: herdr-spawn
description: Spawns a pi agent in a new Herdr pane to execute isolated tasks in parallel. Use when you need to run work in a separate pane without blocking the current session.
---

# Herdr Spawn

Spawn pi agents in isolated Herdr panes to execute tasks in parallel.

## When to Use

- Running long tasks without blocking the current session
- Parallel execution of independent tasks
- Isolating potentially destructive operations
- Running background monitoring or testing

## Workflow

### 1. Verify Herdr Environment

```bash
test "${HERDR_ENV:-}" = 1 && echo "In Herdr" || echo "Not in Herdr"
```

If not in Herdr, report the error and stop.

### 2. Get Current Context

```bash
herdr pane current --current
```

Extract the `pane_id` from the response.

### 3. Create New Pane

Split to create a sibling pane (preserves working directory and user focus):

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus
```

Extract the new `pane_id` from `.result.pane.pane_id`.

### 4. Start Pi Agent

Start a pi agent with a unique, descriptive name. Optionally specify a model:

```bash
# Without model (uses parent's model)
herdr agent start <unique-name> --kind pi --pane <new-pane-id>

# With specific model
herdr agent start <unique-name> --kind pi --pane <new-pane-id> -- --model <model-id>
```

**Naming rules:**
- Lowercase letters, numbers, hyphens only
- Maximum 31 characters
- Must be unique among live agents
- Example: `pi-test-runner`, `pi-refactor-auth`

**Model examples:**
- `gpt-4o` - Fast, good for simple tasks
- `claude-sonnet-5` - Strong reasoning
- `provider/model-id` - Full provider specification

### 5. Send Prompt and Wait

Submit the task and wait for completion:

```bash
herdr agent prompt <agent-name> "<prompt>" --wait --timeout 120000
```

For complex tasks, increase the timeout.

### 6. Read Response

Get the agent's output:

```bash
herdr agent read <agent-name> --source recent-unwrapped --lines 100
```

### 7. Report Results

Provide:
- Pane ID where the agent ran
- Agent name
- Complete response from the agent
- Any errors encountered

### 8. Cleanup (Important!)

After getting the response, close the agent and pane to free resources:

```bash
# Close the pane (this also stops the agent)
herdr pane close <pane-id>
```

**Note:** Closing the pane automatically stops any agent running in it. Only close panes you created!

## Example Usage

**User request:** "Run tests in a separate pane using a fast model"

**Agent execution:**
1. Verify Herdr environment
2. Create new pane: `herdr pane split --current --direction right --cwd /home/pn --no-focus`
3. Start agent with model: `herdr agent start pi-test-run --kind pi --pane w7:p2 -- --model gpt-4o`
4. Send prompt: `herdr agent prompt pi-test-run "Run the test suite with 'npm test' and report any failures" --wait`
5. Read output: `herdr agent read pi-test-run --source recent-unwrapped --lines 150`
6. Report: "Tests completed in pane w7:p2. 15 tests passed, 2 failed. Here are the failures: ..."
7. Cleanup: `herdr pane close w7:p2`

**User request:** "Review code with claude-sonnet-5"

**Agent execution:**
1. Verify Herdr environment
2. Create new pane
3. Start agent with model: `herdr agent start pi-review --kind pi --pane w7:p3 -- --model claude-sonnet-5`
4. Send prompt: `herdr agent prompt pi-review "Review the recent code changes" --wait`
5. Read output
6. Report results
7. Cleanup

## Important Notes

- Always use `--no-focus` to keep the user's focus on the original pane
- Use unique agent names to avoid conflicts
- The spawned agent has access to the same tools and context as the parent
- For very long tasks, consider using `--timeout` with appropriate values
- If reading output fails (alternate screen), ask the agent to write results to a file and read that instead

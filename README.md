# pi-herdr-spawn

Spawn pi agents in isolated Herdr panes to execute tasks in parallel.

## Installation

```bash
pi install npm:pi-herdr-spawn
```

Or via git:

```bash
pi install git:github.com/duskoide/pi-herdr-spawn
```

## Usage

### Slash Commands

After installing, restart pi or run `/reload`:

```bash
# Basic usage - spawn with auto-generated name
/spawn Run tests and report failures

# With custom name
/spawn Review code pi-reviewer

# With custom name and model
/spawn Review code pi-reviewer claude-sonnet-5

# Quick spawn (shorthand)
/spawnp Run the linter and fix errors

# List running agents
/spawnlist

# Kill a specific agent
/spawnkill pi-test-runner
```

### Tool Usage

You can also use the `spawn_pi` tool directly:

```
spawn_pi({
  prompt: "Run tests and report any failures",
  name: "pi-test-runner",
  model: "gpt-4o",
  timeout: 180000,
  direction: "right"
})
```

### Command Line

```bash
~/.pi/agent/bin/herdr-spawn.sh <agent-name> "<prompt>" [--model <model>] [--timeout <ms>]

# Example:
~/.pi/agent/bin/herdr-spawn.sh pi-test "Run npm test and report results" --timeout 180000
```

## How It Works

1. **Creates a new pane** - Splits the current pane to create an isolated terminal
2. **Starts pi agent** - Launches a fresh pi instance in the new pane
3. **Sends your prompt** - Submits the task and waits for completion
4. **Reads the response** - Gets the agent's output
5. **Cleans up** - Closes the pane and stops the agent automatically

## Requirements

- Pi must be running inside a Herdr-managed pane (`HERDR_ENV=1`)
- Herdr must be installed and running

## Use Cases

### Parallel Testing

```bash
/spawn npm test pi-tests
/spawn npm run lint pi-linter
/spawn npm run typecheck pi-types
```

### Code Review

```
spawn_pi({ prompt: "Review the recent git changes and suggest improvements" })
```

### Long-Running Tasks

```
spawn_pi({ 
  prompt: "Run the build process and report any errors",
  timeout: 300000 
})
```

## License

MIT

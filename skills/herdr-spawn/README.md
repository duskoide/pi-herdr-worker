# Herdr Spawn Skill

Spawn pi agents in isolated Herdr panes to execute tasks in parallel.

## Quick Start

After installing this package with `pi install npm:pi-herdr-spawn`, use the slash commands:

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

## How It Works

1. **Creates a new pane** - Splits the current pane to create an isolated terminal
2. **Starts pi agent** - Launches a fresh pi instance in the new pane
3. **Sends your prompt** - Submits the task and waits for completion
4. **Reads the response** - Gets the agent's output
5. **Cleans up** - Closes the pane and stops the agent automatically

## Requirements

- Pi must be running inside a Herdr-managed pane (`HERDR_ENV=1`)
- Herdr must be installed and running

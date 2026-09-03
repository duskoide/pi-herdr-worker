---
name: herdr-worker
description: Spawns one-shot pi subagents in new Herdr tabs (worker_delegate) or temporary pi agents in split panes (spawn_pi) for isolated, parallel work. Use when a task benefits from a fresh context, parallel investigations, or a specialized persona defined in .pi/agents/<role>.md.
---

# Herdr Spawn

This extension adds two always-available tools for delegating work to pi subagents that run in Herdr-managed panes:

- **`worker_delegate`** — spawn a fresh one-shot pi subagent in its own Herdr tab. Best for implementation, testing, and review work that benefits from a clean context window. Multiple disjoint-path delegations run concurrently (up to `max-concurrent`).
- **`spawn_pi`** — spawn a temporary pi agent in a split pane. Best for short-lived, independent tasks that don't need a coordinated plan.

Both tools require `HERDR_ENV=1` (pi must be running inside a Herdr-managed pane).

## Quick start

```text
worker_delegate({ prompt: "Implement the API and tests", paths: ["src/api.ts", "tests/api.test.ts"] })
worker_delegate({ prompt: "Review the auth module", role: "reviewer" })
spawn_pi({ prompt: "Run npm test and report failures" })
```

The extension is loaded at session start. No mode toggle is required — `worker_delegate` and `spawn_pi` are available from the first turn. The pi system prompt is augmented with a concise primer that names the tools and when to use them; the tool descriptions cover the parameter details.

## When to delegate

Reach for `worker_delegate` when:

- the task is implementation, testing, or review work that benefits from isolation,
- independent tasks can run in parallel — pass **disjoint** `paths` and the scheduler runs them concurrently (up to `max-concurrent`),
- the user's request maps cleanly to a persona defined in `.pi/agents/<role>.md` (call with `role: "<name>"`).

For short single-prompt one-offs, `spawn_pi` is faster because the pane closes as soon as the response lands.

For tasks where you'd rather keep working in your own context, just keep going with the built-in tools — the orchestrator is the regular session.

## Concurrency and paths

`worker_delegate` accepts a `paths` array. Tasks with **disjoint** `paths` may run on separate subagents in parallel, bounded by `max-concurrent` in settings. Tasks with **overlapping** `paths`, or with no `paths`, are exclusive and serialize. Treat shared configuration, lockfiles, and broad test/build commands as exclusive by omitting `paths`.

## Roles

Role files live in `.pi/agents/<role>.md` (project), `.agents/agents/<role>.md` (workspace), and `~/.pi/agent/agents/<role>.md` (global); project wins. A role supplies a custom system prompt and optional `model`, `thinking`, and `tools` for the spawned subagent. Pick one per delegation:

```text
worker_delegate({ prompt: "Implement the API and tests", role: "impl" })
worker_delegate({ prompt: "Review the auth module", role: "reviewer" })
```

Set a default with `/worker-config default-role <name>` so role-less delegations still pick a persona.

```markdown
---
description: Reviews code for correctness, security, and conventions
model: anthropic/claude-sonnet-4-5
thinking: medium
tools: read, bash, grep, find, ls
prompt_mode: append
---

You are a senior code reviewer. Focus on correctness, security, and
adherence to project conventions. Report findings as a numbered list.
```

`prompt_mode: replace` (default) makes the body the entire subagent system prompt. `prompt_mode: append` keeps the built-in worker preamble ("you are a one-time worker spawned by a parent pi session…") and adds the role body on top.

An unknown role name falls back to the built-in generic worker with a warning.

## Worker prompts must be self-contained

A subagent has no memory of the parent session. Every `prompt` must include the task, the relevant files, the desired behavior, and how to validate. The orchestrator reads only the worker's most recent output, so end the prompt with a clear ask for a self-contained final report.

## Configuration

```text
/worker-config                       # open the interactive settings UI
/worker-config show
/worker-config default-role <role>
/worker-config max-concurrent <n>
/worker-config worker-model <provider/model>
/worker-config worker-thinking <off|minimal|low|medium|high|xhigh|max>
/worker-config roles
/worker-config reset
```

Worker model/thinking, the default role, and max-concurrent persist in the global Pi `settings.json` under `herdrWorker`; inherited values remain omitted.

The interactive UI lets you pick the subagent model and thinking level (with an inherit-from-parent option), pick the default role, set `max-concurrent`, and reset all overrides. Ctrl+S saves; Esc discards the draft.

## Lifecycle

Each owned subagent tab closes when its delegation completes — including on session shutdown. Queued delegations are rejected on shutdown. Delegations use argument-safe Herdr process calls (`execFile`, no shell) and have a default timeout of five minutes; pass `timeout` (ms) to override per call.

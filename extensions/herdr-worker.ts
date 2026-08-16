import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  Key,
  matchesKey,
  SelectList,
  type SelectItem,
  type SettingItem,
  SettingsList,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Mode = "regular" | "brain";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_ORDER: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const THINKING_LEVELS = new Set<ThinkingLevel>(THINKING_ORDER);

const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "bash",
  "apply_patch",
  "patch",
  "delete",
  "move",
]);

const WorkerDelegateInput = Type.Object({
  prompt: Type.String({ description: "A complete implementation, testing, or review task for the spawned worker" }),
  timeout: Type.Optional(Type.Number({ description: "Worker timeout in milliseconds (default: 300000)" })),
  closeAfter: Type.Optional(
    Type.Boolean({
      description:
        "When true, close the worker and its Herdr pane after this task completes. The next delegation spawns a fresh worker. Default: false (worker stays alive for reuse).",
    }),
  ),
});

type WorkerDelegateArgs = {
  prompt: string;
  timeout?: number;
  closeAfter?: boolean;
};

type WorkerHandle = {
  name: string;
  paneId: string;
};

type WorkerConfig = {
  mode: Mode;
  brainModel?: string;
  brainThinking?: ThinkingLevel;
  workerModel?: string;
  workerThinking?: ThinkingLevel;
};

const DEFAULT_WORKER_TIMEOUT = 300000;
const WORKER_SYSTEM_PROMPT = [
  "You are the implementation worker for a parent pi session.",
  "The parent session is the orchestrator. Execute the delegated task directly in this repository.",
  "You may inspect files, edit source, run tests, and validate the result.",
  "Do not delegate work to another agent and do not use worker-mode commands.",
  "Return a concise report containing changes made, validation performed, and any blockers.",
].join(" ");

function runHerdr(args: string[], timeout = 30000): string {
  return execFileSync("herdr", args, {
    encoding: "utf8",
    timeout,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A freshly split pane is not immediately an available shell; Herdr reports
// agent_pane_busy until the shell reaches its interactive prompt. Retry the
// start for a few seconds before giving up.
async function waitForShell(startArgs: string[], paneId: string, attempts = 25, delayMs = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      runHerdr(startArgs);
      return;
    } catch (error: any) {
      const message = error.message ?? "";
      if (!message.includes("agent_pane_busy") && !message.includes("not an available shell")) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
  throw new Error(`Herdr pane ${paneId} never became an available shell.`);
}

function parseJson<T>(output: string): T {
  return JSON.parse(output) as T;
}

function currentModelId(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function describeConfig(config: WorkerConfig, worker: WorkerHandle | undefined, ctx: ExtensionContext): string {
  return [
    `mode: ${config.mode}`,
    `brain model: ${config.brainModel ?? currentModelId(ctx) ?? "current"}`,
    `brain thinking: ${config.brainThinking ?? ctx.thinkingLevel ?? "current"}`,
    `worker model: ${config.workerModel ?? currentModelId(ctx) ?? "parent model"}`,
    `worker thinking: ${config.workerThinking ?? ctx.thinkingLevel ?? "parent level"}`,
    `worker: ${worker ? `${worker.name} (${worker.paneId})` : "not running"}`,
    "",
    "Run /worker-config with no arguments to open the interactive settings UI, or use:",
    "/worker-config mode regular|brain",
    "/worker-config brain-model <provider/model>",
    "/worker-config brain-thinking <off|minimal|low|medium|high|xhigh|max>",
    "/worker-config worker-model <provider/model>",
    "/worker-config worker-thinking <off|minimal|low|medium|high|xhigh|max>",
  ].join("\n");
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
  ctx.ui.notify(message, level);
}

function applyStatus(ctx: ExtensionContext, config: WorkerConfig, worker: WorkerHandle | undefined) {
  ctx.ui.setStatus(
    "herdr-worker",
    `${config.mode === "brain" ? "BRAIN" : "REGULAR"}${worker ? ` · ${worker.name}` : ""}`,
  );
}

function findModel(ctx: ExtensionContext, requested: string) {
  const exact = requested.includes("/") ? requested.split("/", 2) : undefined;
  if (exact) return ctx.modelRegistry.find(exact[0]!, exact[1]!);

  return ctx.modelRegistry.getAvailable().find((model) => model.id === requested);
}

function modelArgument(ctx: ExtensionContext, configured: string | undefined): string | undefined {
  return configured ?? currentModelId(ctx);
}

function validThinking(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.has(value as ThinkingLevel);
}

function closeWorker(worker: WorkerHandle | undefined) {
  if (!worker) return;
  try {
    runHerdr(["pane", "close", worker.paneId]);
  } catch {
    // The pane may already have been closed by Herdr or the user.
  }
}

export default function herdrSpawn(pi: ExtensionAPI) {
  // This state intentionally lives only in the extension instance. It resets to
  // regular mode whenever pi opens, reloads, or switches sessions.
  const config: WorkerConfig = { mode: "regular" };
  let worker: WorkerHandle | undefined;
  let workerQueue: Promise<unknown> = Promise.resolve();

  const stopWorker = async (ctx?: ExtensionContext) => {
    const active = worker;
    worker = undefined;
    closeWorker(active);
    if (ctx) applyStatus(ctx, config, worker);
  };

  const startWorker = async (ctx: ExtensionContext): Promise<WorkerHandle> => {
    if (process.env.HERDR_ENV !== "1") {
      throw new Error("Brain mode requires pi to run inside a Herdr-managed pane (HERDR_ENV=1).");
    }
    if (worker) return worker;

    const current = parseJson<{ result?: { pane?: { pane_id?: string } } }>(
      runHerdr(["pane", "current", "--current"]),
    );
    if (!current.result?.pane?.pane_id) throw new Error("Could not determine the current Herdr pane.");

    const split = parseJson<{ result?: { pane?: { pane_id?: string } } }>(
      runHerdr(["pane", "split", "--current", "--direction", "right", "--cwd", ctx.cwd, "--no-focus"]),
    );
    const paneId = split.result?.pane?.pane_id;
    if (!paneId) throw new Error("Could not create a Herdr worker pane.");

    const name = `pi-worker-${Date.now().toString(36)}`;
    const startArgs = ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--"];
    const model = modelArgument(ctx, config.workerModel);
    if (model) startArgs.push("--model", model);
    if (config.workerThinking ?? ctx.thinkingLevel) startArgs.push("--thinking", config.workerThinking ?? ctx.thinkingLevel);
    startArgs.push("--append-system-prompt", WORKER_SYSTEM_PROMPT);

    try {
      await waitForShell(startArgs, paneId);
    } catch (error) {
      closeWorker({ name, paneId });
      throw error;
    }

    worker = { name, paneId };
    applyStatus(ctx, config, worker);
    return worker;
  };

  const delegate = async (ctx: ExtensionContext, args: WorkerDelegateArgs) => {
    if (config.mode !== "brain") {
      throw new Error("Brain mode is not active. Run /worker-config mode brain first.");
    }
    if (!args.prompt.trim()) throw new Error("A worker prompt is required.");

    const run = workerQueue.then(async () => {
      const active = await startWorker(ctx);
      const timeout = args.timeout ?? DEFAULT_WORKER_TIMEOUT;
      runHerdr(["agent", "prompt", active.name, args.prompt, "--wait", "--timeout", String(timeout)], timeout + 30000);
      const report = runHerdr(["agent", "read", active.name, "--source", "recent-unwrapped", "--lines", "200"]);
      // Optionally tear down the worker (agent + Herdr pane) once the task is done.
      // The next delegation will spawn a fresh worker on demand.
      if (args.closeAfter) await stopWorker(ctx);
      return report;
    });
    workerQueue = run.catch(() => undefined);
    return run;
  };

  const setBrainModel = async (requested: string, ctx: ExtensionContext) => {
    const model = findModel(ctx, requested);
    if (!model) throw new Error(`Model not found: ${requested}`);
    if (!(await pi.setModel(model))) throw new Error(`Pi could not authenticate model: ${requested}`);
    config.brainModel = `${model.provider}/${model.id}`;
  };

  const setMode = async (mode: Mode, ctx: ExtensionContext) => {
    if (mode === config.mode) {
      if (mode === "brain") await startWorker(ctx);
      applyStatus(ctx, config, worker);
      return;
    }

    if (mode === "brain") {
      config.mode = "brain";
      try {
        await startWorker(ctx);
      } catch (error: any) {
        config.mode = "regular";
        applyStatus(ctx, config, worker);
        throw new Error(error.message);
      }
      notify(
        ctx,
        "Brain mode enabled. This session is now the orchestrator (brain): plan and delegate all implementation and validation to the spawned worker with worker_delegate. Your own mutation tools are blocked.",
      );
    } else {
      config.mode = "regular";
      await stopWorker(ctx);
      notify(ctx, "Regular mode enabled. This session works directly again; the worker and its Herdr pane have been closed.");
    }
    applyStatus(ctx, config, worker);
  };

  const setBrainThinking = (level: ThinkingLevel) => {
    pi.setThinkingLevel(level);
    config.brainThinking = level;
  };

  // Apply a worker model/thinking change and restart the worker if it is live,
  // so the new settings take effect on the next delegation.
  const applyWorkerSetting = async (
    key: "worker-model" | "worker-thinking",
    value: string,
    ctx: ExtensionContext,
  ) => {
    if (key === "worker-model") config.workerModel = value;
    else config.workerThinking = value as ThinkingLevel;
    if (config.mode === "brain") {
      await stopWorker(ctx);
      await startWorker(ctx);
    }
  };

  // A SelectList wrapped with a live search box. Typing filters items by
  // substring (case-insensitive) against the label; backspace edits the query.
  // Navigation/confirm/cancel keys pass through to the underlying list.
  const searchableSelect = (
    allItems: SelectItem[],
    current: string,
    done: (selected?: string) => void,
  ): Component => {
    let query = "";
    const theme = getSelectListTheme();

    const filtered = (): SelectItem[] => {
      if (!query) return allItems;
      const needle = query.toLowerCase();
      return allItems.filter(
        (item) =>
          item.label.toLowerCase().includes(needle) ||
          item.value.toLowerCase().includes(needle),
      );
    };

    let list = new SelectList(allItems, Math.min(allItems.length, 12), theme);
    const preselect = allItems.findIndex((item) => item.value === current);
    if (preselect >= 0) list.setSelectedIndex(preselect);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(undefined);

    const rebuild = () => {
      const items = filtered();
      list = new SelectList(items, Math.min(Math.max(items.length, 1), 12), theme);
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(undefined);
    };

    return {
      render(width: number): string[] {
        const label = query.length ? query : "(type to search)";
        const searchLine = truncateToWidth(`  🔍 ${label}`, width);
        return [searchLine, ...list.render(width)];
      },
      invalidate() {
        list.invalidate();
      },
      handleInput(data: string) {
        // Backspace edits the query.
        if (matchesKey(data, Key.backspace)) {
          if (query.length) {
            query = query.slice(0, -1);
            rebuild();
          }
          return;
        }
        // Printable single characters extend the query. Navigation, enter, and
        // escape (multi-byte or control sequences) fall through to the list.
        if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) !== 127) {
          query += data;
          rebuild();
          return;
        }
        list.handleInput(data);
      },
    };
  };

  // Build a SelectList submenu factory for picking a model from the registry.
  const modelSubmenu =
    (ctx: ExtensionContext, includeInherit: boolean) =>
    (current: string, done: (selected?: string) => void): Component => {
      const available = ctx.modelRegistry.getAvailable();
      const items: SelectItem[] = [];
      if (includeInherit) {
        items.push({
          value: "__inherit__",
          label: "(inherit brain model)",
          description: "Use the same model as the brain session",
        });
      }
      for (const model of available) {
        const id = `${model.provider}/${model.id}`;
        items.push({ value: id, label: id, description: model.provider });
      }

      return searchableSelect(items, current, done);
    };

  // Build a SelectList submenu factory for picking a thinking level.
  const thinkingSubmenu =
    (includeInherit: boolean) =>
    (current: string, done: (selected?: string) => void): Component => {
      const items: SelectItem[] = [];
      if (includeInherit) {
        items.push({
          value: "__inherit__",
          label: "(inherit brain level)",
          description: "Use the same thinking level as the brain session",
        });
      }
      for (const level of THINKING_ORDER) items.push({ value: level, label: level });

      const list = new SelectList(items, items.length, getSelectListTheme());
      const currentIndex = items.findIndex((item) => item.value === current);
      if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(undefined);
      return list;
    };

  const openSettingsUI = async (ctx: ExtensionContext) => {
    // Draft state: edits are collected here and only applied to the live config
    // (and the worker) when the user presses Ctrl+S. Esc discards the draft.
    type Draft = {
      mode: Mode;
      brainModel?: string;
      brainThinking?: ThinkingLevel;
      workerModel?: string;
      workerThinking?: ThinkingLevel;
    };
    const draft: Draft = {
      mode: config.mode,
      brainModel: config.brainModel,
      brainThinking: config.brainThinking,
      workerModel: config.workerModel,
      workerThinking: config.workerThinking,
    };

    const brainModelDisplay = () => draft.brainModel ?? currentModelId(ctx) ?? "current";
    const brainThinkingDisplay = () => draft.brainThinking ?? ctx.thinkingLevel ?? "current";
    const workerModelDisplay = () => draft.workerModel ?? "(inherit brain model)";
    const workerThinkingDisplay = () => draft.workerThinking ?? "(inherit brain level)";

    const isDirty = () =>
      draft.mode !== config.mode ||
      draft.brainModel !== config.brainModel ||
      draft.brainThinking !== config.brainThinking ||
      draft.workerModel !== config.workerModel ||
      draft.workerThinking !== config.workerThinking;

    // Apply the draft to the live config and reconcile the worker/model/thinking.
    const saveDraft = async () => {
      // Brain model: authenticate and switch the current session's model.
      if (draft.brainModel !== config.brainModel && draft.brainModel) {
        await setBrainModel(draft.brainModel, ctx);
      }
      // Brain thinking level applies to this session.
      if (draft.brainThinking !== config.brainThinking && draft.brainThinking) {
        setBrainThinking(draft.brainThinking);
      }

      // Worker model/thinking only change stored config here; the worker is
      // restarted once below if anything worker-affecting changed.
      const workerChanged =
        draft.workerModel !== config.workerModel || draft.workerThinking !== config.workerThinking;
      config.workerModel = draft.workerModel;
      config.workerThinking = draft.workerThinking;

      // Mode change spawns or tears down the worker as needed.
      if (draft.mode !== config.mode) {
        await setMode(draft.mode, ctx);
      } else if (workerChanged && config.mode === "brain") {
        // Same mode but worker settings changed: restart the live worker so the
        // new model/thinking take effect on the next delegation.
        await stopWorker(ctx);
        await startWorker(ctx);
      }

      applyStatus(ctx, config, worker);
    };

    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      const container = new Container();
      const header = new Text(theme.fg("accent", theme.bold("Herdr Worker Settings")), 1, 1);
      container.addChild(header);

      const items: SettingItem[] = [
        {
          id: "mode",
          label: "Mode",
          description: "regular = work directly; brain = orchestrate a spawned worker",
          currentValue: draft.mode,
          values: ["regular", "brain"],
        },
        {
          id: "brain-model",
          label: "Brain model",
          description: "Model for this orchestrator session (enter to pick)",
          currentValue: brainModelDisplay(),
          submenu: modelSubmenu(ctx, false),
        },
        {
          id: "brain-thinking",
          label: "Brain thinking",
          description: "Thinking level for this orchestrator session",
          currentValue: brainThinkingDisplay(),
          submenu: thinkingSubmenu(false),
        },
        {
          id: "worker-model",
          label: "Worker model",
          description: "Model used by the spawned worker (enter to pick)",
          currentValue: workerModelDisplay(),
          submenu: modelSubmenu(ctx, true),
        },
        {
          id: "worker-thinking",
          label: "Worker thinking",
          description: "Thinking level used by the spawned worker",
          currentValue: workerThinkingDisplay(),
          submenu: thinkingSubmenu(true),
        },
        {
          id: "reset",
          label: "Reset overrides",
          description: "Clear brain/worker model and thinking overrides (in draft)",
          currentValue: "press enter",
          values: ["press enter", "reset"],
        },
      ];

      const helpLine = new Text("", 1, 0);
      const refreshHelp = () => {
        const status = isDirty()
          ? theme.fg("warning", "● unsaved changes")
          : theme.fg("success", "● saved");
        helpLine.setText(
          `${status}  ${theme.fg("dim", "↑↓ navigate · enter cycle/pick · ctrl+s save · esc discard")}`,
        );
      };

      const settingsList = new SettingsList(
        items,
        Math.min(items.length + 2, 15),
        getSettingsListTheme(),
        (id, newValue) => {
          // Mutate the draft only — no live application here.
          if (id === "mode") {
            if (newValue === "regular" || newValue === "brain") draft.mode = newValue;
            settingsList.updateValue("mode", draft.mode);
          } else if (id === "brain-model") {
            draft.brainModel = newValue;
            settingsList.updateValue("brain-model", brainModelDisplay());
          } else if (id === "brain-thinking") {
            if (validThinking(newValue)) draft.brainThinking = newValue;
            settingsList.updateValue("brain-thinking", brainThinkingDisplay());
          } else if (id === "worker-model") {
            draft.workerModel = newValue === "__inherit__" ? undefined : newValue;
            settingsList.updateValue("worker-model", workerModelDisplay());
          } else if (id === "worker-thinking") {
            if (newValue === "__inherit__") draft.workerThinking = undefined;
            else if (validThinking(newValue)) draft.workerThinking = newValue;
            settingsList.updateValue("worker-thinking", workerThinkingDisplay());
          } else if (id === "reset") {
            if (newValue === "reset") {
              draft.brainModel = undefined;
              draft.brainThinking = undefined;
              draft.workerModel = undefined;
              draft.workerThinking = undefined;
              settingsList.updateValue("brain-model", brainModelDisplay());
              settingsList.updateValue("brain-thinking", brainThinkingDisplay());
              settingsList.updateValue("worker-model", workerModelDisplay());
              settingsList.updateValue("worker-thinking", workerThinkingDisplay());
            }
            settingsList.updateValue("reset", "press enter");
          }
          refreshHelp();
          tui.requestRender();
        },
        () => done(undefined),
      );
      container.addChild(settingsList);
      container.addChild(helpLine);
      refreshHelp();

      let saving = false;
      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          // Ctrl+S saves the draft. Intercept before the list so it is not
          // treated as a printable character by an active search box.
          if (matchesKey(data, Key.ctrl("s"))) {
            if (saving || !isDirty()) return;
            saving = true;
            void (async () => {
              try {
                await saveDraft();
                notify(ctx, "Worker settings saved.");
                refreshHelp();
              } catch (error: any) {
                notify(ctx, error.message, "error");
              } finally {
                saving = false;
                tui.requestRender();
              }
            })();
            return;
          }
          settingsList.handleInput?.(data);
          tui.requestRender();
        },
      };
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    config.mode = "regular";
    worker = undefined;
    applyStatus(ctx, config, worker);
    notify(ctx, "Herdr worker ready in regular mode. Use /worker-config mode brain to make this session the orchestrator.");
  });

  pi.on("session_shutdown", async () => {
    closeWorker(worker);
    worker = undefined;
  });

  pi.on("before_agent_start", async (event) => {
    if (config.mode !== "brain") return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nBRAIN MODE (ORCHESTRATOR): This session has switched roles and is now the brain. You must exclusively orchestrate and delegate; you do not do implementation work yourself. Do not use write, edit, bash, apply_patch, patch, delete, or move tools. Delegate all implementation, testing, and other non-trivial work to the spawned worker with worker_delegate, then inspect and summarize the worker's report. Keep delegation prompts complete and specific.`,
    };
  });

  pi.on("tool_call", async (event) => {
    if (config.mode === "brain" && MUTATING_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Blocked in brain mode: ${event.toolName} is a mutation tool. You are the orchestrator — delegate this work to the worker with worker_delegate.`,
      };
    }
  });

  pi.registerCommand("worker-config", {
    description: "Open the worker settings UI, or configure it via subcommands (mode, brain-model, worker-model, thinking, close, reset)",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      // No arguments opens the interactive settings UI.
      if (tokens.length === 0) {
        await openSettingsUI(ctx);
        return;
      }
      if (tokens[0] === "show") {
        notify(ctx, describeConfig(config, worker, ctx));
        return;
      }

      const key = tokens[0]!.toLowerCase();
      const value = tokens.slice(1).join(" ");
      try {
        if (key === "ui") {
          await openSettingsUI(ctx);
          return;
        } else if (key === "mode") {
          if (value !== "regular" && value !== "brain") throw new Error("Usage: /worker-config mode regular|brain");
          await setMode(value, ctx);
        } else if (key === "close" || key === "stop-worker") {
          if (!worker) {
            notify(ctx, "No worker is running.");
          } else {
            const name = worker.name;
            await stopWorker(ctx);
            notify(ctx, `Closed worker ${name} and its Herdr pane. Mode remains ${config.mode}; a new worker spawns on the next delegation.`);
          }
        } else if (key === "brain-model") {
          if (!value) throw new Error("Usage: /worker-config brain-model <provider/model>");
          await setBrainModel(value, ctx);
          notify(ctx, `Brain model set to ${config.brainModel}.`);
        } else if (key === "brain-thinking") {
          if (!validThinking(value)) throw new Error("Usage: /worker-config brain-thinking <off|minimal|low|medium|high|xhigh|max>");
          setBrainThinking(value);
          notify(ctx, `Brain thinking level set to ${value}.`);
        } else if (key === "worker-model" || key === "worker-thinking") {
          if (key === "worker-thinking" && !validThinking(value)) {
            throw new Error("Usage: /worker-config worker-thinking <off|minimal|low|medium|high|xhigh|max>");
          }
          if (!value) throw new Error(`Usage: /worker-config ${key} <value>`);
          await applyWorkerSetting(key, value, ctx);
          notify(ctx, `${key} set to ${value}.`);
        } else if (key === "reset") {
          config.brainModel = undefined;
          config.brainThinking = undefined;
          config.workerModel = undefined;
          config.workerThinking = undefined;
          notify(ctx, "Worker configuration reset. Mode remains unchanged.");
        } else {
          throw new Error("Usage: /worker-config [ui|show|mode|close|brain-model|brain-thinking|worker-model|worker-thinking|reset] ... (run with no arguments to open the settings UI)");
        }
        applyStatus(ctx, config, worker);
      } catch (error: any) {
        notify(ctx, error.message, "error");
      }
    },
  });

  pi.registerTool({
    name: "worker_delegate",
    label: "Worker Delegate",
    description:
      "Delegate implementation, testing, review, or other non-trivial work to the spawned Herdr worker. Use this in brain mode: this session is the orchestrator and does not do the work itself. The worker persists across delegations by default; pass closeAfter: true to close the worker and its Herdr pane once the task completes.",
    parameters: WorkerDelegateInput,
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      try {
        const response = await delegate(ctx, input as WorkerDelegateArgs);
        return {
          content: [{ type: "text", text: response }],
          details: { worker: worker?.name, mode: config.mode },
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: error.message }],
          details: { mode: config.mode },
          isError: true,
        };
      }
    },
  });

  pi.registerCommand("spawn", {
    description: "Spawn a pi agent: /spawn <prompt> [--name <name>] [--model <model>] [--timeout <ms>]",
    handler: async (args, ctx) => {
      try {
        const parsed = parseSpawnArgs(args);
        if (!parsed.prompt) {
          notify(ctx, "Usage: /spawn <prompt> [--name <name>] [--model <model>] [--timeout <ms>]", "error");
          return;
        }
        const result = await runOneShot(parsed.prompt, parsed.name ?? `pi-${Date.now().toString(36)}`, parsed.model, parsed.timeout, ctx.cwd);
        notify(ctx, result, result.startsWith("Failed") ? "error" : "info");
      } catch (error: any) {
        notify(ctx, error.message, "error");
      }
    },
  });

  pi.registerCommand("spawnp", {
    description: "Quick spawn with an auto-generated name: /spawnp <prompt> [--model <model>]",
    handler: async (args, ctx) => {
      try {
        const parsed = parseSpawnArgs(args);
        if (!parsed.prompt) {
          notify(ctx, "Usage: /spawnp <prompt> [--model <model>]", "error");
          return;
        }
        notify(ctx, await runOneShot(parsed.prompt, `pi-${Date.now().toString(36)}`, parsed.model, parsed.timeout, ctx.cwd));
      } catch (error: any) {
        notify(ctx, error.message, "error");
      }
    },
  });

  pi.registerCommand("spawnlist", {
    description: "List currently running Herdr agents",
    handler: async (_args, ctx) => {
      if (process.env.HERDR_ENV !== "1") return notify(ctx, "Not running in Herdr environment.", "error");
      try {
        const parsed = parseJson<{ result?: { agents?: Array<{ name: string; agent_status: string; pane_id: string }> } }>(runHerdr(["agent", "list"]));
        const agents = parsed.result?.agents ?? [];
        notify(ctx, agents.length ? agents.map((agent) => `- ${agent.name} (${agent.agent_status}) in ${agent.pane_id}`).join("\n") : "No agents currently running.");
      } catch (error: any) {
        notify(ctx, `Failed: ${error.message}`, "error");
      }
    },
  });

  pi.registerCommand("spawnkill", {
    description: "Kill a Herdr agent by name: /spawnkill <agent-name>",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) return notify(ctx, "Usage: /spawnkill <agent-name>", "error");
      try {
        const parsed = parseJson<{ result?: { agent?: { pane_id?: string } } }>(runHerdr(["agent", "get", name]));
        const paneId = parsed.result?.agent?.pane_id;
        if (!paneId) throw new Error(`Agent not found: ${name}`);
        closeWorker({ name, paneId });
        if (worker?.name === name) worker = undefined;
        notify(ctx, `Killed agent ${name}.`);
      } catch (error: any) {
        notify(ctx, `Failed: ${error.message}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "spawn_pi",
    label: "Spawn Pi",
    description: "Spawn a temporary pi agent in a new Herdr pane, wait for its response, then clean it up.",
    parameters: Type.Object({
      prompt: Type.String({ description: "The prompt to send" }),
      name: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      timeout: Type.Optional(Type.Number()),
      direction: Type.Optional(Type.Union([Type.Literal("right"), Type.Literal("down")])),
    }),
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      const value = input as { prompt: string; name?: string; model?: string; timeout?: number; direction?: "right" | "down" };
      const name = value.name || `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const response = await runOneShot(value.prompt, name, value.model, value.timeout ?? 120000, ctx.cwd, value.direction ?? "right");
      return { content: [{ type: "text", text: response }], details: { agent_name: name } };
    },
  });
}

function parseSpawnArgs(args: string): { prompt: string; name?: string; model?: string; timeout: number } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const promptTokens: string[] = [];
  let name: string | undefined;
  let model: string | undefined;
  let timeout = 120000;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--name" || token === "--model" || token === "--timeout") {
      const value = tokens[++index];
      if (!value) throw new Error(`${token} requires a value`);
      if (token === "--name") name = value;
      else if (token === "--model") model = value;
      else timeout = Number(value);
    } else {
      promptTokens.push(token);
    }
  }

  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("--timeout must be a positive number");
  return { prompt: promptTokens.join(" "), name, model, timeout };
}

async function runOneShot(prompt: string, name: string, model: string | undefined, timeout: number, cwd: string, direction = "right"): Promise<string> {
  if (process.env.HERDR_ENV !== "1") return "Failed: Not running in Herdr environment. Cannot spawn pane.";
  let paneId: string | undefined;
  try {
    const split = parseJson<{ result?: { pane?: { pane_id?: string } } }>(runHerdr(["pane", "split", "--current", "--direction", direction, "--cwd", cwd, "--no-focus"]));
    paneId = split.result?.pane?.pane_id;
    if (!paneId) throw new Error("Could not create new pane");
    const startArgs = ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--"];
    if (model) startArgs.push("--model", model);
    await waitForShell(startArgs, paneId);
    runHerdr(["agent", "prompt", name, prompt, "--wait", "--timeout", String(timeout)], timeout + 30000);
    const response = runHerdr(["agent", "read", name, "--source", "recent-unwrapped", "--lines", "100"]);
    return `Agent ${name} completed in pane ${paneId}\n\n${response}`;
  } catch (error: any) {
    return `Failed: ${error.message}`;
  } finally {
    if (paneId) {
      try { runHerdr(["pane", "close", paneId]); } catch { /* best effort cleanup */ }
    }
  }
}

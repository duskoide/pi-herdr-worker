import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
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

const BRAIN_ALLOWED_TOOLS = new Set([
  "worker_mode",
  "worker_delegate",
  "read",
  "grep",
  "find",
  "ls",
  "ffgrep",
  "fffind",
  "todo",
  "ask_user_question",
  "graphify_query",
  "graphify_path",
  "graphify_explain",
  "web_search",
  "web_fetch",
  "web_fetch_md",
  "web_docs_search",
  "web_docs_fetch",
  "query-docs",
  "resolve-library-id",
]);

const WORKER_ROLES = ["general", "explore", "plan", "impl", "test", "review", "simplify"] as const;
type WorkerRole = (typeof WORKER_ROLES)[number];

const WorkerDelegateInput = Type.Object({
  prompt: Type.String({ description: "A complete implementation, testing, or review task for the spawned worker" }),
  role: Type.Optional(StringEnum(WORKER_ROLES, { description: "Worker role for this delegation (default: general)" })),
  timeout: Type.Optional(Type.Number({ description: "Worker timeout in milliseconds; defaults to herdr-worker.json" })),
  closeAfter: Type.Optional(
    Type.Boolean({
      description:
        "When true, close the worker and its Herdr pane after this task completes. The next delegation spawns a fresh worker. Default: false (worker stays alive for reuse).",
    }),
  ),
});

type WorkerDelegateArgs = {
  prompt: string;
  role?: WorkerRole;
  timeout?: number;
  closeAfter?: boolean;
};

type WorkerHandle = {
  name: string;
  paneId: string;
  tabId?: string;
};

type WorkerConfig = {
  mode: Mode;
  brainModel?: string;
  brainThinking?: ThinkingLevel;
  workerModel?: string;
  workerThinking?: ThinkingLevel;
};

type DiskWorkerConfig = {
  defaultModel?: string;
  allowedModels?: string[];
  defaultThinking?: ThinkingLevel;
  defaultTimeout?: number;
};

const DEFAULT_WORKER_TIMEOUT = 300000;
const WORKER_SYSTEM_PROMPT = [
  "You are the execution worker for a parent pi session.",
  "The parent session is the orchestrator. Execute each delegated task directly in this repository according to its stated role.",
  "You may inspect files, edit source, run tests, and validate the result when the role permits it.",
  "Do not delegate work to another agent and do not use worker-mode commands.",
  "Return a concise report containing findings or changes, validation performed, and any blockers.",
].join(" ");

const ROLE_PROMPTS: Record<WorkerRole, string> = {
  general: "Complete the delegated objective end to end.",
  explore: "Act as a read-only explorer. Gather evidence and do not modify files.",
  plan: "Act as a planner. Produce a concrete, testable plan and do not modify files.",
  impl: "Act as the implementer. Make only the requested changes and run relevant validation.",
  test: "Act as the test specialist. Exercise the requested behavior, add or fix tests only when requested, and report failures precisely.",
  review: "Act as a read-only reviewer. Identify actionable correctness, security, and regression risks; do not modify files.",
  simplify: "Act as a read-only simplification reviewer. Find unnecessary complexity without changing behavior; do not modify files.",
};

function loadDiskWorkerConfig(): DiskWorkerConfig {
  try {
    const parsed = JSON.parse(readFileSync(join(getAgentDir(), "herdr-worker.json"), "utf8")) as DiskWorkerConfig;
    return {
      defaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel : undefined,
      allowedModels: Array.isArray(parsed.allowedModels)
        ? parsed.allowedModels.filter((value): value is string => typeof value === "string")
        : undefined,
      defaultThinking: parsed.defaultThinking && validThinking(parsed.defaultThinking) ? parsed.defaultThinking : undefined,
      defaultTimeout:
        typeof parsed.defaultTimeout === "number" && Number.isFinite(parsed.defaultTimeout) && parsed.defaultTimeout > 0
          ? parsed.defaultTimeout
          : undefined,
    };
  } catch {
    return {};
  }
}

function runHerdr(args: string[], timeout = 30000): string {
  return execFileSync("herdr", args, {
    encoding: "utf8",
    timeout,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// Commands that create or close panes must not block the interactive TUI.
// Herdr talks to a server over a socket and may wait for shell/agent
// readiness; execFileSync here would make Ctrl+S appear to freeze Pi.
function runHerdrAsync(args: string[], timeout = 30000, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "herdr",
      args,
      { encoding: "utf8", timeout, signal },
      (error, stdout, stderr) => {
        if (error) {
          if (signal?.aborted || error.name === "AbortError") {
            reject(new Error("Herdr operation cancelled."));
            return;
          }
          const details = [String(stderr ?? "").trim(), String(stdout ?? "").trim()].filter(Boolean);
          reject(new Error(details.length ? `${error.message}: ${details.join(" | ")}` : error.message));
        } else {
          resolve(String(stdout));
        }
      },
    );
  });
}

function extractWorkerReport(transcript: string, marker: string): string {
  const plain = transcript
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
  const start = `<<<${marker}_START>>>`;
  const end = `<<<${marker}_END>>>`;
  const startAt = plain.lastIndexOf(start);
  if (startAt >= 0) {
    const reportStart = startAt + start.length;
    const endAt = plain.indexOf(end, reportStart);
    if (endAt >= 0) return plain.slice(reportStart, endAt).trim();
  }

  // A model may omit the requested report markers. Keep the fallback bounded
  // so terminal history, startup banners, and status bars do not flood the
  // brain session's context or make the TUI expensive to render.
  const lines = plain.split("\n");
  return lines.slice(-60).join("\n").trim();
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A freshly split pane is not immediately an available shell; Herdr reports
// agent_pane_busy until the shell reaches its interactive prompt. Retry the
// start for a few seconds before giving up.
async function waitForShell(startArgs: string[], paneId: string, attempts = 25, delayMs = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await runHerdrAsync(startArgs);
      return;
    } catch (error: any) {
      const message = String(error?.message ?? error ?? "").toLowerCase();
      const transientPaneError =
        message.includes("agent_pane_busy") ||
        message.includes("pane_busy") ||
        message.includes("not an available shell") ||
        message.includes("pane is not available") ||
        message.includes("shell is not ready") ||
        message.includes("not ready");
      if (!transientPaneError) {
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
    `worker model: ${config.workerModel ?? config.brainModel ?? currentModelId(ctx) ?? "parent model"}`,
    `worker thinking: ${config.workerThinking ?? config.brainThinking ?? ctx.thinkingLevel ?? "parent level"}`,
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
  const theme = ctx.ui.theme;
  const isBrain = config.mode === "brain";
  const label = theme.fg("muted", "working mode:");
  const mode = isBrain
    ? theme.fg("accent", theme.bold("brain"))
    : theme.fg("success", theme.bold("regular"));
  const workerTag = worker
    ? ` ${theme.fg("muted", "·")} ${theme.fg("warning", "●")} ${theme.fg("muted", worker.name)}`
    : "";
  ctx.ui.setStatus("herdr-worker", `${label} ${mode}${workerTag}`);
}

function findModel(ctx: ExtensionContext, requested: string) {
  const exact = requested.includes("/") ? requested.split("/", 2) : undefined;
  if (exact) return ctx.modelRegistry.find(exact[0]!, exact[1]!);

  return ctx.modelRegistry.getAvailable().find((model) => model.id === requested);
}

function modelArgument(ctx: ExtensionContext, config: WorkerConfig): string | undefined {
  // Worker inheritance must prefer the saved brain override. ctx.model can
  // still expose the previous model during the same command that changed it.
  return config.workerModel ?? config.brainModel ?? currentModelId(ctx);
}

function validThinking(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.has(value as ThinkingLevel);
}

function closeWorker(worker: WorkerHandle | undefined) {
  if (!worker) return;
  try {
    if (worker.tabId) runHerdr(["tab", "close", worker.tabId]);
    else runHerdr(["pane", "close", worker.paneId]);
  } catch {
    // The tab or pane may already have been closed by Herdr or the user.
  }
}

async function closeWorkerAsync(worker: WorkerHandle | undefined): Promise<void> {
  if (!worker) return;
  try {
    if (worker.tabId) await runHerdrAsync(["tab", "close", worker.tabId]);
    else await runHerdrAsync(["pane", "close", worker.paneId]);
  } catch {
    // The tab or pane may already have been closed by Herdr or the user.
  }
}

export default function herdrSpawn(pi: ExtensionAPI) {
  // Mode is session-only, while worker defaults come from the portable config.
  const diskConfig = loadDiskWorkerConfig();
  const config: WorkerConfig = {
    mode: "regular",
    workerModel: diskConfig.defaultModel,
    workerThinking: diskConfig.defaultThinking,
  };
  let worker: WorkerHandle | undefined;
  let workerQueue: Promise<unknown> = Promise.resolve();
  let regularTools: string[] | undefined;

  const applyToolMode = (mode: Mode) => {
    if (mode === "brain") {
      regularTools ??= pi.getActiveTools();
      const active = pi.getActiveTools().filter((name) => BRAIN_ALLOWED_TOOLS.has(name));
      pi.setActiveTools([...new Set([...active, "worker_mode", "worker_delegate"])]);
    } else if (regularTools) {
      pi.setActiveTools(regularTools);
      regularTools = undefined;
    }
  };

  const stopWorker = async (ctx?: ExtensionContext) => {
    const active = worker;
    worker = undefined;
    await closeWorkerAsync(active);
    if (ctx) applyStatus(ctx, config, worker);
  };

  const startWorker = async (ctx: ExtensionContext): Promise<WorkerHandle> => {
    if (process.env.HERDR_ENV !== "1") {
      throw new Error("Brain mode requires pi to run inside a Herdr-managed pane (HERDR_ENV=1).");
    }
    if (worker) return worker;

    const name = `pi-worker-${Date.now().toString(36)}`;
    const created = parseJson<{
      result?: {
        tab?: { tab_id?: string };
        root_pane?: { pane_id?: string };
      };
    }>(await runHerdrAsync(["tab", "create", "--cwd", ctx.cwd, "--label", name, "--no-focus"]));
    const tabId = created.result?.tab?.tab_id;
    const paneId = created.result?.root_pane?.pane_id;
    if (!tabId || !paneId) throw new Error("Could not create a Herdr worker tab.");
    const startArgs = ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--"];
    const model = modelArgument(ctx, config);
    const thinking = config.workerThinking ?? config.brainThinking ?? ctx.thinkingLevel;
    if (model && !workerModelAllowed(model)) {
      await closeWorkerAsync({ name, paneId, tabId });
      throw new Error(`Worker model is not allowed by herdr-worker.json: ${model}`);
    }
    if (model) startArgs.push("--model", model);
    if (thinking) startArgs.push("--thinking", thinking);
    startArgs.push("--append-system-prompt", WORKER_SYSTEM_PROMPT);

    try {
      await waitForShell(startArgs, paneId);
    } catch (error: any) {
      await closeWorkerAsync({ name, paneId, tabId });
      const detail = String(error?.message ?? error ?? "");
      throw new Error(
        `Could not start worker ${name} with model ${model ?? "default"} and thinking ${thinking ?? "default"}: ${detail}`,
      );
    }

    worker = { name, paneId, tabId };
    applyStatus(ctx, config, worker);
    return worker;
  };

  const delegate = async (
    ctx: ExtensionContext,
    args: WorkerDelegateArgs,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
  ) => {
    if (config.mode !== "brain") await setMode("brain", ctx);
    if (!args.prompt.trim()) throw new Error("A worker prompt is required.");
    if (signal?.aborted) throw new Error("Worker delegation cancelled.");
    onUpdate?.({
      content: [{ type: "text", text: "Delegation queued for the persistent worker…" }],
      details: { role: args.role ?? "general", state: "queued" },
    });

    const run = workerQueue.then(async () => {
      if (signal?.aborted) throw new Error("Worker delegation cancelled.");
      onUpdate?.({ content: [{ type: "text", text: "Starting delegated worker task…" }] });
      const active = await startWorker(ctx);
      const timeout = args.timeout ?? diskConfig.defaultTimeout ?? DEFAULT_WORKER_TIMEOUT;
      const role = args.role ?? "general";
      const marker = `HERDR_REPORT_${Date.now().toString(36)}`;
      const rolePrompt = [
        `ROLE: ${role}. ${ROLE_PROMPTS[role]}`,
        "",
        "TASK:",
        args.prompt,
        "",
        "RESPONSE FORMAT:",
        `End with a concise final report. Begin it with the exact token formed by joining "<<<", "${marker}_START", and ">>>".`,
        `End it with the exact token formed by joining "<<<", "${marker}_END", and ">>>".`,
        "Put only the useful result, validation evidence, and remaining caveats between those tokens.",
      ].join("\n");
      onUpdate?.({
        content: [{ type: "text", text: `Worker ${active.name} is running the ${role} delegation…` }],
        details: { worker: active.name, role, state: "working" },
      });
      const interruptWorker = () => {
        void runHerdrAsync(["agent", "send-keys", active.name, "ctrl+c"], 5000).catch(() => undefined);
      };
      signal?.addEventListener("abort", interruptWorker, { once: true });
      try {
        await runHerdrAsync(
          ["agent", "prompt", active.name, rolePrompt, "--wait", "--timeout", String(timeout)],
          timeout + 30000,
          signal,
        );
      } finally {
        signal?.removeEventListener("abort", interruptWorker);
      }
      if (signal?.aborted) throw new Error("Worker delegation cancelled.");
      onUpdate?.({
        content: [{ type: "text", text: `Worker ${active.name} finished; collecting its final report…` }],
        details: { worker: active.name, role, state: "collecting" },
      });
      const transcript = await runHerdrAsync(
        ["agent", "read", active.name, "--source", "recent-unwrapped", "--lines", "120"],
        30000,
        signal,
      );
      const report = extractWorkerReport(transcript, marker);
      if (!report) throw new Error(`Worker ${active.name} completed without a readable report.`);
      // Optionally tear down the worker (agent + Herdr tab) once the task is done.
      // The next delegation will spawn a fresh worker on demand.
      if (args.closeAfter) await stopWorker(ctx);
      return report;
    });
    workerQueue = run.catch(() => undefined);
    return run;
  };

  function workerModelAllowed(requested: string): boolean {
    const allowed = diskConfig.allowedModels;
    if (!allowed?.length) return true;
    const bare = requested.includes("/") ? requested.split("/", 2)[1]! : requested;
    return allowed.some((value) => value === requested || value === bare || value.endsWith(`/${bare}`));
  }

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
      applyToolMode("brain");
      try {
        await startWorker(ctx);
      } catch (error: any) {
        config.mode = "regular";
        applyToolMode("regular");
        applyStatus(ctx, config, worker);
        throw new Error(error.message);
      }
      notify(
        ctx,
        "Brain mode enabled. This session is now the orchestrator (brain): plan and delegate all implementation and validation to the persistent worker with worker_delegate. Only approved coordination and read-only tools remain active.",
      );
    } else {
      config.mode = "regular";
      applyToolMode("regular");
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
    if (key === "worker-model") {
      if (!workerModelAllowed(value)) throw new Error(`Worker model is not allowed by herdr-worker.json: ${value}`);
      if (!findModel(ctx, value)) throw new Error(`Model not found: ${value}`);
      config.workerModel = value;
    } else {
      config.workerThinking = value as ThinkingLevel;
    }
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
        if (includeInherit && !workerModelAllowed(id)) continue;
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
      const brainModelChanged = draft.brainModel !== config.brainModel;
      const brainThinkingChanged = draft.brainThinking !== config.brainThinking;

      // Brain model: authenticate and switch the current session's model.
      if (brainModelChanged) {
        if (draft.brainModel) await setBrainModel(draft.brainModel, ctx);
        else config.brainModel = undefined;
      }
      // Brain thinking level applies to this session. Resetting the override
      // deliberately leaves the current Pi level unchanged, but restores
      // inheritance for future worker starts.
      if (draft.brainThinking !== config.brainThinking) {
        if (draft.brainThinking) setBrainThinking(draft.brainThinking);
        else config.brainThinking = undefined;
      }

      const workerChanged =
        draft.workerModel !== config.workerModel || draft.workerThinking !== config.workerThinking;
      if (draft.workerModel && !workerModelAllowed(draft.workerModel)) {
        throw new Error(`Worker model is not allowed by herdr-worker.json: ${draft.workerModel}`);
      }
      const inheritedWorkerChanged =
        (draft.workerModel === undefined && brainModelChanged) ||
        (draft.workerThinking === undefined && brainThinkingChanged);
      config.workerModel = draft.workerModel;
      config.workerThinking = draft.workerThinking;

      // Mode change spawns or tears down the worker as needed.
      if (draft.mode !== config.mode) {
        await setMode(draft.mode, ctx);
      } else if ((workerChanged || inheritedWorkerChanged) && config.mode === "brain") {
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
      let saving = false;
      const refreshHelp = () => {
        const status = saving
          ? theme.fg("accent", "◌ saving…")
          : isDirty()
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
              draft.workerModel = diskConfig.defaultModel;
              draft.workerThinking = diskConfig.defaultThinking;
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

      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          // Ctrl+S saves the draft. Intercept before the list so it is not
          // treated as a printable character by an active search box.
          if (matchesKey(data, Key.ctrl("s"))) {
            if (saving || !isDirty()) return;
            saving = true;
            refreshHelp();
            tui.requestRender();
            void (async () => {
              try {
                await saveDraft();
                notify(ctx, "Worker settings saved.");
              } catch (error: any) {
                notify(ctx, error.message, "error");
              } finally {
                saving = false;
                refreshHelp();
                tui.requestRender();
              }
            })();
            return;
          }
          if (saving) return;
          settingsList.handleInput?.(data);
          tui.requestRender();
        },
      };
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    config.mode = "regular";
    config.workerModel = diskConfig.defaultModel;
    config.workerThinking = diskConfig.defaultThinking;
    worker = undefined;
    regularTools = undefined;
    applyStatus(ctx, config, worker);
    notify(ctx, "Herdr worker ready in regular mode. The agent can enter brain mode with worker_mode or automatically through worker_delegate; /worker-config remains available for manual control.");
  });

  pi.on("session_shutdown", async () => {
    closeWorker(worker);
    worker = undefined;
  });

  pi.on("before_agent_start", async (event) => {
    if (config.mode !== "brain") return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nBRAIN MODE (ORCHESTRATOR): This session has switched roles and is now the brain. You must exclusively orchestrate and delegate; you do not perform implementation or other non-trivial work yourself. Use only the currently available coordination and read-only tools. Delegate implementation, testing, and other non-trivial work to the persistent worker with worker_delegate, using its role field and a complete, specific prompt. Inspect each report, delegate corrections when needed, and summarize verified results. Use worker_mode to return to regular mode when orchestration is complete.`,
    };
  });

  pi.on("tool_call", async (event) => {
    if (config.mode === "brain" && !BRAIN_ALLOWED_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Blocked in brain mode: ${event.toolName} is not an approved orchestration/read-only tool. Delegate the work with worker_delegate or return to regular mode with worker_mode.`,
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
            notify(ctx, `Closed worker ${name} and its Herdr tab. Mode remains ${config.mode}; a new worker spawns on the next delegation.`);
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
          config.workerModel = diskConfig.defaultModel;
          config.workerThinking = diskConfig.defaultThinking;
          notify(ctx, "Worker configuration reset to herdr-worker.json defaults. Mode remains unchanged.");
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
    name: "worker_mode",
    label: "Worker Mode",
    description:
      "Enter or leave brain/orchestrator mode without requiring a slash command, inspect status, or close the live worker. Enter brain mode before executing a worker-driven plan.",
    promptSnippet: "Switch this session between direct work and brain/orchestrator mode",
    promptGuidelines: [
      "Use worker_mode with mode brain when the user selects worker-driven execution; no slash command is required.",
      "Use worker_mode with mode regular when delegated execution is complete and direct work should resume.",
    ],
    parameters: Type.Object({
      action: StringEnum(["brain", "regular", "status", "close"] as const),
    }),
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      const action = (input as { action: "brain" | "regular" | "status" | "close" }).action;
      if (action === "brain" || action === "regular") await setMode(action, ctx);
      else if (action === "close") await stopWorker(ctx);
      return {
        content: [{ type: "text", text: describeConfig(config, worker, ctx) }],
        details: { mode: config.mode, worker: worker?.name },
      };
    },
  });

  pi.registerTool({
    name: "worker_delegate",
    label: "Worker Delegate",
    description:
      "Delegate implementation, testing, review, or other non-trivial work to the spawned Herdr worker. If needed, this safely enters brain mode first, so no slash command is required. The worker persists across delegations by default; pass closeAfter: true to close the worker and its Herdr tab once the task completes.",
    promptSnippet: "Delegate a role-specific task to the persistent Herdr worker; automatically enters brain mode",
    promptGuidelines: [
      "Use worker_delegate for the entire approved worker-driven plan; it automatically enters brain mode when necessary.",
      "Give worker_delegate one coherent objective, an explicit role, relevant files, constraints, and validation commands.",
    ],
    parameters: WorkerDelegateInput,
    async execute(_toolCallId, input, signal, onUpdate, ctx) {
      const response = await delegate(ctx, input as WorkerDelegateArgs, signal, onUpdate);
      return {
        content: [{ type: "text", text: response }],
        details: { worker: worker?.name, mode: config.mode },
      };
    },
  });

  pi.registerCommand("spawn", {
    description: "Spawn a Pi agent in a temporary tab: /spawn <prompt> [--name <name>] [--model <model>] [--thinking <level>] [--timeout <ms>]",
    handler: async (args, ctx) => {
      try {
        const parsed = parseSpawnArgs(args);
        if (!parsed.prompt) {
          notify(ctx, "Usage: /spawn <prompt> [--name <name>] [--model <model>] [--thinking <level>] [--timeout <ms>]", "error");
          return;
        }
        const selectedModel = parsed.model ?? diskConfig.defaultModel;
        if (selectedModel && !workerModelAllowed(selectedModel)) {
          throw new Error(`Worker model is not allowed by herdr-worker.json: ${selectedModel}`);
        }
        const result = await runOneShot(
          parsed.prompt,
          parsed.name ?? `pi-${Date.now().toString(36)}`,
          selectedModel,
          parsed.thinking ?? diskConfig.defaultThinking,
          parsed.timeout ?? diskConfig.defaultTimeout ?? 120000,
          ctx.cwd,
        );
        notify(ctx, result, "info");
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
        const selectedModel = parsed.model ?? diskConfig.defaultModel;
        if (selectedModel && !workerModelAllowed(selectedModel)) {
          throw new Error(`Worker model is not allowed by herdr-worker.json: ${selectedModel}`);
        }
        notify(
          ctx,
          await runOneShot(
            parsed.prompt,
            `pi-${Date.now().toString(36)}`,
            selectedModel,
            parsed.thinking ?? diskConfig.defaultThinking,
            parsed.timeout ?? diskConfig.defaultTimeout ?? 120000,
            ctx.cwd,
          ),
        );
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
    description: "Spawn a temporary pi agent in a new Herdr tab, wait for its response, then clean it up.",
    parameters: Type.Object({
      prompt: Type.String({ description: "The prompt to send" }),
      name: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(StringEnum(THINKING_ORDER, { description: "Thinking level override" })),
      timeout: Type.Optional(Type.Number()),
      direction: Type.Optional(Type.Union([Type.Literal("right"), Type.Literal("down")], { description: "Deprecated compatibility field; temporary agents now always use a new tab" })),
    }),
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      const value = input as { prompt: string; name?: string; model?: string; thinking?: ThinkingLevel; timeout?: number; direction?: "right" | "down" };
      const name = value.name || `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const selectedModel = value.model ?? diskConfig.defaultModel;
      if (selectedModel && !workerModelAllowed(selectedModel)) {
        throw new Error(`Worker model is not allowed by herdr-worker.json: ${selectedModel}`);
      }
      const response = await runOneShot(
        value.prompt,
        name,
        selectedModel,
        value.thinking ?? diskConfig.defaultThinking,
        value.timeout ?? diskConfig.defaultTimeout ?? 120000,
        ctx.cwd,
      );
      return { content: [{ type: "text", text: response }], details: { agent_name: name } };
    },
  });
}

function parseSpawnArgs(args: string): { prompt: string; name?: string; model?: string; thinking?: ThinkingLevel; timeout?: number } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const promptTokens: string[] = [];
  let name: string | undefined;
  let model: string | undefined;
  let thinking: ThinkingLevel | undefined;
  let timeout: number | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--name" || token === "--model" || token === "--thinking" || token === "--timeout") {
      const value = tokens[++index];
      if (!value) throw new Error(`${token} requires a value`);
      if (token === "--name") name = value;
      else if (token === "--model") model = value;
      else if (token === "--thinking") {
        if (!validThinking(value)) throw new Error(`Invalid thinking level: ${value}`);
        thinking = value;
      } else timeout = Number(value);
    } else {
      promptTokens.push(token);
    }
  }

  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
    throw new Error("--timeout must be a positive number");
  }
  return { prompt: promptTokens.join(" "), name, model, thinking, timeout };
}

async function runOneShot(
  prompt: string,
  name: string,
  model: string | undefined,
  thinking: ThinkingLevel | undefined,
  timeout: number,
  cwd: string,
): Promise<string> {
  if (process.env.HERDR_ENV !== "1") throw new Error("Not running in Herdr environment. Cannot spawn worker tab.");
  let paneId: string | undefined;
  let tabId: string | undefined;
  try {
    const created = parseJson<{ result?: { tab?: { tab_id?: string }; root_pane?: { pane_id?: string } } }>(
      runHerdr(["tab", "create", "--cwd", cwd, "--label", name, "--no-focus"]),
    );
    tabId = created.result?.tab?.tab_id;
    paneId = created.result?.root_pane?.pane_id;
    if (!tabId || !paneId) throw new Error("Could not create new worker tab");
    const startArgs = ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--"];
    if (model) startArgs.push("--model", model);
    if (thinking) startArgs.push("--thinking", thinking);
    await waitForShell(startArgs, paneId);
    runHerdr(["agent", "prompt", name, prompt, "--wait", "--timeout", String(timeout)], timeout + 30000);
    const response = runHerdr(["agent", "read", name, "--source", "recent-unwrapped", "--lines", "100"]);
    return `Agent ${name} completed in tab ${tabId}\n\n${response}`;
  } finally {
    if (tabId) {
      try { runHerdr(["tab", "close", tabId]); } catch { /* best effort cleanup */ }
    } else if (paneId) {
      try { runHerdr(["pane", "close", paneId]); } catch { /* best effort cleanup */ }
    }
  }
}

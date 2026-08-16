import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Mode = "regular" | "worker";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

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
  prompt: Type.String({ description: "A complete implementation, testing, or review task for the persistent worker" }),
  timeout: Type.Optional(Type.Number({ description: "Worker timeout in milliseconds (default: 300000)" })),
});

type WorkerDelegateArgs = {
  prompt: string;
  timeout?: number;
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
    "Configure with:",
    "/worker-config mode regular|worker",
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
    "herdr-spawn",
    `${config.mode === "worker" ? "WORKER" : "REGULAR"}${worker ? ` · ${worker.name}` : ""}`,
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
      throw new Error("Worker mode requires pi to run inside a Herdr-managed pane (HERDR_ENV=1).");
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
      runHerdr(startArgs);
    } catch (error) {
      closeWorker({ name, paneId });
      throw error;
    }

    worker = { name, paneId };
    applyStatus(ctx, config, worker);
    return worker;
  };

  const delegate = async (ctx: ExtensionContext, args: WorkerDelegateArgs) => {
    if (config.mode !== "worker") {
      throw new Error("Worker mode is not active. Run /worker-config mode worker first.");
    }
    if (!args.prompt.trim()) throw new Error("A worker prompt is required.");

    const run = workerQueue.then(async () => {
      const active = await startWorker(ctx);
      const timeout = args.timeout ?? DEFAULT_WORKER_TIMEOUT;
      runHerdr(["agent", "prompt", active.name, args.prompt, "--wait", "--timeout", String(timeout)], timeout + 30000);
      return runHerdr(["agent", "read", active.name, "--source", "recent-unwrapped", "--lines", "200"]);
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
      if (mode === "worker") await startWorker(ctx);
      applyStatus(ctx, config, worker);
      return;
    }

    if (mode === "worker") {
      config.mode = "worker";
      try {
        await startWorker(ctx);
      } catch (error: any) {
        config.mode = "regular";
        applyStatus(ctx, config, worker);
        throw new Error(error.message);
      }
      notify(ctx, "Worker mode enabled. Delegate implementation and validation through worker_delegate.");
    } else {
      config.mode = "regular";
      await stopWorker(ctx);
      notify(ctx, "Regular mode enabled. The current session may work directly again.");
    }
    applyStatus(ctx, config, worker);
  };

  pi.on("session_start", async (_event, ctx) => {
    config.mode = "regular";
    worker = undefined;
    applyStatus(ctx, config, worker);
    notify(ctx, "Herdr spawn ready in regular mode. Use /worker-config to configure or enter worker mode.");
  });

  pi.on("session_shutdown", async () => {
    closeWorker(worker);
    worker = undefined;
  });

  pi.on("before_agent_start", async (event) => {
    if (config.mode !== "worker") return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nWORKER MODE (ORCHESTRATOR): You are the brain and must exclusively orchestrate. Do not use write, edit, bash, apply_patch, patch, delete, or move tools. Delegate implementation, testing, and other non-trivial work with worker_delegate, then inspect and summarize the worker result. Keep delegation prompts complete and specific.`,
    };
  });

  pi.on("tool_call", async (event) => {
    if (config.mode === "worker" && MUTATING_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Blocked in worker mode: ${event.toolName} is a mutation tool. Use worker_delegate for non-trivial work.`,
      };
    }
  });

  pi.registerCommand("worker-config", {
    description: "Configure regular/worker mode, brain and worker models, and thinking levels",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0 || tokens[0] === "show") {
        notify(ctx, describeConfig(config, worker, ctx));
        return;
      }

      const key = tokens[0]!.toLowerCase();
      const value = tokens.slice(1).join(" ");
      try {
        if (key === "mode") {
          if (value !== "regular" && value !== "worker") throw new Error("Usage: /worker-config mode regular|worker");
          await setMode(value, ctx);
        } else if (key === "brain-model") {
          if (!value) throw new Error("Usage: /worker-config brain-model <provider/model>");
          await setBrainModel(value, ctx);
          notify(ctx, `Brain model set to ${config.brainModel}.`);
        } else if (key === "brain-thinking") {
          if (!validThinking(value)) throw new Error("Usage: /worker-config brain-thinking <off|minimal|low|medium|high|xhigh|max>");
          pi.setThinkingLevel(value);
          config.brainThinking = value;
          notify(ctx, `Brain thinking level set to ${value}.`);
        } else if (key === "worker-model" || key === "worker-thinking") {
          if (key === "worker-thinking" && !validThinking(value)) {
            throw new Error("Usage: /worker-config worker-thinking <off|minimal|low|medium|high|xhigh|max>");
          }
          if (!value) throw new Error(`Usage: /worker-config ${key} <value>`);
          if (key === "worker-model") config.workerModel = value;
          else config.workerThinking = value as ThinkingLevel;
          if (config.mode === "worker") {
            await stopWorker(ctx);
            await startWorker(ctx);
          }
          notify(ctx, `${key} set to ${value}.`);
        } else if (key === "reset") {
          config.brainModel = undefined;
          config.brainThinking = undefined;
          config.workerModel = undefined;
          config.workerThinking = undefined;
          notify(ctx, "Worker configuration reset. Mode remains unchanged.");
        } else {
          throw new Error("Usage: /worker-config [show|mode|brain-model|brain-thinking|worker-model|worker-thinking|reset] ...");
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
    description: "Delegate implementation, testing, review, or other non-trivial work to the persistent Herdr worker. Available for use in worker mode.",
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
    runHerdr(startArgs);
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

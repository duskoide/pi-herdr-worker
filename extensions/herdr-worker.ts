import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  getAgentDir,
  parseFrontmatter,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const THINKING_LEVELS = new Set<ThinkingLevel>(THINKING_ORDER);

const CONCURRENT_CHOICES = ["1", "2", "3", "4", "6", "8"];

// A worker instance must not orchestrate its own workers. Mutation tools stay
// available so the worker can read, edit, and execute tests directly.
const BLOCKED_IN_WORKER = new Set(["worker_delegate", "spawn_pi"]);

const WorkerDelegateInput = Type.Object({
  prompt: Type.String({
    description:
      "A complete, self-contained implementation, testing, or review task for the subagent. It has no memory of this conversation.",
  }),
  role: Type.Optional(
    Type.String({
      description:
        "Role name for the subagent, resolved from .pi/agents/<role>.md (project), .agents/agents/<role>.md (workspace), or ~/.pi/agent/agents/<role>.md (global). Falls back to the configured default role, then to the built-in generic worker.",
    }),
  ),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Files or directories this task may modify. Disjoint path scopes may run concurrently on separate subagents; omit for an exclusive task.",
    }),
  ),
  timeout: Type.Optional(Type.Number({ description: "Subagent timeout in milliseconds (default: 300000)" })),
});

type WorkerDelegateArgs = {
  prompt: string;
  role?: string;
  paths?: string[];
  timeout?: number;
};

/** A role definition loaded from a pi-style agent markdown file. */
type RoleDef = {
  name: string;
  description: string;
  /** Markdown body used as the subagent system prompt. */
  prompt: string;
  /** "append" adds the body to the worker preamble; "replace" uses the body alone. */
  promptMode: "append" | "replace";
  model?: string;
  thinking?: ThinkingLevel;
  /** pi --tools allowlist, passed through verbatim when set. */
  tools?: string;
  sourcePath?: string;
};

type HerdrAgent = {
  agent?: string;
  agent_status?: string;
  name?: string;
  pane_id?: string;
  tab_id?: string;
};

type DelegationJob = {
  args: WorkerDelegateArgs;
  ctx: ExtensionContext;
  scopes: string[];
  role: RoleDef;
  resolve: (report: string) => void;
  reject: (error: unknown) => void;
};

/** One running one-shot subagent. Each delegation owns its Herdr tab. */
type ActiveDelegation = {
  job: DelegationJob;
  role: RoleDef;
  name: string;
  tabId?: string;
  paneId?: string;
};

type WorkerConfig = {
  workerModel?: string;
  workerThinking?: ThinkingLevel;
  /** Role used when worker_delegate omits `role`. Undefined = generic worker. */
  defaultRole?: string;
  maxConcurrent: number;
};

const DEFAULT_WORKER_TIMEOUT = 300000;
const DEFAULT_MAX_CONCURRENT = 4;
const WORKER_SETTINGS_KEY = "herdrWorker";
const BUILTIN_WORKER_NAME = "worker";

const WORKER_SYSTEM_PROMPT = [
  "You are a one-time implementation subagent spawned by a parent pi session.",
  "The parent session is the orchestrator and will not see this conversation after you finish.",
  "Execute the delegated task directly in this repository.",
  "You may inspect files, edit source, run tests, and validate the result.",
  "Do not delegate work to another agent and do not use worker-mode or spawn commands.",
  "When the task is complete, output a single final report as your last message:",
  "changes made, validation performed, and any blockers.",
  "The parent reads only your most recent output, so make the final message self-contained.",
].join(" ");

// pi gives spawned processes no dedicated env var, so a worker recognises
// itself by finding marker text in its own argv. The marker lives in the
// value of --append-system-prompt, which pi carries in process.argv (a
// dedicated --flag is unusable: pi rejects unknown options and would abort
// the subagent before the extension loads).
const MARKER_LINE = "You are a one-time implementation subagent spawned by a parent pi session.";
const SPAWN_MARKER = "one-time implementation subagent";

function detectWorkerInstance(): boolean {
  if (process.env.PI_HERDR_WORKER === "1") return true;
  return process.argv.some((arg) => arg.includes(SPAWN_MARKER));
}

const IS_WORKER_INSTANCE = detectWorkerInstance();

// ---------------------------------------------------------------------------
// Session state
//
// Everything mutable lives at module scope so the queue, tab bookkeeping, and
// config stay reachable from every helper and from lifecycle hooks. Pi reloads
// the module per session/reload, but because session_start re-fires on switch,
// resetSessionState() guarantees a clean slate either way. Persisted worker
// defaults (model/thinking/default role/max concurrent) survive across sessions.
// ---------------------------------------------------------------------------

const state = {
  pi: undefined as ExtensionAPI | undefined,
  config: { maxConcurrent: DEFAULT_MAX_CONCURRENT } as WorkerConfig,
  activeDelegations: [] as ActiveDelegation[],
  pendingDelegations: [] as DelegationJob[],
  statusContexts: new Set<ExtensionContext>(),
  roleCache: undefined as { key: string; roles: Map<string, RoleDef> } | undefined,
};

function resetSessionState(): void {
  state.activeDelegations.length = 0;
  state.pendingDelegations.length = 0;
  state.statusContexts.clear();
  state.roleCache = undefined;
  state.config = { ...loadPersistedConfig() };
}

// ---------------------------------------------------------------------------
// Role discovery
// ---------------------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function loadRoleDir(dir: string, roles: Map<string, RoleDef>): void {
  if (!existsSync(dir)) return;
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".md"));
  } catch {
    return;
  }
  for (const file of files) {
    const path = join(dir, file);
    let parsed: { frontmatter: Record<string, unknown>; body: string };
    try {
      parsed = parseFrontmatter<Record<string, unknown>>(readFileSync(path, "utf8"));
    } catch {
      // One malformed role file must not break discovery of the others.
      continue;
    }
    const fm = parsed.frontmatter;
    if (fm.enabled === false) continue;
    const declared = str(fm.name);
    // Colons are reserved by pi's agent convention for plugin-scoped ids.
    if (declared?.includes(":")) continue;
    const name = declared ?? file.replace(/\.md$/, "");
    const tools = str(fm.tools);
    const thinking = str(fm.thinking);
    roles.set(name, {
      name,
      description: str(fm.description) ?? name,
      prompt: parsed.body.trim(),
      promptMode: fm.prompt_mode === "append" ? "append" : "replace",
      model: str(fm.model),
      thinking: thinking && validThinking(thinking) ? (thinking as ThinkingLevel) : undefined,
      // "all" / "*" mean the default toolset, which needs no flag.
      tools: tools && tools !== "all" && tools !== "*" ? tools : undefined,
      sourcePath: path,
    });
  }
}

function builtinWorkerRole(): RoleDef {
  return {
    name: BUILTIN_WORKER_NAME,
    description: "Generic one-shot implementation worker (built-in)",
    prompt: WORKER_SYSTEM_PROMPT,
    promptMode: "replace",
  };
}

/**
 * Discover role definitions. Priority (later entries override earlier ones):
 * built-in "worker" < global ~/.pi/agent/agents/ < workspace <cwd>/.agents/agents/
 * < project <cwd>/.pi/agents/. Same layout pi's subagent packages use, so a
 * role file is also reusable as a native subagent type.
 */
function discoverRoles(ctx: ExtensionContext): Map<string, RoleDef> {
  const key = resolve(ctx.cwd);
  if (state.roleCache?.key === key) return state.roleCache.roles;
  const roles = new Map<string, RoleDef>();
  roles.set(BUILTIN_WORKER_NAME, builtinWorkerRole());
  loadRoleDir(join(getAgentDir(), "agents"), roles);
  loadRoleDir(join(key, ".agents", "agents"), roles);
  loadRoleDir(join(key, ".pi", "agents"), roles);
  state.roleCache = { key, roles };
  return roles;
}

/**
 * Resolve a role by name. An unknown name falls back to the built-in generic
 * worker (with a warning) rather than failing the delegation: a stale default
 * role in settings.json must not block work.
 */
function resolveRole(ctx: ExtensionContext, requested: string | undefined): { role: RoleDef; fellBack: boolean } {
  const roles = discoverRoles(ctx);
  const name = requested ?? state.config.defaultRole ?? BUILTIN_WORKER_NAME;
  const role = roles.get(name) ?? roles.get(name.toLowerCase());
  if (role) return { role, fellBack: false };
  return { role: roles.get(BUILTIN_WORKER_NAME)!, fellBack: name !== BUILTIN_WORKER_NAME };
}

function roleSystemPrompt(role: RoleDef): string {
  // The marker sentence is always injected, even for prompt_mode: replace, so
  // the subagent reliably recognises itself as a worker (IS_WORKER_INSTANCE
  // scans its own argv for this text). A role body alone would otherwise let a
  // replace-mode role run as if it were the brain session.
  //
  // The assembled prompt is passed through herdr `agent start -- ... --append-system-prompt ...`.
  // Herdr encodes every argv entry into a single command line for the target pane's
  // shell, and rejects newlines as unsafe to encode — so the prompt has to be a
  // single line. Collapse any whitespace run (including newlines from role bodies
  // that contain paragraphs) into single spaces before sending.
  const raw = role.promptMode === "replace" ? `${MARKER_LINE} ${role.prompt}` : `${WORKER_SYSTEM_PROMPT} ${role.prompt}`;
  return raw.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Herdr plumbing
// ---------------------------------------------------------------------------

// All herdr calls are async (execFile) so they never block pi's event loop.
// Using execFileSync here would freeze the whole session while a subagent is
// created, started, or waited on — the extension runs in pi's single-threaded
// loop and a long synchronous child call stalls every tool and keystroke.
function runHerdr(args: string[], timeout = 30000): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      "herdr",
      args,
      { encoding: "utf8", timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolveOutput(stdout);
      },
    );
  });
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// A freshly opened tab's shell is not immediately an available shell; Herdr
// reports agent_pane_busy until the shell reaches its interactive prompt.
// Retry the start for a few seconds before giving up.
async function waitForShell(startArgs: string[], paneId: string, attempts = 25, delayMs = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await runHerdr(startArgs);
      return;
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (!message.includes("agent_pane_busy") && !message.includes("not an available shell")) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
  throw new Error(`Herdr pane ${paneId} never became an available shell.`);
}

// Submit a prompt and wait for the agent to settle.
//
// Herdr's `agent prompt --wait` has a hard 5-second gate that fires whenever
// the agent starts from a non-working state and demands an observed state
// change inside that window; cold-start model calls routinely exceed 5s, so
// the gate rejects the delegation with agent_prompt_stalled even though the
// subagent is doing exactly what was asked. Decoupling submission from
// waiting sidesteps the gate: the unconditional `agent wait` does not have
// it.
//
// We wait for `done` (turn finished, ready for the next input) or `blocked`
// (turn needs interactive input we cannot satisfy from a delegation). Matching
// `idle` would match the initial state too and turn the wait into a no-op,
// which is why this used to return the subagent's pane before the assistant
// had started producing output.
async function submitAndAwaitAgent(name: string, prompt: string, timeoutMs: number): Promise<void> {
  await runHerdr(["agent", "prompt", name, prompt]);
  await runHerdr(
    ["agent", "wait", name, "--until", "done", "--until", "blocked", "--timeout", String(timeoutMs)],
    timeoutMs + 30000,
  );
}

function parseJson<T>(output: string): T {
  return JSON.parse(output) as T;
}

function slugRole(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 12) || "role";
}

// Extract a string message from an unknown caught value. We catch as `unknown`
// everywhere so TypeScript can keep its narrowing; this helper covers the common
// shapes — Error instances, plain strings, and unknown objects with a `.message`.
function errorMessage(error: unknown, fallback = ""): string {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return fallback;
}

function spawnName(roleName: string): string {
  // pi's agent naming rule: lowercase start, [a-z0-9_-], max 31 chars.
  return `pi-worker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}-${slugRole(roleName)}`.slice(0, 31);
}

async function closeTab(record: { tabId?: string; paneId?: string }) {
  try {
    if (record.tabId) await runHerdr(["tab", "close", record.tabId]);
    else if (record.paneId) await runHerdr(["pane", "close", record.paneId]);
  } catch {
    // The tab or pane may already have been closed by Herdr or the user.
  }
}

/** pi arguments for a subagent spawn; must come after `--` in `herdr agent start`. */
function rolePiArgs(role: RoleDef, model: string | undefined, thinking: ThinkingLevel | undefined, sessionName: string): string[] {
  const piArgs: string[] = [];
  if (model) piArgs.push("--model", model);
  if (thinking) piArgs.push("--thinking", thinking);
  if (role.tools) piArgs.push("--tools", role.tools);
  piArgs.push("--name", sessionName, "--append-system-prompt", roleSystemPrompt(role));
  return piArgs;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function currentModelId(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
  ctx.ui.notify(message, level);
}

function validThinking(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.has(value as ThinkingLevel);
}

function findModel(ctx: ExtensionContext, requested: string) {
  const exact = requested.includes("/") ? requested.split("/", 2) : undefined;
  if (exact) return ctx.modelRegistry.find(exact[0]!, exact[1]!);

  return ctx.modelRegistry.getAvailable().find((model) => model.id === requested);
}

function describeConfig(ctx: ExtensionContext): string {
  const config = state.config;
  return [
    `subagent default model: ${config.workerModel ?? currentModelId(ctx) ?? "parent model"}`,
    `subagent default thinking: ${config.workerThinking ?? ctx.thinkingLevel ?? "parent level"}`,
    `default role: ${config.defaultRole ?? `${BUILTIN_WORKER_NAME} (generic)`}`,
    `max concurrent subagents: ${config.maxConcurrent}`,
    `delegations: ${state.activeDelegations.length} active, ${state.pendingDelegations.length} queued`,
    "",
    "Run /worker-config with no arguments to open the interactive settings UI, or use:",
    "/worker-config default-role <role>",
    "/worker-config max-concurrent <n>",
    "/worker-config roles",
    "/worker-config worker-model <provider/model>",
    "/worker-config worker-thinking <off|minimal|low|medium|high|xhigh|max>",
  ].join("\n");
}

function applyStatus(ctx: ExtensionContext) {
  const theme = ctx.ui.theme;
  const label = theme.fg("muted", "herdr-worker:");
  const ready = theme.fg("success", theme.bold("ready"));
  const active = state.activeDelegations.length;
  const queued = state.pendingDelegations.length;
  const busy = active + queued > 0 ? ` ${theme.fg("muted", "·")} ${theme.fg("warning", `● ${active} active`)}` : "";
  ctx.ui.setStatus("herdr-worker", `${label} ${ready}${busy}`);
}

function refreshStatus() {
  for (const ctx of state.statusContexts) {
    try {
      applyStatus(ctx);
    } catch {
      // The context may belong to a replaced session; skip it.
    }
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

type PersistedWorkerConfig = WorkerConfig;

function persistedDefaults(): PersistedWorkerConfig {
  return { maxConcurrent: DEFAULT_MAX_CONCURRENT };
}

function loadPersistedConfig(): PersistedWorkerConfig {
  try {
    const raw = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as Record<string, unknown>;
    const value = raw[WORKER_SETTINGS_KEY];
    if (!value || typeof value !== "object") return persistedDefaults();
    const stored = value as Record<string, unknown>;
    return {
      workerModel: typeof stored.workerModel === "string" ? stored.workerModel : undefined,
      workerThinking:
        typeof stored.workerThinking === "string" && validThinking(stored.workerThinking)
          ? stored.workerThinking
          : undefined,
      defaultRole: typeof stored.defaultRole === "string" ? stored.defaultRole : undefined,
      maxConcurrent:
        typeof stored.maxConcurrent === "number" && stored.maxConcurrent >= 1
          ? Math.floor(stored.maxConcurrent)
          : DEFAULT_MAX_CONCURRENT,
    };
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return persistedDefaults();
    }
    // Leave malformed settings untouched; Pi remains usable and can report the
    // malformed file through its normal settings handling.
    return persistedDefaults();
  }
}

function savePersistedConfig(): void {
  const config = state.config;
  const path = join(getAgentDir(), "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error: unknown) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw new Error(`Could not read ${path}: ${errorMessage(error, "<unknown>")}`);
    }
  }

  // Drop legacy brain-* fields so old settings.json files don't keep stale data.
  if (settings[WORKER_SETTINGS_KEY] && typeof settings[WORKER_SETTINGS_KEY] === "object") {
    delete (settings[WORKER_SETTINGS_KEY] as Record<string, unknown>).brainModel;
    delete (settings[WORKER_SETTINGS_KEY] as Record<string, unknown>).brainThinking;
  }

  settings[WORKER_SETTINGS_KEY] = {
    ...(settings[WORKER_SETTINGS_KEY] as Record<string, unknown> | undefined),
    ...(config.workerModel ? { workerModel: config.workerModel } : {}),
    ...(config.workerThinking ? { workerThinking: config.workerThinking } : {}),
    ...(config.defaultRole ? { defaultRole: config.defaultRole } : {}),
    ...(config.maxConcurrent !== DEFAULT_MAX_CONCURRENT ? { maxConcurrent: config.maxConcurrent } : {}),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Delegation scheduler
// ---------------------------------------------------------------------------

function normalizeScopes(paths: string[] | undefined, cwd: string): string[] {
  return [...new Set((paths ?? []).map((path) => resolve(cwd, path)))];
}

function scopesOverlap(left: string[], right: string[]): boolean {
  // An omitted/empty scope is exclusive: it may not overlap any active task.
  if (left.length === 0 || right.length === 0) return true;
  const contains = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`);
  return left.some((leftPath) =>
    right.some((rightPath) => contains(leftPath, rightPath) || contains(rightPath, leftPath)),
  );
}

async function runDelegation(record: ActiveDelegation) {
  const { job, role } = record;
  const ctx = job.ctx;
  const config = state.config;
  try {
    if (process.env.HERDR_ENV !== "1") {
      throw new Error("worker_delegate requires pi to run inside a Herdr-managed pane (HERDR_ENV=1).");
    }
    const modelRequested = role.model ?? config.workerModel ?? currentModelId(ctx);
    let model = modelRequested;
    if (modelRequested) {
      const found = findModel(ctx, modelRequested);
      if (!found) throw new Error(`Subagent model not found or unavailable: ${modelRequested}`);
      model = `${found.provider}/${found.id}`;
    }
    const thinking = role.thinking ?? config.workerThinking ?? ctx.thinkingLevel;

    const created = parseJson<{
      result?: { tab?: { tab_id?: string }; root_pane?: { pane_id?: string } };
    }>(await runHerdr(["tab", "create", "--cwd", ctx.cwd, "--label", record.name, "--no-focus"]));
    record.tabId = created.result?.tab?.tab_id;
    record.paneId = created.result?.root_pane?.pane_id;
    if (!record.tabId || !record.paneId) throw new Error("Could not create a Herdr subagent tab.");
    refreshStatus();

    const startArgs = ["agent", "start", record.name, "--kind", "pi", "--pane", record.paneId, "--"];
    startArgs.push(...rolePiArgs(role, model, thinking, record.name));
    await waitForShell(startArgs, record.paneId);

    const timeout = job.args.timeout ?? DEFAULT_WORKER_TIMEOUT;
    await submitAndAwaitAgent(record.name, job.args.prompt, timeout);
    const report = await runHerdr([
      "agent",
      "read",
      record.name,
      "--source",
      "recent-unwrapped",
      "--lines",
      "200",
    ]);
    job.resolve(report);
  } catch (error) {
    job.reject(error);
  } finally {
    // Close the tab on every path — including a mid-flight mode switch or
    // session reload — so no Herdr tab is ever leaked.
    await closeTab(record);
    const index = state.activeDelegations.indexOf(record);
    if (index >= 0) state.activeDelegations.splice(index, 1);
    refreshStatus();
    pumpDelegations();
  }
}

function pumpDelegations() {
  for (let index = 0; index < state.pendingDelegations.length; ) {
    if (state.activeDelegations.length >= state.config.maxConcurrent) break;
    const job = state.pendingDelegations[index]!;
    if (state.activeDelegations.some((active) => scopesOverlap(active.job.scopes, job.scopes))) {
      index += 1;
      continue;
    }
    state.pendingDelegations.splice(index, 1);
    const record: ActiveDelegation = { job, role: job.role, name: spawnName(job.role.name) };
    state.activeDelegations.push(record);
    void runDelegation(record);
  }
  refreshStatus();
}

function delegate(ctx: ExtensionContext, args: WorkerDelegateArgs): Promise<string> {
  if (!args.prompt.trim()) return Promise.reject(new Error("A worker prompt is required."));
  // Resolve the role before queueing so an unknown name warns immediately.
  const { role, fellBack } = resolveRole(ctx, args.role);
  if (fellBack) {
    notify(ctx, `Unknown worker role "${args.role ?? state.config.defaultRole}". Using generic worker.`, "warning");
  }

  return new Promise<string>((resolveJob, rejectJob) => {
    state.pendingDelegations.push({
      args,
      ctx,
      scopes: normalizeScopes(args.paths, ctx.cwd),
      role,
      resolve: resolveJob,
      reject: rejectJob,
    });
    pumpDelegations();
  });
}

// ---------------------------------------------------------------------------
// Settings mutations
// ---------------------------------------------------------------------------

// Worker model/thinking are defaults for future spawns; there is no live
// worker to restart, so a change only needs to be recorded.
function applyWorkerSetting(key: "worker-model" | "worker-thinking", value: string, ctx: ExtensionContext): void {
  if (key === "worker-model") {
    if (!findModel(ctx, value)) throw new Error(`Model not found or unavailable: ${value}`);
    state.config.workerModel = value;
  } else {
    state.config.workerThinking = value as ThinkingLevel;
  }
  savePersistedConfig();
}

// ---------------------------------------------------------------------------
// Interactive settings UI
// ---------------------------------------------------------------------------

// A SelectList wrapped with a live search box. Typing filters items by
// substring (case-insensitive) against the label; backspace edits the query.
// Navigation/confirm/cancel keys pass through to the underlying list.
function searchableSelect(
  allItems: SelectItem[],
  current: string,
  done: (selected?: string) => void,
): Component {
  let query = "";
  const theme = getSelectListTheme();

  const filtered = (): SelectItem[] => {
    if (!query) return allItems;
    const needle = query.toLowerCase();
    return allItems.filter(
      (item) => item.label.toLowerCase().includes(needle) || item.value.toLowerCase().includes(needle),
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
}

// Build a SelectList submenu factory for picking a model from the registry.
// The first option lets the user clear the override and inherit the parent
// session's model.
function modelSubmenu(ctx: ExtensionContext) {
  return (current: string, done: (selected?: string) => void): Component => {
    const available = ctx.modelRegistry.getAvailable();
    const items: SelectItem[] = [
      {
        value: "__inherit__",
        label: "(inherit parent model)",
        description: "Use the same model as this session",
      },
    ];
    for (const model of available) {
      const id = `${model.provider}/${model.id}`;
      items.push({ value: id, label: id, description: model.provider });
    }

    return searchableSelect(items, current, done);
  };
}

// Build a SelectList submenu factory for picking a thinking level. The first
// option lets the user clear the override and inherit the parent session's
// thinking level.
function thinkingSubmenu() {
  return (current: string, done: (selected?: string) => void): Component => {
    const items: SelectItem[] = [
      {
        value: "__inherit__",
        label: "(inherit parent thinking)",
        description: "Use the same thinking level as this session",
      },
      ...THINKING_ORDER.map((level) => ({ value: level, label: level })),
    ];

    const list = new SelectList(items, items.length, getSelectListTheme());
    const currentIndex = items.findIndex((item) => item.value === current);
    if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(undefined);
    return list;
  };
}

// Build a SelectList submenu factory for picking a default role.
function roleSubmenu(ctx: ExtensionContext) {
  return (current: string, done: (selected?: string) => void): Component => {
    const roles = [...discoverRoles(ctx).values()].filter((role) => role.name !== BUILTIN_WORKER_NAME);
    const items: SelectItem[] = [
      {
        value: "",
        label: `${BUILTIN_WORKER_NAME} (generic)`,
        description: "Built-in one-shot worker prompt",
      },
      ...roles.map((role) => ({
        value: role.name,
        label: role.name,
        description: role.description,
      })),
    ];
    const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
    const currentIndex = items.findIndex((item) => item.value === current);
    if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(undefined);
    return list;
  };
}

async function openSettingsUI(ctx: ExtensionContext): Promise<void> {
  const config = state.config;
  // Draft state: edits are collected here and only applied to the live config
  // when the user presses Ctrl+S. Esc discards the draft.
  type Draft = {
    workerModel?: string;
    workerThinking?: ThinkingLevel;
    defaultRole?: string;
    maxConcurrent: number;
  };
  const draft: Draft = {
    workerModel: config.workerModel,
    workerThinking: config.workerThinking,
    defaultRole: config.defaultRole,
    maxConcurrent: config.maxConcurrent,
  };

  const workerModelDisplay = () => draft.workerModel ?? "(inherit parent model)";
  const workerThinkingDisplay = () => draft.workerThinking ?? "(inherit parent thinking)";
  const defaultRoleDisplay = () => draft.defaultRole ?? `${BUILTIN_WORKER_NAME} (generic)`;

  const isDirty = () =>
    draft.workerModel !== config.workerModel ||
    draft.workerThinking !== config.workerThinking ||
    draft.defaultRole !== config.defaultRole ||
    draft.maxConcurrent !== config.maxConcurrent;

  // Apply the draft to the live config. Subagent defaults only affect future
  // spawns, so there is nothing live to restart.
  const saveDraft = async () => {
    if (draft.workerModel && !findModel(ctx, draft.workerModel)) {
      throw new Error(`Model not found or unavailable: ${draft.workerModel}`);
    }
    config.workerModel = draft.workerModel;
    config.workerThinking = draft.workerThinking;
    config.defaultRole = draft.defaultRole;
    config.maxConcurrent = draft.maxConcurrent;
    savePersistedConfig();
    applyStatus(ctx);
  };

  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    const container = new Container();
    const header = new Text(theme.fg("accent", theme.bold("Herdr Worker Settings")), 1, 1);
    container.addChild(header);

    const items: SettingItem[] = [
      {
        id: "worker-model",
        label: "Subagent model",
        description: "Default model for spawned subagents; a role file may override (enter to pick)",
        currentValue: workerModelDisplay(),
        submenu: modelSubmenu(ctx),
      },
      {
        id: "worker-thinking",
        label: "Subagent thinking",
        description: "Default thinking level for spawned subagents; a role file may override",
        currentValue: workerThinkingDisplay(),
        submenu: thinkingSubmenu(),
      },
      {
        id: "default-role",
        label: "Default role",
        description: "Role used when worker_delegate omits role (from .pi/agents/*.md; enter to pick)",
        currentValue: defaultRoleDisplay(),
        submenu: roleSubmenu(ctx),
      },
      {
        id: "max-concurrent",
        label: "Max concurrent",
        description: "Upper bound on subagents running at once (disjoint path scopes parallelize)",
        currentValue: String(draft.maxConcurrent),
        values: CONCURRENT_CHOICES,
      },
      {
        id: "reset",
        label: "Reset overrides",
        description: "Clear subagent model, thinking, default role, and concurrency (in draft)",
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
        if (id === "worker-model") {
          draft.workerModel = newValue === "__inherit__" ? undefined : newValue;
          settingsList.updateValue("worker-model", workerModelDisplay());
        } else if (id === "worker-thinking") {
          if (newValue === "__inherit__") draft.workerThinking = undefined;
          else if (validThinking(newValue)) draft.workerThinking = newValue;
          settingsList.updateValue("worker-thinking", workerThinkingDisplay());
        } else if (id === "default-role") {
          draft.defaultRole = newValue || undefined;
          settingsList.updateValue("default-role", defaultRoleDisplay());
        } else if (id === "max-concurrent") {
          const parsed = Number(newValue);
          if (Number.isFinite(parsed) && parsed >= 1) draft.maxConcurrent = Math.floor(parsed);
          settingsList.updateValue("max-concurrent", String(draft.maxConcurrent));
        } else if (id === "reset") {
          if (newValue === "reset") {
            draft.workerModel = undefined;
            draft.workerThinking = undefined;
            draft.defaultRole = undefined;
            draft.maxConcurrent = DEFAULT_MAX_CONCURRENT;
            settingsList.updateValue("worker-model", workerModelDisplay());
            settingsList.updateValue("worker-thinking", workerThinkingDisplay());
            settingsList.updateValue("default-role", defaultRoleDisplay());
            settingsList.updateValue("max-concurrent", String(draft.maxConcurrent));
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
            } catch (error: unknown) {
              notify(ctx, errorMessage(error, "<unknown>"), "error");
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
}

// ---------------------------------------------------------------------------
// Temporary one-shot spawning (/spawn, /spawnp, spawn_pi)
// ---------------------------------------------------------------------------

function parseSpawnArgs(
  args: string,
): { prompt: string; name?: string; model?: string; role?: string; thinking?: string; timeout: number } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const promptTokens: string[] = [];
  let name: string | undefined;
  let model: string | undefined;
  let role: string | undefined;
  let thinking: string | undefined;
  let timeout = 120000;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--name" || token === "--model" || token === "--timeout" || token === "--role" || token === "--thinking") {
      const value = tokens[++index];
      if (!value) throw new Error(`${token} requires a value`);
      if (token === "--name") name = value;
      else if (token === "--model") model = value;
      else if (token === "--role") role = value;
      else if (token === "--thinking") {
        if (!validThinking(value)) throw new Error(`invalid thinking level: ${value}`);
        thinking = value;
      } else timeout = Number(value);
    } else {
      promptTokens.push(token);
    }
  }

  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("--timeout must be a positive number");
  return { prompt: promptTokens.join(" "), name, model, role, thinking, timeout };
}

type OneShotArgs = {
  prompt: string;
  name?: string;
  model?: string;
  role?: string;
  thinking?: string;
  timeout: number;
};

/** Resolve a role's pi flags without an ExtensionContext (model stays verbatim). */
function roleFlagsFor(role: RoleDef, ctx: ExtensionContext | undefined, model?: string, thinking?: string): string[] {
  const flags: string[] = [];
  const resolvedModel = model ?? role.model;
  if (resolvedModel) {
    const available = ctx ? findModel(ctx, resolvedModel) : undefined;
    flags.push("--model", available ? `${available.provider}/${available.id}` : resolvedModel);
  }
  const resolvedThinking = thinking ?? role.thinking;
  if (resolvedThinking) flags.push("--thinking", resolvedThinking);
  if (role.tools) flags.push("--tools", role.tools);
  flags.push("--append-system-prompt", roleSystemPrompt(role));
  return flags;
}

async function runOneShot(parsed: OneShotArgs, ctx: ExtensionContext | undefined, cwd: string, direction = "right"): Promise<string> {
  if (process.env.HERDR_ENV !== "1") return "Failed: Not running in Herdr environment. Cannot spawn pane.";
  const name = parsed.name ?? `pi-${Date.now().toString(36)}`;
  let paneId: string | undefined;
  try {
    const split = parseJson<{ result?: { pane?: { pane_id?: string } } }>(
      await runHerdr(["pane", "split", "--current", "--direction", direction, "--cwd", cwd, "--no-focus"]),
    );
    paneId = split.result?.pane?.pane_id;
    if (!paneId) throw new Error("Could not create new pane");
    const startArgs = ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--"];
    if (parsed.role && ctx) {
      startArgs.push(...roleFlagsFor(resolveRole(ctx, parsed.role).role, ctx, parsed.model, parsed.thinking));
    } else {
      if (parsed.model) startArgs.push("--model", parsed.model);
      if (parsed.thinking) startArgs.push("--thinking", parsed.thinking);
    }
    await waitForShell(startArgs, paneId);
    await submitAndAwaitAgent(name, parsed.prompt, parsed.timeout);
    const response = await runHerdr(["agent", "read", name, "--source", "recent-unwrapped", "--lines", "100"]);
    return `Agent ${name} completed in pane ${paneId}\n\n${response}`;
  } catch (error: unknown) {
    return `Failed: ${errorMessage(error)}`;
  } finally {
    if (paneId) {
      try {
        await runHerdr(["pane", "close", paneId]);
      } catch {
        // best effort cleanup
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function herdrSpawn(pi: ExtensionAPI) {
  state.pi = pi;
  // A worker instance never orchestrates: session_start resets config to a
  // regular-mode session, and tool_call gates worker_delegate by worker
  // detection, so a stray delegation cannot spawn its own subagent.

  pi.on("session_start", async (_event, ctx) => {
    resetSessionState();
    state.statusContexts.add(ctx);
    applyStatus(ctx);
    if (!IS_WORKER_INSTANCE) {
      notify(
        ctx,
        "Herdr worker ready. worker_delegate and spawn_pi spawn one-shot pi subagents in Herdr tabs.",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    for (const job of state.pendingDelegations.splice(0)) {
      job.reject(new Error("Worker session shut down."));
    }
    // Owned subagent tabs are closed with the session. runDelegation's finally
    // closes them too, so these calls are best-effort duplicates.
    await Promise.all(
      state.activeDelegations.map(async (record) => {
        try {
          await closeTab(record);
        } catch {
          // best effort on shutdown
        }
      }),
    );
  });

  pi.on("before_agent_start", async (event, ctx) => {
    state.statusContexts.add(ctx);
    if (IS_WORKER_INSTANCE) {
      // Worker instance: tell the model it is a one-shot implementation worker
      // and that it must not spawn more subagents. End the final turn with a
      // self-contained report; the orchestrator reads only that message.
      return {
        systemPrompt: `${event.systemPrompt}\n\nSUBAGENT: You are a one-time worker spawned by a parent pi session via worker_delegate or spawn_pi. Execute the delegated task directly in this repository — inspect files, edit source, run tests, validate the result. Do not call worker_delegate or spawn_pi (your orchestrator would see those as runaway recursion). Your final message is captured automatically and returned to the orchestrator as your report, so end your turn with a self-contained summary: changes made, validation performed, any blockers.`,
      };
    }
    // Orchestrator/session: prime the model to recognize when delegation is
    // warranted. The tool's own description covers parameters and concurrency;
    // this nudge exists so the model reaches for it without first having to
    // read the herdr-worker skill. De-dup against an existing primer block so
    // any session that already received it (e.g. a follow-up turn after
    // before_agent_start fired earlier) does not see it stacked.
    const primer = `HERDR WORKER (delegation tools): This session can spawn one-shot pi subagents in their own Herdr tabs with the worker_delegate tool, or run an isolated single task with spawn_pi. Each subagent has its own clean context window, so use delegation when:
  • the task is implementation, testing, or review work that benefits from isolation,
  • independent tasks can run in parallel (pass disjoint paths to worker_delegate; up to max-concurrent),
  • the user's request maps cleanly to a persona defined in .pi/agents/<role>.md (call with role: "<name>").
Subagents have no memory of this conversation, so every prompt must be self-contained: the task, the relevant files, the desired behavior, and how to validate. Inspect each worker report and summarise the result before deciding the next delegation. For temporary one-shots that are not part of a coordinated plan, prefer spawn_pi over worker_delegate.`;
    if (event.systemPrompt.includes(primer)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${primer}` };
  });

  pi.on("tool_call", async (event) => {
    if (IS_WORKER_INSTANCE && BLOCKED_IN_WORKER.has(event.toolName)) {
      // A spawned subagent must never orchestrate its own workers — that would
      // turn a one-shot into a runaway tree of Herdr tabs.
      return {
        block: true,
        reason: `Blocked in subagent mode: ${event.toolName}. You are the worker — execute the task directly and report.`,
      };
    }
  });

  pi.registerCommand("worker-config", {
    description:
      "Open the worker settings UI, or configure it via subcommands (default-role, max-concurrent, roles, worker-model, worker-thinking, reset)",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      // No arguments opens the interactive settings UI.
      if (tokens.length === 0) {
        await openSettingsUI(ctx);
        return;
      }
      if (tokens[0] === "show") {
        notify(ctx, describeConfig(ctx));
        return;
      }

      const key = tokens[0]!.toLowerCase();
      const value = tokens.slice(1).join(" ");
      try {
        if (key === "ui") {
          await openSettingsUI(ctx);
          return;
        } else if (key === "default-role") {
          if (!value) throw new Error("Usage: /worker-config default-role <role> (see /worker-config roles)");
          state.roleCache = undefined;
          const { role, fellBack } = resolveRole(ctx, value);
          if (fellBack) throw new Error(`Unknown worker role "${value}". See /worker-config roles.`);
          state.config.defaultRole = role.name === BUILTIN_WORKER_NAME ? undefined : role.name;
          savePersistedConfig();
          notify(ctx, `Default subagent role set to ${role.name}.`);
        } else if (key === "max-concurrent") {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 1) throw new Error("Usage: /worker-config max-concurrent <n> (n >= 1)");
          state.config.maxConcurrent = Math.floor(parsed);
          savePersistedConfig();
          notify(ctx, `Max concurrent subagents set to ${state.config.maxConcurrent}.`);
        } else if (key === "roles") {
          state.roleCache = undefined;
          const roles = [...discoverRoles(ctx).values()];
          notify(
            ctx,
            roles
              .map((role) => `- ${role.name}: ${role.description}${role.sourcePath ? ` (${role.sourcePath})` : ""}`)
              .join("\n"),
          );
        } else if (key === "worker-model" || key === "worker-thinking") {
          if (key === "worker-thinking" && !validThinking(value)) {
            throw new Error("Usage: /worker-config worker-thinking <off|minimal|low|medium|high|xhigh|max>");
          }
          if (!value) throw new Error(`Usage: /worker-config ${key} <value>`);
          applyWorkerSetting(key, value, ctx);
          notify(ctx, `${key} set to ${value}. Takes effect on the next subagent spawn.`);
        } else if (key === "reset") {
          state.config.workerModel = undefined;
          state.config.workerThinking = undefined;
          state.config.defaultRole = undefined;
          state.config.maxConcurrent = DEFAULT_MAX_CONCURRENT;
          savePersistedConfig();
          notify(ctx, "Worker configuration reset.");
        } else {
          throw new Error(
            "Usage: /worker-config [ui|show|default-role|max-concurrent|roles|worker-model|worker-thinking|reset] ... (run with no arguments to open the settings UI)",
          );
        }
        applyStatus(ctx);
      } catch (error: unknown) {
        notify(ctx, errorMessage(error, "<unknown>"), "error");
      }
    },
  });

  pi.registerTool({
    name: "worker_delegate",
    label: "Worker Delegate",
    description:
      "Delegate implementation, testing, or review work to a freshly spawned one-shot pi subagent in its own Herdr tab. The subagent runs the task to completion, returns its report, and the tab is closed. Optional role selects a persona defined in .pi/agents/<role>.md (custom system prompt, model, thinking, tools); omit to use the configured default role. Use paths to declare files/directories the task may modify; disjoint paths run concurrently on separate subagents, while omitted paths are exclusive. Delegation prompts must be self-contained — subagents never see this conversation.",
    parameters: WorkerDelegateInput,
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      try {
        const response = await delegate(ctx, input as WorkerDelegateArgs);
        return {
          content: [{ type: "text", text: response }],
          details: {},
        };
      } catch (error: unknown) {
        return {
          content: [{ type: "text", text: errorMessage(error, "<unknown>") }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerCommand("spawn", {
    description: "Spawn a temporary pi agent: /spawn <prompt> [--name <name>] [--model <model>] [--role <role>] [--timeout <ms>]",
    handler: async (args, ctx) => {
      try {
        const parsed = parseSpawnArgs(args);
        if (!parsed.prompt) {
          notify(ctx, "Usage: /spawn <prompt> [--name <name>] [--model <model>] [--role <role>] [--timeout <ms>]", "error");
          return;
        }
        const result = await runOneShot(parsed, ctx, ctx.cwd);
        notify(ctx, result, result.startsWith("Failed") ? "error" : "info");
      } catch (error: unknown) {
        notify(ctx, errorMessage(error, "<unknown>"), "error");
      }
    },
  });

  pi.registerCommand("spawnp", {
    description: "Quick spawn with an auto-generated name: /spawnp <prompt> [--model <model>] [--role <role>]",
    handler: async (args, ctx) => {
      try {
        const parsed = parseSpawnArgs(args);
        if (!parsed.prompt) {
          notify(ctx, "Usage: /spawnp <prompt> [--model <model>] [--role <role>]", "error");
          return;
        }
        notify(ctx, await runOneShot(parsed, ctx, ctx.cwd));
      } catch (error: unknown) {
        notify(ctx, errorMessage(error, "<unknown>"), "error");
      }
    },
  });

  pi.registerCommand("spawnlist", {
    description: "List currently running Herdr agents",
    handler: async (_args, ctx) => {
      if (process.env.HERDR_ENV !== "1") return notify(ctx, "Not running in Herdr environment.", "error");
      try {
        const parsed = parseJson<{ result?: { agents?: HerdrAgent[] } }>(await runHerdr(["agent", "list"]));
        const agents = (parsed.result?.agents ?? []).filter((agent) => agent.agent === "pi");
        notify(
          ctx,
          agents.length
            ? agents.map((agent) => `- ${agent.name} (${agent.agent_status}) in ${agent.pane_id}`).join("\n")
            : "No agents currently running.",
        );
      } catch (error: unknown) {
        notify(ctx, `Failed: ${errorMessage(error)}`, "error");
      }
    },
  });

  pi.registerCommand("spawnkill", {
    description: "Kill a Herdr agent by name: /spawnkill <agent-name>",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) return notify(ctx, "Usage: /spawnkill <agent-name>", "error");
      try {
        const parsed = parseJson<{ result?: { agent?: { pane_id?: string; tab_id?: string } } }>(
          await runHerdr(["agent", "get", name]),
        );
        const paneId = parsed.result?.agent?.pane_id;
        const tabId = parsed.result?.agent?.tab_id;
        if (!paneId && !tabId) throw new Error(`Agent not found: ${name}`);
        await closeTab({ tabId, paneId });
        notify(ctx, `Killed agent ${name}.`);
      } catch (error: unknown) {
        notify(ctx, `Failed: ${errorMessage(error)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "spawn_pi",
    label: "Spawn Pi",
    description:
      "Spawn a temporary pi agent in a new Herdr pane, wait for its response, then clean it up. Optionally pass role (a .pi/agents/<role>.md name) to give it a custom system prompt.",
    parameters: Type.Object({
      prompt: Type.String({ description: "The prompt to send" }),
      name: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      role: Type.Optional(
        Type.String({ description: "Role name from .pi/agents/<role>.md; supplies the system prompt (and optionally model/thinking/tools)" }),
      ),
      timeout: Type.Optional(Type.Number()),
      direction: Type.Optional(Type.Union([Type.Literal("right"), Type.Literal("down")])),
    }),
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      const value = input as {
        prompt: string;
        name?: string;
        model?: string;
        role?: string;
        timeout?: number;
        direction?: "right" | "down";
      };
      const name = value.name || `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const response = await runOneShot(
        { prompt: value.prompt, name, model: value.model, role: value.role, timeout: value.timeout ?? 120000 },
        ctx,
        ctx.cwd,
        value.direction ?? "right",
      );
      return { content: [{ type: "text", text: response }], details: { agent_name: name } };
    },
  });
}

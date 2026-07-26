import { z } from "zod";

const SpawnPiInput = z.object({
  prompt: z.string().describe("The prompt to send to the spawned pi agent"),
  name: z
    .string()
    .optional()
    .describe(
      "Unique name for the agent (lowercase, hyphens, max 31 chars). Auto-generated if not provided."
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Model to use for the spawned agent (e.g., 'gpt-4o', 'claude-sonnet-5', 'provider/model-id'). Uses parent model if not specified."
    ),
  timeout: z
    .number()
    .optional()
    .default(120000)
    .describe("Timeout in milliseconds for the prompt (default: 120000)"),
  direction: z
    .enum(["right", "down"])
    .optional()
    .default("right")
    .describe("Pane split direction (default: right)"),
});

export default function herdrSpawn() {
  return {
    name: "herdr-spawn",
    description:
      "Spawn a pi agent in a new Herdr pane to execute tasks in parallel. Use when you need to run work in a separate pane without blocking the current session.",
    commands: [
      {
        name: "spawn",
        description:
          "Spawn a pi agent in a new pane to execute a task. Usage: /spawn <prompt> [name] [model] [timeout]",
        execute: async (args: string) => {
          // Parse command args: /spawn <prompt> [name] [model] [timeout]
          const parts = args.trim().split(/\s+/);
          
          if (parts.length === 0 || !parts[0]) {
            return {
              message: "Usage: /spawn <prompt> [agent-name] [model] [timeout-ms]\n\nExamples:\n/spawn Run tests and report failures\n/spawn Review code pi-review gpt-4o\n/spawn Build project pi-builder claude-sonnet-5 300000",
            };
          }
          
          const prompt = parts[0];
          const name = parts[1] || `pi-${Date.now().toString(36)}`;
          const model = parts[2] || undefined;
          const timeout = parts[3] ? parseInt(parts[3]) : 120000;
          
          // Check Herdr environment
          if (process.env.HERDR_ENV !== "1") {
            return {
              error: "Not running in Herdr environment. Cannot spawn pane.",
            };
          }
          
          try {
            const { execSync } = require("child_process");
            
            // Create new pane
            const splitResult = execSync(
              `herdr pane split --current --direction right --cwd "${process.env.PWD}" --no-focus`,
              { encoding: "utf-8" }
            );
            const split = JSON.parse(splitResult);
            const newPaneId = split.result?.pane?.pane_id;
            
            if (!newPaneId) {
              return { error: "Could not create new pane" };
            }
            
            // Build start command with optional model
            let startCmd = `herdr agent start "${name}" --kind pi --pane "${newPaneId}"`;
            if (model) {
              startCmd += ` -- --model "${model}"`;
            }
            
            // Start agent
            execSync(startCmd, { encoding: "utf-8" });
            
            // Send prompt
            const escapedPrompt = prompt.replace(/"/g, '\\"');
            execSync(
              `herdr agent prompt "${name}" "${escapedPrompt}" --wait --timeout ${timeout}`,
              { encoding: "utf-8" }
            );
            
            // Read response
            const response = execSync(
              `herdr agent read "${name}" --source recent-unwrapped --lines 100`,
              { encoding: "utf-8" }
            );
            
            // Cleanup
            execSync(`herdr pane close "${newPaneId}" 2>/dev/null || true`, {
              encoding: "utf-8",
            });
            
            return {
              message: `✅ Agent \"${name}\" completed in pane ${newPaneId}\n\n${response}`,
            };
          } catch (error: any) {
            return { error: `Failed: ${error.message}` };
          }
        },
      },
      {
        name: "spawnp",
        description:
          "Quick spawn: /spawnp <prompt> [model] - spawns agent with auto-generated name",
        execute: async (args: string) => {
          if (!args.trim()) {
            return { error: "Usage: /spawnp <prompt> [model]" };
          }
          // Delegate to /spawn with auto-generated name
          const autoName = `pi-${Date.now().toString(36)}`;
          return this.commands!.find((c) => c.name === "spawn")!.execute(
            `${args.trim()} ${autoName} ${args.split(' ').slice(1).join(' ') || ''}`.trim()
          );
        },
      },
      {
        name: "spawnlist",
        description: "List all currently running spawned agents",
        execute: async () => {
          if (process.env.HERDR_ENV !== "1") {
            return { error: "Not running in Herdr environment" };
          }
          
          try {
            const { execSync } = require("child_process");
            const result = execSync("herdr agent list", { encoding: "utf-8" });
            const agents = JSON.parse(result);
            
            if (!agents.result?.agents?.length) {
              return { message: "No agents currently running." };
            }
            
            const list = agents.result.agents
              .map((a: any) => `- ${a.name} (${a.agent_status}) in ${a.pane_id}`)
              .join("\n");
            
            return { message: `Running agents:\n${list}` };
          } catch (error: any) {
            return { error: `Failed: ${error.message}` };
          }
        },
      },
      {
        name: "spawnkill",
        description: "Kill a spawned agent by name: /spawnkill <agent-name>",
        execute: async (args: string) => {
          const agentName = args.trim();
          if (!agentName) {
            return { error: "Usage: /spawnkill <agent-name>" };
          }
          
          if (process.env.HERDR_ENV !== "1") {
            return { error: "Not running in Herdr environment" };
          }
          
          try {
            const { execSync } = require("child_process");
            
            // Get agent info to find pane ID
            const agentInfo = execSync(`herdr agent get "${agentName}"`, {
              encoding: "utf-8",
            });
            const agent = JSON.parse(agentInfo);
            const paneId = agent.result?.agent?.pane_id;
            
            if (!paneId) {
              return { error: `Agent "${agentName}" not found` };
            }
            
            // Close the pane (this stops the agent)
            execSync(`herdr pane close "${paneId}"`, { encoding: "utf-8" });
            
            return { message: `✅ Killed agent "${agentName}" in pane ${paneId}` };
          } catch (error: any) {
            return { error: `Failed: ${error.message}` };
          }
        },
      },
    ],
    tools: [
      {
        name: "spawn_pi",
        description:
          "Spawn a pi agent in a new Herdr pane, send a prompt, wait for response, and return the result. The pane is automatically closed after completion.",
        inputSchema: SpawnPiInput,
        execute: async (input: z.infer<typeof SpawnPiInput>) => {
          // Check if we're in Herdr
          const herdrEnv = process.env.HERDR_ENV;
          if (herdrEnv !== "1") {
            return {
              error: "Not running in Herdr environment. Cannot spawn pane.",
            };
          }

          const { prompt, timeout = 120000, direction = "right" } = input;
          const agentName =
            input.name ||
            `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

          // Validate agent name
          if (!/^[a-z][a-z0-9_-]{0,30}$/.test(agentName)) {
            return {
              error:
                "Agent name must be lowercase letters, numbers, hyphens; max 31 chars",
            };
          }

          try {
            // We'll use bash commands to interact with herdr CLI
            // since this extension runs in the pi process
            
            // Get current pane context
            const currentResult = await execCommand(
              "herdr pane current --current"
            );
            const current = JSON.parse(currentResult);
            const currentPaneId = current.result?.pane?.pane_id;
            
            if (!currentPaneId) {
              return { error: "Could not get current pane ID" };
            }
            
            // Create new pane
            const splitResult = await execCommand(
              `herdr pane split --current --direction ${direction} --cwd "${process.env.PWD}" --no-focus`
            );
            const split = JSON.parse(splitResult);
            const newPaneId = split.result?.pane?.pane_id;
            
            if (!newPaneId) {
              return { error: "Could not create new pane" };
            }
            
            // Build agent start command with optional model argument
            let startCmd = `herdr agent start "${agentName}" --kind pi --pane "${newPaneId}"`;
            if (model) {
              startCmd += ` -- --model "${model}"`;
            }
            
            // Start pi agent
            const startResult = await execCommand(startCmd);
            const start = JSON.parse(startResult);
            
            if (!start.result?.agent?.agent_status) {
              return { error: "Failed to start agent" };
            }
            
            // Send prompt (escape quotes in prompt)
            const escapedPrompt = prompt.replace(/"/g, '\\"');
            const promptResult = await execCommand(
              `herdr agent prompt "${agentName}" "${escapedPrompt}" --wait --timeout ${timeout}`
            );
            const promptRes = JSON.parse(promptResult);

            if (promptRes.type !== "agent_prompted") {
              // Cleanup on failure
              await execCommand(`herdr pane close "${newPaneId}" 2>/dev/null || true`);
              return { error: "Failed to send prompt" };
            }

            // Read response
            const readResult = await execCommand(
              `herdr agent read "${agentName}" --source recent-unwrapped --lines 100`
            );

            // Cleanup: close the pane
            await execCommand(`herdr pane close "${newPaneId}" 2>/dev/null || true`);

            return {
              pane_id: newPaneId,
              agent_name: agentName,
              status: "completed",
              response: readResult,
            };
          } catch (error) {
            return {
              error: `Failed to spawn pi agent: ${error.message}`,
            };
          }
        },
      },
    ],
  };
}

// Helper function to execute bash commands
async function execCommand(command: string): Promise<string> {
  const { execSync } = require("child_process");
  try {
    return execSync(command, {
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error: any) {
    throw new Error(
      `Command failed: ${command}\n${error.stderr || error.message}`
    );
  }
}

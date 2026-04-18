import type { AgentMemoryConfig } from "../types.js";
import { CopilotCliModelProvider } from "./copilot-cli-provider.js";
import { CopilotSdkModelProvider } from "./copilot-sdk-provider.js";
import type { ModelProvider } from "./model-provider.js";

export function createModelProvider(config: AgentMemoryConfig): ModelProvider {
  if (config.model.provider === "copilot-cli") {
    return new CopilotCliModelProvider({
      command: config.model.command ?? "copilot",
      args: config.model.args ?? ["ask", "{prompt}"],
      promptInput: config.model.promptInput ?? "argument",
      timeoutMs: config.model.timeoutMs
    });
  }

  return new CopilotSdkModelProvider({
    model: config.model.model,
    reasoningEffort: config.model.reasoningEffort,
    timeoutMs: config.model.timeoutMs,
    cliPath: config.model.cliPath,
    cliUrl: config.model.cliUrl,
    cliArgs: config.model.cliArgs,
    cwd: config.model.cwd,
    configDir: config.model.configDir,
    githubToken: config.model.githubToken,
    useLoggedInUser: config.model.useLoggedInUser,
    logLevel: config.model.logLevel
  });
}

import type { AgentMemoryConfig } from "../types.js";
import { defaultCopilotTraceDir } from "../config.js";
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
    traceDir: config.model.traceDir ?? defaultCopilotTraceDir(config.vaultPath),
    githubToken: config.model.githubToken,
    useLoggedInUser: config.model.useLoggedInUser,
    logLevel: config.model.logLevel
  });
}

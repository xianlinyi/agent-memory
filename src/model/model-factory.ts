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

  const githubToken = resolveGithubToken(config, process.env);
  const useLoggedInUser = config.model.useLoggedInUser ?? (githubToken ? false : undefined);

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
    githubToken,
    useLoggedInUser,
    logLevel: config.model.logLevel
  });
}

function resolveGithubToken(config: AgentMemoryConfig, env: NodeJS.ProcessEnv): string | undefined {
  return config.model.githubToken?.trim() || env.AGENT_MEMORY_GITHUB_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || undefined;
}

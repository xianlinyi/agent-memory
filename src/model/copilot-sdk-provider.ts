import { approveAll, CopilotClient } from "@github/copilot-sdk";
import type { CopilotClientOptions, SessionConfig } from "@github/copilot-sdk";
import type { ExtractedMemory, MemoryMatch, QueryHopCandidate, QueryHopDecision, QueryInterpretation } from "../types.js";
import {
  answerPrompt,
  compactPrompt,
  extractionPrompt,
  parseRequiredExtraction,
  parseRequiredQueryHopDecision,
  parseRequiredQueryInterpretation,
  queryHopPrompt,
  queryPrompt
} from "./extraction.js";
import type { ModelProvider } from "./model-provider.js";

export interface CopilotSdkModelProviderOptions {
  model?: string;
  reasoningEffort?: SessionConfig["reasoningEffort"];
  timeoutMs: number;
  cliPath?: string;
  cliUrl?: string;
  cliArgs?: string[];
  cwd?: string;
  configDir?: string;
  githubToken?: string;
  useLoggedInUser?: boolean;
  logLevel?: CopilotClientOptions["logLevel"];
}

export class CopilotSdkModelProvider implements ModelProvider {
  private client?: CopilotClient;

  constructor(private readonly options: CopilotSdkModelProviderOptions) {
    validateOptions(options);
  }

  async extractMemory(input: { text: string }): Promise<ExtractedMemory> {
    const output = await this.send(extractionPrompt(input.text));
    return parseRequiredExtraction(output);
  }

  async extractQuery(input: { text: string }): Promise<QueryInterpretation> {
    const output = await this.send(queryPrompt(input.text));
    return parseRequiredQueryInterpretation(output);
  }

  async decideQueryHop(input: {
    query: string;
    interpretation: QueryInterpretation;
    hop: number;
    maxHops: number;
    matches: MemoryMatch[];
    candidates: QueryHopCandidate[];
    visitedNodeIds: string[];
  }): Promise<QueryHopDecision> {
    const output = await this.send(queryHopPrompt(input));
    return parseRequiredQueryHopDecision(output);
  }

  async synthesizeAnswer(input: { query: string; interpretation: QueryInterpretation; matches: MemoryMatch[] }): Promise<string> {
    const output = await this.send(answerPrompt(input.query, input.interpretation, input.matches));
    if (!output?.trim()) {
      throw new Error("LLM answer synthesis failed: provider returned no content.");
    }
    return output.trim();
  }

  async compact(input: { text: string }): Promise<string> {
    const output = await this.send(compactPrompt(input.text));
    if (!output?.trim()) {
      throw new Error("LLM compaction failed: provider returned no content.");
    }
    return output.trim();
  }

  async doctor(input?: { modelCall?: boolean }): Promise<{ ok: boolean; message: string }> {
    try {
      const client = await this.getClient();
      const [status, auth] = await Promise.all([client.getStatus(), client.getAuthStatus()]);
      if (!auth.isAuthenticated) {
        return {
          ok: false,
          message: auth.statusMessage || "Copilot SDK reached the CLI, but the user is not authenticated."
        };
      }
      if (input?.modelCall) {
        const output = await this.send("Reply with exactly: agent-memory-ok");
        if (!output?.toLowerCase().includes("agent-memory-ok")) {
          return { ok: false, message: `Copilot SDK model call returned unexpected output: ${(output ?? "").slice(0, 120)}` };
        }
      }
      return {
        ok: true,
        message: input?.modelCall
          ? `Copilot SDK model call succeeded via CLI ${status.version}; authenticated as ${auth.login ?? auth.authType ?? "user"}.`
          : `Copilot SDK connected to CLI ${status.version}; authenticated as ${auth.login ?? auth.authType ?? "user"}.`
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.stop().catch(() => []);
      this.client = undefined;
    }
  }

  private async send(prompt: string): Promise<string | undefined> {
    try {
      return await this.ask(prompt);
    } catch (error) {
      throw new Error(`LLM provider call failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async ask(prompt: string): Promise<string | undefined> {
    const client = await this.getClient();
    const session = await client.createSession(this.sessionConfig());
    try {
      const response = await session.sendAndWait({ prompt }, this.options.timeoutMs);
      return response?.data.content?.trim();
    } finally {
      await session.disconnect().catch(() => undefined);
    }
  }

  private async getClient(): Promise<CopilotClient> {
    if (!this.client) {
      this.client = new CopilotClient(this.clientOptions());
      await this.client.start();
    }
    return this.client;
  }

  private clientOptions(): CopilotClientOptions {
    return stripUndefined({
      cliPath: this.options.cliPath,
      cliUrl: this.options.cliUrl,
      cliArgs: this.options.cliArgs,
      cwd: this.options.cwd,
      githubToken: this.options.githubToken,
      useLoggedInUser: this.options.useLoggedInUser,
      logLevel: this.options.logLevel
    });
  }

  private sessionConfig(): SessionConfig {
    return stripUndefined({
      clientName: "agent-memory-knowledge-graph",
      model: this.options.model,
      reasoningEffort: this.options.reasoningEffort,
      onPermissionRequest: approveAll,
      configDir: this.options.configDir,
      workingDirectory: this.options.cwd
    });
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function validateOptions(options: CopilotSdkModelProviderOptions): void {
  if (!options.model?.trim()) {
    throw new Error("LLM provider is not configured: model.model is required for copilot-sdk.");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("LLM provider is not configured: model.timeoutMs must be a positive number.");
  }
}

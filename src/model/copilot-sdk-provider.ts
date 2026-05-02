import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { approveAll, CopilotClient } from "@github/copilot-sdk";
import type { CopilotClientOptions, CopilotSession, SessionConfig } from "@github/copilot-sdk";
import type { RawDocument, WikiLintIssue, WikiPage, WikiSchema, WikiSearchResult, WikiUpdatePlan } from "../types.js";
import { parseRequiredWikiLintIssues, parseRequiredWikiUpdatePlan, wikiAnswerPrompt, wikiLintPrompt, wikiUpdatePlanPrompt } from "./extraction.js";
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
  traceDir?: string;
  githubToken?: string;
  useLoggedInUser?: boolean;
  logLevel?: CopilotClientOptions["logLevel"];
}

export class CopilotSdkModelProvider implements ModelProvider {
  private client?: CopilotClient;

  constructor(private readonly options: CopilotSdkModelProviderOptions) {
    validateOptions(options);
  }

  async planWikiUpdates(input: { raw: RawDocument; existingPages: WikiPage[]; schema: WikiSchema }): Promise<WikiUpdatePlan> {
    const output = await this.send(wikiUpdatePlanPrompt(input));
    return parseRequiredWikiUpdatePlan(output, input.raw.id);
  }

  async synthesizeWikiAnswer(input: { query: string; results: WikiSearchResult[]; schema: WikiSchema }): Promise<string> {
    const output = await this.send(wikiAnswerPrompt(input));
    if (!output?.trim()) throw new Error("LLM answer synthesis failed: provider returned no content.");
    return output.trim();
  }

  async lintWiki(input: { pages: WikiPage[]; rawDocuments: RawDocument[]; schema: WikiSchema }): Promise<WikiLintIssue[]> {
    const output = await this.send(wikiLintPrompt(input));
    return parseRequiredWikiLintIssues(output);
  }

  async doctor(input?: { modelCall?: boolean }): Promise<{ ok: boolean; message: string }> {
    try {
      const client = await this.getClient();
      const [status, auth] = await Promise.all([client.getStatus(), client.getAuthStatus()]);
      if (!auth.isAuthenticated) {
        return { ok: false, message: auth.statusMessage || "Copilot SDK reached the CLI, but the user is not authenticated." };
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
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
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
    const trace = this.createTrace(session);
    const unsubscribe = session.on((event) => {
      void trace.write("event", { eventType: event.type, event });
    });
    try {
      await trace.write("session.created", {
        sessionId: session.sessionId,
        workspacePath: session.workspacePath,
        model: this.options.model,
        reasoningEffort: this.options.reasoningEffort,
        configDir: this.options.configDir,
        cwd: this.options.cwd
      });
      await trace.write("prompt", { prompt });
      const response = await session.sendAndWait({ prompt }, this.options.timeoutMs);
      const output = response?.data.content?.trim();
      await trace.write("response", { output, response });
      return output;
    } catch (error) {
      await trace.write("error", { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      throw error;
    } finally {
      unsubscribe();
      await session.disconnect().catch((error) => trace.write("disconnect.error", { message: error instanceof Error ? error.message : String(error) }));
      await trace.write("session.disconnected", { sessionId: session.sessionId });
    }
  }

  private createTrace(session: CopilotSession): CopilotTrace {
    if (!this.options.traceDir) return new NoopCopilotTrace();
    return new FileCopilotTrace(this.options.traceDir, session.sessionId);
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
      clientName: "agent-memory-llm-wiki",
      model: this.options.model,
      reasoningEffort: this.options.reasoningEffort,
      tools: [],
      mcpServers: {},
      onPermissionRequest: approveAll
    }) as SessionConfig;
  }
}

interface CopilotTrace {
  write(event: string, payload: Record<string, unknown>): Promise<void>;
}

class NoopCopilotTrace implements CopilotTrace {
  async write(): Promise<void> {}
}

class FileCopilotTrace implements CopilotTrace {
  constructor(
    private readonly traceDir: string,
    private readonly sessionId: string
  ) {}

  async write(event: string, payload: Record<string, unknown>): Promise<void> {
    await mkdir(this.traceDir, { recursive: true });
    await appendFile(join(this.traceDir, `${this.sessionId}.jsonl`), `${JSON.stringify({ event, ...payload, timestamp: new Date().toISOString() })}\n`, "utf8");
  }
}

function validateOptions(options: CopilotSdkModelProviderOptions): void {
  if (!options.model?.trim()) throw new Error("LLM provider is not configured: model.model is required for copilot-sdk.");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("LLM provider is not configured: model.timeoutMs must be a positive number.");
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

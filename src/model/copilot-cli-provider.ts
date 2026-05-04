import { spawn } from "node:child_process";
import type { RawDocument, WikiLintIssue, WikiPage, WikiSchema, WikiSearchResult, WikiUpdatePlan } from "../types.js";
import { parseRequiredWikiLintIssues, parseRequiredWikiUpdatePlan, wikiAnswerPrompt, wikiLintPrompt, wikiUpdatePlanPrompt } from "./extraction.js";
import type { ModelProvider } from "./model-provider.js";

export interface CopilotCliModelProviderOptions {
  command: string;
  args: string[];
  promptInput?: "stdin" | "argument";
  timeoutMs: number;
}

export class CopilotCliModelProvider implements ModelProvider {
  constructor(private readonly options: CopilotCliModelProviderOptions) {
    if (!options.command?.trim()) {
      throw new Error("LLM provider is not configured: model.command is required for copilot-cli.");
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("LLM provider is not configured: model.timeoutMs must be a positive number.");
    }
  }

  async planWikiUpdates(input: { raw: RawDocument; existingPages: WikiPage[]; schema: WikiSchema }): Promise<WikiUpdatePlan> {
    const output = await this.tryRun(wikiUpdatePlanPrompt(input));
    return parseRequiredWikiUpdatePlan(output, input.raw.id);
  }

  async synthesizeWikiAnswer(input: { query: string; results: WikiSearchResult[]; schema: WikiSchema }): Promise<string> {
    const output = await this.tryRun(wikiAnswerPrompt(input));
    if (!output?.trim()) throw new Error("LLM answer synthesis failed: provider returned no content.");
    return output.trim();
  }

  async lintWiki(input: { pages: WikiPage[]; rawDocuments: RawDocument[]; schema: WikiSchema }): Promise<WikiLintIssue[]> {
    const output = await this.tryRun(wikiLintPrompt(input));
    return parseRequiredWikiLintIssues(output);
  }

  async doctor(input?: { modelCall?: boolean }): Promise<{ ok: boolean; message: string }> {
    const prompt = input?.modelCall ? "Reply with exactly: agent-memory-ok" : "Say OK if this Copilot-compatible CLI is available.";
    try {
      const output = await this.tryRun(prompt, 5000);
      if (!output) return { ok: false, message: `Copilot CLI command returned no output: ${this.options.command} ${this.options.args.join(" ")}` };
      if (input?.modelCall && !output.toLowerCase().includes("agent-memory-ok")) {
        return { ok: false, message: `Copilot CLI responded, but model check returned unexpected output: ${output.slice(0, 120)}` };
      }
      return { ok: true, message: input?.modelCall ? "Copilot CLI model call succeeded." : "Copilot CLI command responded." };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async tryRun(prompt: string, timeoutMs = this.options.timeoutMs): Promise<string | undefined> {
    try {
      return await runCommand(this.options.command, this.options.args, prompt, this.options.promptInput, timeoutMs);
    } catch (error) {
      throw new Error(`LLM provider call failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function runCommand(command: string, args: string[], prompt: string, promptInput: "stdin" | "argument" | undefined, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const resolvedArgs = resolvePromptArgs(args, prompt, promptInput);
    const stdin = shouldWritePromptToStdin(args, promptInput) ? prompt : undefined;
    const child = spawn(command, resolvedArgs, { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Model command timed out."));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `Model command exited with ${code}.`));
    });
    child.stdin.end(stdin);
  });
}

function resolvePromptArgs(args: string[], prompt: string, promptInput: "stdin" | "argument" | undefined): string[] {
  if (args.some((arg) => arg.includes("{prompt}"))) return args.map((arg) => arg.replaceAll("{prompt}", prompt));
  if (promptInput === "argument") return [...args, prompt];
  return args;
}

function shouldWritePromptToStdin(args: string[], promptInput: "stdin" | "argument" | undefined): boolean {
  return promptInput !== "argument" && !args.some((arg) => arg.includes("{prompt}"));
}

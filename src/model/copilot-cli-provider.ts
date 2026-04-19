import { spawn } from "node:child_process";
import type { ExtractedMemory, IngestKeyInformation, IngestReviewDecision, MemoryMatch, QueryHopCandidate, QueryHopDecision, QueryInterpretation } from "../types.js";
import {
  answerPrompt,
  compactPrompt,
  extractionPrompt,
  ingestEntitiesPrompt,
  ingestKeyInformationPrompt,
  ingestOutcomePrompt,
  ingestReviewPrompt,
  parseRequiredIngestKeyInformation,
  parseRequiredIngestReviewDecision,
  parseRequiredExtraction,
  parseRequiredQueryHopDecision,
  parseRequiredQueryInterpretation,
  queryHopPrompt,
  queryPrompt
} from "./extraction.js";
import type { ModelProvider } from "./model-provider.js";
import type { IngestModelSession } from "./model-provider.js";

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

  async extractMemory(input: { text: string }): Promise<ExtractedMemory> {
    const output = await this.tryRun(extractionPrompt(input.text));
    return parseRequiredExtraction(output);
  }

  async startIngestSession(): Promise<IngestModelSession> {
    const transcript: Array<{ prompt: string; response: string }> = [];
    const run = async (prompt: string) => {
      const contextualPrompt = transcript.length === 0 ? prompt : `${formatTranscript(transcript)}\n\nNext prompt:\n${prompt}`;
      const output = await this.tryRun(contextualPrompt);
      transcript.push({ prompt, response: output ?? "" });
      return output;
    };

    return {
      extractKeyInformation: async (input: { text: string }): Promise<IngestKeyInformation> => parseRequiredIngestKeyInformation(await run(ingestKeyInformationPrompt(input.text))),
      extractEntitiesAndRelations: async (input: { keyInformation: IngestKeyInformation }): Promise<ExtractedMemory> =>
        parseRequiredExtraction(await run(ingestEntitiesPrompt(input.keyInformation))),
      classifyOutcomeAndExtractSuccess: async (input: { keyInformation: IngestKeyInformation; extraction: ExtractedMemory }): Promise<ExtractedMemory> =>
        parseRequiredExtraction(await run(ingestOutcomePrompt(input))),
      reviewIngestMemory: async (input: { extraction: ExtractedMemory; candidates: MemoryMatch[] }): Promise<IngestReviewDecision> =>
        parseRequiredIngestReviewDecision(await run(ingestReviewPrompt(input)), input.candidates)
    };
  }

  async reviewIngestMemory(input: { extraction: ExtractedMemory; candidates: MemoryMatch[] }): Promise<IngestReviewDecision> {
    const output = await this.tryRun(ingestReviewPrompt(input));
    return parseRequiredIngestReviewDecision(output, input.candidates);
  }

  async extractQuery(input: { text: string }): Promise<QueryInterpretation> {
    const output = await this.tryRun(queryPrompt(input.text));
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
    const output = await this.tryRun(queryHopPrompt(input));
    return parseRequiredQueryHopDecision(output);
  }

  async synthesizeAnswer(input: { query: string; interpretation: QueryInterpretation; matches: MemoryMatch[] }): Promise<string> {
    const output = await this.tryRun(answerPrompt(input.query, input.interpretation, input.matches));
    if (!output?.trim()) {
      throw new Error("LLM answer synthesis failed: provider returned no content.");
    }
    return output.trim();
  }

  async compact(input: { text: string }): Promise<string> {
    const output = await this.tryRun(compactPrompt(input.text));
    if (!output?.trim()) {
      throw new Error("LLM compaction failed: provider returned no content.");
    }
    return output.trim();
  }

  async doctor(input?: { modelCall?: boolean }): Promise<{ ok: boolean; message: string }> {
    const prompt = input?.modelCall ? "Reply with exactly: agent-memory-ok" : "Say OK if this Copilot-compatible CLI is available.";
    let output: string | undefined;
    try {
      output = await this.tryRun(prompt, 5000);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
    if (!output) {
      return {
        ok: false,
        message: `Copilot CLI command returned no output: ${this.options.command} ${this.options.args.join(" ")}`
      };
    }
    if (input?.modelCall && !output.toLowerCase().includes("agent-memory-ok")) {
      return { ok: false, message: `Copilot CLI responded, but model check returned unexpected output: ${output.slice(0, 120)}` };
    }
    return { ok: true, message: input?.modelCall ? "Copilot CLI model call succeeded." : "Copilot CLI command responded." };
  }

  private async tryRun(prompt: string, timeoutMs = this.options.timeoutMs): Promise<string | undefined> {
    try {
      return await runCommand(this.options.command, this.options.args, prompt, this.options.promptInput, timeoutMs);
    } catch (error) {
      throw new Error(`LLM provider call failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function formatTranscript(transcript: Array<{ prompt: string; response: string }>): string {
  return [
    "Previous messages in this ingest session:",
    ...transcript.flatMap((item, index) => [`Prompt ${index + 1}:`, item.prompt, `Response ${index + 1}:`, item.response])
  ].join("\n");
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
  if (args.some((arg) => arg.includes("{prompt}"))) {
    return args.map((arg) => arg.replaceAll("{prompt}", prompt));
  }
  if (promptInput === "argument") {
    return [...args, prompt];
  }
  return args;
}

function shouldWritePromptToStdin(args: string[], promptInput: "stdin" | "argument" | undefined): boolean {
  return promptInput !== "argument" && !args.some((arg) => arg.includes("{prompt}"));
}

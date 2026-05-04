#!/usr/bin/env node
import { defaultVaultPath } from "../config.js";
import { MemoryEngineExecutor } from "../core/engine-executor.js";
import { appendNodeOption, createCliLogger } from "../utils/logger.js";
import { parseArgs, stringFlag } from "./args.js";
import { handleConfig, handleCopilot, handleDefault } from "./config-command.js";
import { handleEngineCommand } from "./engine-command.js";
import { printHelp } from "./help.js";
import { handleUpgrade, handleVersion } from "./package-command.js";

async function main(): Promise<void> {
  process.env.NODE_OPTIONS = appendNodeOption(process.env.NODE_OPTIONS, "--disable-warning=ExperimentalWarning");

  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.command;
  const logger = await createCliLogger({ verbose: parsed.flags.has("verbose"), logFile: stringFlag(parsed, "log-file") });
  try {
    if (command === "version" || command === "--version" || command === "-v" || parsed.flags.has("version")) {
      await handleVersion(parsed);
      return;
    }

    if (!command || command === "help" || parsed.flags.has("help")) {
      printHelp();
      return;
    }

    if (command === "upgrade") {
      await handleUpgrade(parsed);
      return;
    }

    if (command === "default") {
      await handleDefault(parsed);
      return;
    }

    const vaultPath = stringFlag(parsed, "vault") ?? (await defaultVaultPath());
    await logger.debug(`command=${command} vault=${vaultPath}`);
    if (command === "config") {
      await handleConfig(vaultPath, parsed);
      return;
    }

    if (command === "copilot") {
      await handleCopilot(vaultPath, parsed);
      return;
    }

    const executor = await MemoryEngineExecutor.create({ vaultPath, logger });
    await executor.run(command, (engine) => handleEngineCommand(engine, command, parsed, logger));
  } finally {
    await logger.close?.();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

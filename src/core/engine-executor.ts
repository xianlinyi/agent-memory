import { MemoryEngine } from "./memory-engine.js";
import type { Logger } from "../utils/logger.js";

export interface MemoryEngineExecutorOptions {
  vaultPath: string;
  logger?: Logger;
}

export class MemoryEngineExecutor {
  private constructor(
    private readonly engine: MemoryEngine,
    private readonly logger?: Logger
  ) {}

  static async create(options: MemoryEngineExecutorOptions): Promise<MemoryEngineExecutor> {
    await options.logger?.debug("creating memory engine");
    const engine = await MemoryEngine.create({ vaultPath: options.vaultPath });
    return new MemoryEngineExecutor(engine, options.logger);
  }

  async run<T>(label: string, operation: (engine: MemoryEngine) => Promise<T>): Promise<T> {
    try {
      await this.logger?.debug(`running ${label}`);
      return await operation(this.engine);
    } finally {
      await this.logger?.debug("closing memory engine");
      await this.engine.close();
    }
  }
}

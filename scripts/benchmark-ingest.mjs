#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { MemoryEngine } from "../dist/src/index.js";

const count = Number(process.argv[2] ?? 100);

class BenchmarkProvider {
  async planWikiUpdates({ raw }) {
    const projectNumber = raw.text.match(/Project (\d+)/)?.[1] ?? "0";
    const title = `Project ${projectNumber}`;
    return {
      pages: [
        {
          title,
          type: "project",
          summary: `${title} uses Obsidian memory.`,
          tags: ["benchmark"],
          aliases: [`P${projectNumber}`],
          links: ["Obsidian"],
          sourceIds: [raw.id],
          body: [`# ${title}`, "", `${title} uses [[Obsidian]] for local agent memory.`, "", "## Sources", `- ${raw.id}`].join("\n")
        }
      ]
    };
  }

  async synthesizeWikiAnswer() {
    throw new Error("unused");
  }
}

const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-benchmark-"));
const engine = await MemoryEngine.create({ vaultPath, modelProvider: new BenchmarkProvider() });

try {
  await engine.init();
  const startedAt = performance.now();

  for (let index = 0; index < count; index += 1) {
    await engine.ingest({ text: `Project ${index} uses Obsidian for memory.` });
  }

  const durationMs = performance.now() - startedAt;
  const status = await engine.status();
  console.log(
    JSON.stringify(
      {
        count,
        durationMs: Number(durationMs.toFixed(2)),
        averageMs: Number((durationMs / count).toFixed(3)),
        finalCounts: status.counts
      },
      null,
      2
    )
  );
} finally {
  await engine.close();
  await rm(vaultPath, { recursive: true, force: true });
}

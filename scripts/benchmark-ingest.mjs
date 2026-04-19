#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { MemoryEngine } from "../dist/src/index.js";

const count = Number(process.argv[2] ?? 1000);
const duplicateEvery = Number(process.argv[3] ?? 10);

class BenchmarkProvider {
  async extractMemory({ text }) {
    const projectNumber = text.match(/Project (\d+)/)?.[1] ?? "0";
    const projectName = `Project ${projectNumber}`;
    return {
      summary: `${projectName} uses Obsidian memory`,
      entities: [
        {
          name: projectName,
          type: "project",
          summary: `${projectName} stores local agent memory.`,
          aliases: [`P${projectNumber}`],
          tags: ["benchmark"],
          confidence: 0.9
        },
        {
          name: "Obsidian",
          type: "artifact",
          summary: "Obsidian stores Markdown vault notes.",
          aliases: [],
          tags: ["tool"],
          confidence: 0.9
        }
      ],
      relations: [
        {
          sourceId: projectName,
          targetId: "Obsidian",
          predicate: "uses",
          description: `${projectName} uses Obsidian for memory.`,
          confidence: 0.9
        }
      ]
    };
  }

  async extractQuery() {
    throw new Error("unused");
  }

  async synthesizeAnswer() {
    throw new Error("unused");
  }
}

const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-benchmark-"));
const engine = await MemoryEngine.create({ vaultPath, modelProvider: new BenchmarkProvider() });

try {
  await engine.init();
  const startedAt = performance.now();
  const statuses = new Map();

  for (let index = 0; index < count; index += 1) {
    const projectNumber = duplicateEvery > 0 && index % duplicateEvery === 0 ? 0 : index;
    const result = await engine.ingest({ text: `Project ${projectNumber} uses Obsidian for memory.` });
    statuses.set(result.meta.status, (statuses.get(result.meta.status) ?? 0) + 1);
  }

  const durationMs = performance.now() - startedAt;
  const snapshot = await engine.export();
  console.log(
    JSON.stringify(
      {
        count,
        duplicateEvery,
        durationMs: Number(durationMs.toFixed(2)),
        averageMs: Number((durationMs / count).toFixed(3)),
        statuses: Object.fromEntries(statuses),
        finalCounts: {
          entities: snapshot.entities.length,
          relations: snapshot.relations.length,
          episodes: snapshot.episodes.length
        }
      },
      null,
      2
    )
  );
} finally {
  await engine.close();
  await rm(vaultPath, { recursive: true, force: true });
}

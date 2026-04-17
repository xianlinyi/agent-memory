import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryEngine, type ModelProvider, type ExtractedMemory, type QueryHopDecision, type QueryInterpretation } from "../src/index.js";

class FakeModelProvider implements ModelProvider {
  async extractMemory(): Promise<ExtractedMemory> {
    return {
      summary: "Project Atlas uses Obsidian memory",
      entities: [
        { name: "Ada Lovelace", type: "person", aliases: ["Ada"], tags: ["person"], confidence: 0.9 },
        { name: "Project Atlas", type: "project", aliases: ["Atlas"], tags: ["project"], confidence: 0.9 },
        { name: "Login regression", type: "bug", aliases: [], tags: ["bug"], confidence: 0.8 },
        { name: "Local-first rule", type: "rule", aliases: [], tags: ["rule"], confidence: 0.8 },
        { name: "Obsidian", type: "artifact", aliases: [], tags: ["tool"], confidence: 0.9 }
      ],
      relations: [
        {
          sourceId: "Project Atlas",
          targetId: "Obsidian",
          predicate: "uses",
          description: "Project Atlas uses Obsidian for memory.",
          confidence: 0.9,
          weight: 1
        }
      ]
    };
  }

  async extractQuery(): Promise<QueryInterpretation> {
    return {
      keywords: ["Atlas", "Obsidian", "memory"],
      entities: ["Project Atlas", "Obsidian"],
      predicates: ["uses"],
      expandedQuery: "Atlas Obsidian memory uses"
    };
  }

  async synthesizeAnswer(): Promise<string> {
    return "Project Atlas uses Obsidian for memory.";
  }
}

class NavigatingModelProvider extends FakeModelProvider {
  decisions: Array<{ hop: number; candidates: string[] }> = [];

  async decideQueryHop(input: Parameters<NonNullable<ModelProvider["decideQueryHop"]>>[0]): Promise<QueryHopDecision> {
    this.decisions.push({ hop: input.hop, candidates: input.candidates.map((candidate) => candidate.title) });
    if (input.hop === 0) {
      const atlas = input.candidates.find((candidate) => candidate.title === "Project Atlas");
      return { continue: Boolean(atlas), nodeIds: atlas ? [atlas.id] : [], reason: "Need direct Atlas relationships." };
    }
    return { continue: false, nodeIds: [], reason: "Enough evidence has been gathered." };
  }
}

test("engine initializes, ingests, queries, links, rebuilds, and exports graph memory", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-test-"));
  const engine = await MemoryEngine.create({ vaultPath, modelProvider: new FakeModelProvider() });

  try {
    await engine.init();
    for (const path of [
      join(vaultPath, "People"),
      join(vaultPath, "Projects"),
      join(vaultPath, "Bugs"),
      join(vaultPath, "Rules"),
      join(vaultPath, "Concepts"),
      join(vaultPath, "Sessions"),
      join(vaultPath, "Graph"),
      join(vaultPath, "Dashboards"),
      join(vaultPath, "Templates"),
      join(vaultPath, ".kg", "logs"),
      join(vaultPath, ".kg", "config.json"),
      join(vaultPath, ".kg", "graph.db"),
      join(vaultPath, "Dashboards", "Overview.md"),
      join(vaultPath, "Templates", "Person.md"),
      join(vaultPath, "Templates", "Project.md"),
      join(vaultPath, "Templates", "Bug.md"),
      join(vaultPath, "Templates", "Rule.md"),
      join(vaultPath, "Templates", "Concept.md"),
      join(vaultPath, "Templates", "Session.md")
    ]) {
      await access(path);
    }

    const ingest = await engine.ingest({
      text: "Project Atlas uses Obsidian for memory.",
      source: { kind: "message", label: "Test chat", uri: "memory://test-chat" }
    });
    assert.equal(ingest.entities.length, 5);
    assert.equal(ingest.relations.length, 1);
    assert.match(ingest.entities.find((entity) => entity.type === "person")?.filePath ?? "", /^People\//);
    assert.match(ingest.entities.find((entity) => entity.type === "project")?.filePath ?? "", /^Projects\//);
    assert.match(ingest.entities.find((entity) => entity.type === "bug")?.filePath ?? "", /^Bugs\//);
    assert.match(ingest.entities.find((entity) => entity.type === "rule")?.filePath ?? "", /^Rules\//);
    assert.match(ingest.entities.find((entity) => entity.type === "artifact")?.filePath ?? "", /^Concepts\//);
    assert.match(ingest.episode.filePath ?? "", /^Sessions\//);
    assert.match(ingest.relations[0]?.filePath ?? "", /^Graph\//);

    const sessionMarkdown = await readFile(join(vaultPath, ingest.episode.filePath ?? ""), "utf8");
    assert.match(sessionMarkdown, /source_kind: message/);
    assert.match(sessionMarkdown, /source_label: Test chat/);
    assert.doesNotMatch(sessionMarkdown, /Sources\//);

    const query = await engine.query({ text: "Atlas Obsidian", limit: 5 });
    assert.equal(query.interpretation.expandedQuery, "Atlas Obsidian memory uses");
    assert.equal(query.answer, "Project Atlas uses Obsidian for memory.");
    assert.ok(query.matches.some((match) => match.kind === "entity" && match.title === "Project Atlas"));

    const manual = await engine.link({
      from: ingest.entities[0].id,
      to: ingest.entities[1].id,
      type: "documents_in"
    });
    assert.equal(manual.predicate, "documents_in");

    await engine.rebuild();
    const snapshot = await engine.export();
    assert.equal(snapshot.entities.length, 5);
    assert.ok(snapshot.relations.length >= 1);
    assert.equal(snapshot.sources.length, 1);
    assert.equal(snapshot.sources[0]?.label, "Test chat");

    const status = await engine.status();
    assert.equal(status.counts.entities, 5);
    assert.equal(status.counts.sources, 1);
  } finally {
    await engine.close();
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("engine refuses query when provider cannot interpret with an LLM", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-no-llm-"));
  const engine = await MemoryEngine.create({
    vaultPath,
    modelProvider: {
      async extractMemory() {
        return {
          summary: "Only extraction exists",
          entities: [{ name: "Only extraction", type: "concept", aliases: [], tags: [], confidence: 0.5 }],
          relations: []
        };
      },
      async extractQuery(): Promise<QueryInterpretation> {
        throw new Error("LLM query interpretation failed: provider unavailable.");
      },
      async synthesizeAnswer(): Promise<string> {
        throw new Error("LLM answer synthesis failed: provider unavailable.");
      }
    }
  });

  try {
    await engine.init();
    await assert.rejects(() => engine.query({ text: "anything" }), /LLM query interpretation failed/);
  } finally {
    await engine.close();
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("engine lets the model choose graph hops and nodes up to a cap", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-hop-test-"));
  const provider = new NavigatingModelProvider();
  const engine = await MemoryEngine.create({ vaultPath, modelProvider: provider });

  try {
    await engine.init();
    await engine.ingest({ text: "Project Atlas uses Obsidian for memory." });

    const query = await engine.query({ text: "How does Atlas store memory?", limit: 5, maxHops: 2 });
    assert.equal(provider.decisions.length, 2);
    assert.equal(query.traversal?.length, 1);
    assert.equal(query.traversal?.[0]?.hop, 1);
    assert.ok(query.traversal?.[0]?.selectedNodeIds.length);
    assert.ok(query.matches.some((match) => match.kind === "relation" && match.title === "uses"));
  } finally {
    await engine.close();
    await rm(vaultPath, { recursive: true, force: true });
  }
});

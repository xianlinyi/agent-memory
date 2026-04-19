import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryEngine, type ModelProvider, type ExtractedMemory, type QueryHopDecision, type QueryInterpretation } from "../src/index.js";
import { answerPrompt, extractionPrompt, queryHopPrompt } from "../src/model/extraction.js";
import { stringifyMarkdownDocument } from "../src/utils/frontmatter.js";

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
      const selected = input.candidates.find((candidate) => candidate.title === "Project Atlas") ?? input.candidates[0];
      return { continue: Boolean(selected), nodeIds: selected ? [selected.id] : [], reason: "Need direct entity relationships." };
    }
    return { continue: false, nodeIds: [], reason: "Enough evidence has been gathered." };
  }
}

class EntityOnlyNavigatingModelProvider extends NavigatingModelProvider {
  async extractQuery(): Promise<QueryInterpretation> {
    return {
      keywords: ["Ada"],
      entities: ["Ada Lovelace"],
      predicates: [],
      expandedQuery: "Ada"
    };
  }
}

function stripMarkdownExtension(filePath: string): string {
  return filePath.endsWith(".md") ? filePath.slice(0, -3) : filePath;
}

test("SDK automatically isolates Copilot SDK config without Copilot environment variables", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-sdk-isolate-"));
  try {
    const engine = await MemoryEngine.create({ vaultPath });
    try {
      assert.equal(engine.config.model.provider, "copilot-sdk");
      assert.equal(engine.config.model.configDir, join(vaultPath, ".kg", "copilot-isolated"));
      const isolatedConfig = JSON.parse(await readFile(join(vaultPath, ".kg", "copilot-isolated", "config.json"), "utf8")) as {
        disableAllHooks: boolean;
        installedPlugins: unknown[];
        enabledPlugins: Record<string, unknown>;
      };
      assert.equal(isolatedConfig.disableAllHooks, true);
      assert.deepEqual(isolatedConfig.installedPlugins, []);
      assert.deepEqual(isolatedConfig.enabledPlugins, {});
    } finally {
      await engine.close();
    }
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("extraction prompt includes a concrete JSON template and scalar field rules", () => {
  const prompt = extractionPrompt("etr就是cashier.temporary_receipt表的数据");

  assert.match(prompt, /"summary": "One concise sentence summarizing the durable memory."/);
  assert.match(prompt, /"entities": \[/);
  assert.match(prompt, /"relations": \[/);
  assert.match(prompt, /summary must be a string/);
  assert.match(prompt, /Do not return nested objects or arrays inside string fields/);
  assert.match(prompt, /Preserve database, schema, table, API, file, and command names exactly/);
});

test("answer prompt asks for concise non-enumerated replies", () => {
  const prompt = answerPrompt(
    "我创建etr的时候选了下拉框的值但是点保存以后没有显示",
    {
      keywords: ["etr", "下拉框"],
      entities: ["etr"],
      predicates: ["未显示"],
      expandedQuery: "etr 下拉框 保存 未显示"
    },
    [{ kind: "entity", id: "entity:etr", title: "etr", text: "etr represents cashir.temporary_receipt.", score: 1 }]
  );

  assert.match(prompt, /at most two short sentences/);
  assert.match(prompt, /Do not list match IDs, entity IDs, keywords, or every matched item/);
  assert.match(prompt, /does not contain enough information to answer/);
});

test("query hop prompt makes graph expansion conservative", () => {
  const prompt = queryHopPrompt({
    query: "How does Atlas store memory?",
    interpretation: {
      keywords: ["Atlas", "memory"],
      entities: ["Project Atlas"],
      predicates: ["stores"],
      expandedQuery: "Atlas memory stores"
    },
    hop: 0,
    maxHops: 2,
    matches: [{ kind: "relation", id: "relation:1", title: "uses", text: "Project Atlas uses Obsidian for memory.", score: 1 }],
    candidates: [{ id: "entity:atlas", title: "Project Atlas", summary: "A memory project." }],
    visitedNodeIds: []
  });

  assert.match(prompt, /Default to continue=false/);
  assert.match(prompt, /specific missing entity\/relation\/detail/);
  assert.match(prompt, /Do not continue for broad context/);
  assert.match(prompt, /at most 3 nodes/);
});

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
    assert.match(ingest.entities.find((entity) => entity.name === "Project Atlas")?.id ?? "", /^entity:[a-f0-9]{16}$/);
    assert.equal(ingest.entities.find((entity) => entity.name === "Project Atlas")?.filePath, "Projects/project-atlas.md");
    assert.equal(ingest.entities.find((entity) => entity.name === "Obsidian")?.filePath, "Concepts/obsidian.md");
    assert.match(ingest.entities.find((entity) => entity.type === "person")?.filePath ?? "", /^People\//);
    assert.match(ingest.entities.find((entity) => entity.type === "project")?.filePath ?? "", /^Projects\//);
    assert.match(ingest.entities.find((entity) => entity.type === "bug")?.filePath ?? "", /^Bugs\//);
    assert.match(ingest.entities.find((entity) => entity.type === "rule")?.filePath ?? "", /^Rules\//);
    assert.match(ingest.entities.find((entity) => entity.type === "artifact")?.filePath ?? "", /^Concepts\//);
    assert.match(ingest.episode.filePath ?? "", /^Sessions\//);
    assert.match(ingest.relations[0]?.filePath ?? "", /^Graph\//);
    assert.doesNotMatch(ingest.relations[0]?.filePath ?? "", /entity-[a-f0-9]{16}/);

    const projectMarkdown = await readFile(join(vaultPath, ingest.entities[1]?.filePath ?? ""), "utf8");
    assert.match(projectMarkdown, /^name: Project Atlas$/m);
    assert.match(projectMarkdown, /^id: "`entity:[a-f0-9]{16}`"$/m);
    assert.doesNotMatch(projectMarkdown, /^## Details$/m);
    assert.ok(projectMarkdown.trim().endsWith("# Project Atlas"));

    const sessionMarkdown = await readFile(join(vaultPath, ingest.episode.filePath ?? ""), "utf8");
    assert.match(sessionMarkdown, /source_kind: message/);
    assert.match(sessionMarkdown, /source_label: Test chat/);
    assert.doesNotMatch(sessionMarkdown, /Sources\//);
    assert.doesNotMatch(sessionMarkdown, /\[\[entity:/);
    assert.match(sessionMarkdown, /## Mentioned Entities/);
    assert.ok(sessionMarkdown.includes(`[[${stripMarkdownExtension(ingest.entities[1]?.filePath ?? "")}|Project Atlas]]`));

    const relationMarkdown = await readFile(join(vaultPath, ingest.relations[0]?.filePath ?? ""), "utf8");
    assert.doesNotMatch(relationMarkdown, /\[\[entity:/);
    assert.match(relationMarkdown, /^## Relationship/m);
    assert.ok(relationMarkdown.includes(`[[${stripMarkdownExtension(ingest.entities[1]?.filePath ?? "")}|Project Atlas]]`));
    assert.ok(relationMarkdown.includes(`[[${stripMarkdownExtension(ingest.entities[4]?.filePath ?? "")}|Obsidian]]`));
    assert.match(relationMarkdown, /## Evidence/);
    assert.ok(relationMarkdown.includes(`[[${stripMarkdownExtension(ingest.episode.filePath ?? "")}|${ingest.episode.title}]]`));
    assert.doesNotMatch(relationMarkdown, /- episode:/);

    const queryStages: string[] = [];
    const query = await engine.query({
      text: "Atlas Obsidian",
      limit: 5,
      onProgress: (event) => {
        queryStages.push(event.stage);
      }
    });
    assert.equal(query.interpretation.expandedQuery, "Atlas Obsidian memory uses");
    assert.equal(query.answer, "Project Atlas uses Obsidian for memory.");
    assert.ok(query.matches.some((match) => match.kind === "entity" && match.title === "Project Atlas"));
    assert.ok(queryStages.includes("model.extractQuery"));
    assert.ok(queryStages.includes("graph.search"));
    assert.ok(queryStages.includes("model.synthesizeAnswer"));
    assert.ok(queryStages.includes("query.complete"));

    const manual = await engine.link({
      from: ingest.entities[0].id,
      to: ingest.entities[1].id,
      type: "documents_in"
    });
    assert.equal(manual.predicate, "documents_in");
    const manualMarkdown = await readFile(join(vaultPath, manual.filePath ?? ""), "utf8");
    assert.ok(manualMarkdown.includes(`[[${stripMarkdownExtension(ingest.entities[0]?.filePath ?? "")}|Ada Lovelace]]`));
    assert.ok(manualMarkdown.includes(`[[${stripMarkdownExtension(ingest.entities[1]?.filePath ?? "")}|Project Atlas]]`));

    await assert.rejects(
      () => engine.link({ from: ingest.entities[0].id, to: "entity:missing", type: "mentions" }),
      /unknown entity id/
    );

    const danglingPath = join(vaultPath, "Graph", "dangling.md");
    await writeFile(
      danglingPath,
      stringifyMarkdownDocument({
        frontmatter: {
          id: "relation:dangling",
          source_id: ingest.entities[0].id,
          target_id: "entity:missing",
          predicate: "mentions",
          weight: 1,
          confidence: 1,
          evidence_ids: [],
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString()
        },
        body: "# mentions\n\nSource: [[entity:ada]]\nTarget: [[entity:missing]]"
      }),
      "utf8"
    );

    await engine.rebuild();
    await assert.rejects(() => access(danglingPath));
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

test("engine normalizes non-string extraction fields before storing", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-normalize-"));
  const engine = await MemoryEngine.create({
    vaultPath,
    modelProvider: {
      async extractMemory() {
        return {
          summary: "ETR maps to cashier temporary receipt",
          entities: [
            {
              name: "etr",
              type: "concept",
              summary: { text: "etr is data from cashier.temporary_receipt" },
              aliases: [{ value: "temporary receipt" }],
              tags: ["cashier", { value: "receipt" }],
              confidence: 0.8
            },
            {
              name: "cashier.temporary_receipt",
              type: "artifact",
              summary: ["cashier table"],
              confidence: 0.8
            }
          ],
          relations: [
            {
              sourceId: "etr",
              targetId: "cashier.temporary_receipt",
              predicate: "maps_to",
              description: { text: "etr maps to cashier.temporary_receipt data" }
            }
          ]
        } as unknown as ExtractedMemory;
      },
      async extractQuery(): Promise<QueryInterpretation> {
        throw new Error("unused");
      },
      async synthesizeAnswer(): Promise<string> {
        throw new Error("unused");
      }
    }
  });

  try {
    await engine.init();
    const result = await engine.ingest({ text: "etr就是cashier.temporary_receipt表的数据" });

    assert.equal(result.entities.length, 2);
    assert.equal(result.relations.length, 1);
    assert.equal(result.entities[0]?.summary, "{\"text\":\"etr is data from cashier.temporary_receipt\"}");
    assert.equal(result.relations[0]?.description, "{\"text\":\"etr maps to cashier.temporary_receipt data\"}");
  } finally {
    await engine.close();
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("engine lets the model choose graph hops and nodes up to a cap", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-hop-test-"));
  const provider = new EntityOnlyNavigatingModelProvider();
  const engine = await MemoryEngine.create({ vaultPath, modelProvider: provider });

  try {
    await engine.init();
    const ingest = await engine.ingest({ text: "Project Atlas uses Obsidian for memory." });
    await engine.link({
      from: ingest.entities.find((entity) => entity.name === "Ada Lovelace")?.id ?? "",
      to: ingest.entities.find((entity) => entity.name === "Project Atlas")?.id ?? "",
      type: "documents_in"
    });

    const query = await engine.query({ text: "What does Ada document?", limit: 5, maxHops: 2 });
    assert.equal(provider.decisions.length, 2);
    assert.equal(query.traversal?.length, 1);
    assert.equal(query.traversal?.[0]?.hop, 1);
    assert.ok(query.traversal?.[0]?.selectedNodeIds.length);
    assert.ok(query.matches.some((match) => match.kind === "relation" && match.title === "documents_in"));
  } finally {
    await engine.close();
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("engine skips model graph hops when direct search already returns evidence", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-hop-skip-test-"));
  const provider = new NavigatingModelProvider();
  const engine = await MemoryEngine.create({ vaultPath, modelProvider: provider });

  try {
    await engine.init();
    await engine.ingest({ text: "Project Atlas uses Obsidian for memory." });

    const stages: string[] = [];
    const query = await engine.query({
      text: "How does Atlas store memory?",
      limit: 5,
      maxHops: 2,
      onProgress: (event) => {
        stages.push(event.stage);
      }
    });

    assert.equal(provider.decisions.length, 0);
    assert.equal(query.traversal, undefined);
    assert.ok(query.matches.some((match) => match.kind === "relation" && match.title === "uses"));
    assert.ok(stages.includes("graph.expand.model.skipped"));
    assert.ok(!stages.includes("model.decideQueryHop"));
  } finally {
    await engine.close();
    await rm(vaultPath, { recursive: true, force: true });
  }
});

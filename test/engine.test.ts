import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MemoryEngine,
  ObsidianVaultStore,
  type ModelProvider,
  type ExtractedMemory,
  type GraphSnapshot,
  type IngestKeyInformation,
  type IngestModelSession,
  type QueryHopDecision,
  type QueryInterpretation
} from "../src/index.js";
import { answerPrompt, extractionPrompt, parseRequiredExtraction, queryHopPrompt } from "../src/model/extraction.js";
import { stringifyMarkdownDocument } from "../src/utils/frontmatter.js";

class FakeModelProvider implements ModelProvider {
  async extractMemory(): Promise<ExtractedMemory> {
    return {
      experienceOutcome: "success",
      summary: "Project Atlas uses Obsidian memory",
      successExperience: "Use a local-first editable memory store for durable agent memory.",
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

  async synthesizeAnswer(_input?: Parameters<ModelProvider["synthesizeAnswer"]>[0]): Promise<string> {
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

class CapturingQueryModelProvider extends FakeModelProvider {
  answerMatches: Array<Parameters<ModelProvider["synthesizeAnswer"]>[0]["matches"]> = [];

  async extractMemory(): Promise<ExtractedMemory> {
    return {
      experienceOutcome: "success",
      summary: "Commit and PR workflow should be remembered.",
      successExperience: "Commit completed changes before creating a pull request for review.",
      entities: [
        { name: "commit and create pr", type: "rule", summary: "Commit changes and create a pull request.", aliases: [], tags: ["workflow"], confidence: 0.9 },
        { name: "GitHub pull request", type: "artifact", summary: "A pull request used for code review.", aliases: ["pr"], tags: ["github"], confidence: 0.8 }
      ],
      relations: [
        {
          sourceId: "commit and create pr",
          targetId: "GitHub pull request",
          predicate: "creates",
          description: "The workflow creates a GitHub pull request after committing changes.",
          confidence: 0.9,
          weight: 1
        }
      ]
    };
  }

  async extractQuery(): Promise<QueryInterpretation> {
    return {
      keywords: ["commit", "create", "pr"],
      entities: ["commit and create pr"],
      predicates: ["creates"],
      expandedQuery: "commit create pr"
    };
  }

  async synthesizeAnswer(input: Parameters<ModelProvider["synthesizeAnswer"]>[0]): Promise<string> {
    this.answerMatches.push(input.matches);
    return "Use the commit and PR workflow.";
  }
}

class SessionWorkflowModelProvider extends FakeModelProvider {
  readonly sessionSteps: string[][] = [];

  async startIngestSession(): Promise<IngestModelSession> {
    const steps: string[] = [];
    this.sessionSteps.push(steps);
    const keyInformation: IngestKeyInformation = {
      summary: "Commit changes before creating a pull request.",
      facts: ["Commit completed changes.", "Create a pull request after committing."]
    };
    const extraction: ExtractedMemory = {
      summary: keyInformation.summary,
      hasExplicitRelationOrBehaviorPath: true,
      entities: [{ name: "commit and create pr", type: "rule", aliases: [], tags: ["workflow"], confidence: 0.9 }],
      relations: []
    };

    return {
      extractKeyInformation: async () => {
        steps.push("key");
        return keyInformation;
      },
      extractEntitiesAndRelations: async () => {
        steps.push("entities");
        return extraction;
      },
      classifyOutcomeAndExtractSuccess: async () => {
        steps.push("outcome");
        return {
          ...extraction,
          experienceOutcome: "success",
          successExperience: "Commit completed changes before creating a pull request for review."
        };
      },
      reviewIngestMemory: async () => {
        steps.push("review");
        return { action: "store", replaceEntityIds: [], replaceRelationIds: [], reason: "new memory" };
      },
      close: async () => {
        steps.push("close");
      }
    };
  }
}

class CacheWorkflowModelProvider extends FakeModelProvider {
  readonly sessionSteps: string[][] = [];

  async startIngestSession(): Promise<IngestModelSession> {
    const steps: string[] = [];
    this.sessionSteps.push(steps);
    const keyInformation: IngestKeyInformation = {
      summary: "Prefer small focused commits before requesting review.",
      facts: ["Small focused commits help review."]
    };
    const extraction: ExtractedMemory = {
      summary: keyInformation.summary,
      hasExplicitRelationOrBehaviorPath: false,
      entities: [{ name: "focused commit practice", type: "rule", aliases: [], tags: ["workflow"], confidence: 0.8 }],
      relations: []
    };

    return {
      extractKeyInformation: async () => {
        steps.push("key");
        return keyInformation;
      },
      extractEntitiesAndRelations: async () => {
        steps.push("entities");
        return extraction;
      },
      classifyOutcomeAndExtractSuccess: async () => {
        steps.push("outcome");
        return {
          ...extraction,
          experienceOutcome: "success",
          successExperience: "Use small focused commits before requesting review."
        };
      },
      reviewIngestMemory: async () => {
        steps.push("review");
        return { action: "store", replaceEntityIds: [], replaceRelationIds: [], reason: "promoted cached memory" };
      },
      close: async () => {
        steps.push("close");
      }
    };
  }
}

class ConceptSpecificationModelProvider extends FakeModelProvider {
  readonly sessionSteps: string[][] = [];

  async startIngestSession(): Promise<IngestModelSession> {
    const steps: string[] = [];
    this.sessionSteps.push(steps);
    const keyInformation: IngestKeyInformation = {
      summary: "ETR is the cashier temporary receipt table.",
      facts: ["ETR maps to the cashier temporary receipt table."]
    };
    const extraction: ExtractedMemory = {
      summary: keyInformation.summary,
      hasExplicitRelationOrBehaviorPath: false,
      hasExplicitConceptSpecification: true,
      entities: [
        { name: "ETR", type: "concept", aliases: [], tags: ["term"], confidence: 0.9 },
        { name: "cashier temporary receipt table", type: "artifact", aliases: [], tags: ["table"], confidence: 0.9 }
      ],
      relations: [{ sourceId: "ETR", targetId: "cashier temporary receipt table", predicate: "maps_to", description: "ETR maps to the cashier temporary receipt table." }]
    };

    return {
      extractKeyInformation: async () => {
        steps.push("key");
        return keyInformation;
      },
      extractEntitiesAndRelations: async () => {
        steps.push("entities");
        return extraction;
      },
      classifyOutcomeAndExtractSuccess: async () => {
        steps.push("outcome");
        throw new Error("concept specifications should not be classified as success or failure");
      },
      reviewIngestMemory: async () => {
        steps.push("review");
        return { action: "store", replaceEntityIds: [], replaceRelationIds: [], reason: "explicit concept specification" };
      },
      close: async () => {
        steps.push("close");
      }
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

  assert.match(prompt, /"experienceOutcome": "success"/);
  assert.match(prompt, /"summary": "One concise sentence summarizing the key information."/);
  assert.match(prompt, /"successExperience": "General reusable lesson for successful behavior, without specific entity names."/);
  assert.match(prompt, /"name": "Meaningful entity name exactly as it appears in the input"/);
  assert.match(prompt, /"entities": \[/);
  assert.match(prompt, /"relations": \[/);
  assert.match(prompt, /Step 1: extract the key information from the input/);
  assert.match(prompt, /Step 2: strictly decide whether the key information contains meaningful, durable entities/);
  assert.match(prompt, /Step 3: only decide success or failure for experience behavior or behavior paths/);
  assert.match(prompt, /set hasExplicitConceptSpecification to true and preserve it for storage without judging success or failure/);
  assert.match(prompt, /successExperience as a public, reusable path or practice/);
  assert.match(prompt, /Treat best practices, durable preferences, constraints, repeatable procedures, and accepted approaches as rule entities/);
  assert.match(prompt, /Do not create entities for throwaway labels, internal codenames, arbitrary placeholders/);
  assert.match(prompt, /Do not introduce special names, codenames, or examples that are not present in the input/);
  assert.match(prompt, /experienceOutcome must be one of success, failure, unknown/);
  assert.match(prompt, /successExperience must be a string/);
  assert.match(prompt, /summary must be a string/);
  assert.match(prompt, /Do not return nested objects or arrays inside string fields/);
  assert.match(prompt, /Preserve database, schema, table, API, file, and command names exactly/);
  assert.match(prompt, /Each relation must connect two meaningful extracted entities and must be directly supported by the input/);

  const rulesBeforeInput = prompt.split("\nInput:\n")[0] ?? "";
  assert.doesNotMatch(rulesBeforeInput, /cashier\.temporary_receipt/);
});

test("failure experience extraction may contain no durable entities", () => {
  const extraction = parseRequiredExtraction(
    JSON.stringify({
      experienceOutcome: "failure",
      summary: "The attempted fix did not resolve the issue.",
      entities: [],
      relations: []
    })
  );

  assert.equal(extraction.experienceOutcome, "failure");
  assert.equal(extraction.entities.length, 0);
  assert.equal(extraction.relations.length, 0);
});

test("success experience extraction still requires durable entities", () => {
  assert.throws(
    () =>
      parseRequiredExtraction(
        JSON.stringify({
          experienceOutcome: "success",
          summary: "The fix resolved the login issue.",
          entities: [],
          relations: []
        })
      ),
    /contains no entities/
  );
});

test("ingest skips failed experiences before writing memory", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-failure-skip-"));
  const engine = await MemoryEngine.create({
    vaultPath,
    modelProvider: {
      async extractMemory(): Promise<ExtractedMemory> {
        return {
          experienceOutcome: "failure",
          summary: "The attempted workflow did not work.",
          successExperience: "",
          entities: [{ name: "Failed workflow", type: "bug", aliases: [], tags: ["failure"], confidence: 0.7 }],
          relations: []
        };
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
    const result = await engine.ingest({ text: "Tried the workflow and it failed.", source: { kind: "cli", label: "Failure" } });
    const snapshot = await engine.export();

    assert.equal(result.meta.status, "skipped");
    assert.equal(result.meta.skipped, true);
    assert.equal(snapshot.entities.length, 0);
    assert.equal(snapshot.relations.length, 0);
    assert.equal(snapshot.episodes.length, 0);
    assert.equal(snapshot.sources.length, 0);
  } finally {
    await engine.close();
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("ingest uses LLM review to skip highly similar successful memory", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-review-skip-"));
  let reviewCalls = 0;
  const engine = await MemoryEngine.create({
    vaultPath,
    modelProvider: {
      async extractMemory(): Promise<ExtractedMemory> {
        return {
          experienceOutcome: "success",
          summary: "Commit changes before creating a pull request.",
          successExperience: "Commit completed changes before opening a pull request.",
          entities: [{ name: "commit and create pr", type: "rule", aliases: [], tags: ["workflow"], confidence: 0.9 }],
          relations: []
        };
      },
      async reviewIngestMemory() {
        reviewCalls += 1;
        return reviewCalls === 1
          ? { action: "store", replaceEntityIds: [], replaceRelationIds: [], reason: "new memory" }
          : { action: "skip", replaceEntityIds: [], replaceRelationIds: [], reason: "highly similar memory" };
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
    const first = await engine.ingest({ text: "commit and create pr" });
    const second = await engine.ingest({ text: "commit then create a pr" });
    const snapshot = await engine.export();

    assert.equal(first.meta.status, "created");
    assert.equal(second.meta.status, "duplicate");
    assert.equal(second.meta.duplicate, true);
    assert.equal(snapshot.entities.length, 1);
    assert.equal(snapshot.episodes.length, 1);
  } finally {
    await engine.close();
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("ingest workflow asks each step in the same model session", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-session-workflow-"));
  const model = new SessionWorkflowModelProvider();
  const engine = await MemoryEngine.create({ vaultPath, modelProvider: model });

  try {
    await engine.init();
    const result = await engine.ingest({ text: "commit and create pr" });

    assert.equal(result.meta.status, "created");
    assert.deepEqual(model.sessionSteps, [["key", "entities", "outcome", "review", "close"]]);
  } finally {
    await engine.close();
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("ingest caches unconfirmed paths until similar observations reach rank five", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-cache-rank-"));
  const model = new CacheWorkflowModelProvider();
  const engine = await MemoryEngine.create({ vaultPath, modelProvider: model });

  try {
    await engine.init();
    for (let index = 0; index < 4; index += 1) {
      const result = await engine.ingest({ text: `observation ${index}: small focused commits help review` });
      assert.equal(result.meta.status, "skipped");
      assert.match(result.meta.reason ?? "", /cached pending confirmation rank=/);
    }

    const promoted = await engine.ingest({ text: "observation 5: small focused commits help review" });
    const snapshot = await engine.export();

    assert.equal(promoted.meta.status, "created");
    assert.equal(snapshot.entities.length, 1);
    assert.equal(snapshot.episodes.length, 1);
    assert.deepEqual(model.sessionSteps.map((steps) => steps.join(",")), [
      "key,entities,close",
      "key,entities,close",
      "key,entities,close",
      "key,entities,close",
      "key,entities,outcome,review,close"
    ]);
  } finally {
    await engine.close();
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("ingest skips outcome classification for explicit concept specifications", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-concept-spec-"));
  const model = new ConceptSpecificationModelProvider();
  const engine = await MemoryEngine.create({ vaultPath, modelProvider: model });

  try {
    await engine.init();
    const result = await engine.ingest({ text: "ETR is the cashier temporary receipt table." });
    const snapshot = await engine.export();

    assert.equal(result.meta.status, "created");
    assert.equal(snapshot.entities.length, 2);
    assert.equal(snapshot.relations.length, 1);
    assert.deepEqual(model.sessionSteps, [["key", "entities", "review", "close"]]);
  } finally {
    await engine.close();
    await rm(vaultPath, { recursive: true, force: true });
  }
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

test("query only sends top related entity and relation matches to the answer model", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-query-scope-"));
  const model = new CapturingQueryModelProvider();
  try {
    const engine = await MemoryEngine.create({ vaultPath, modelProvider: model });
    try {
      await engine.init();
      await engine.ingest({
        text: `commit and create pr ${"very long original session ".repeat(1000)}`,
        source: { kind: "cli", label: "Long session" }
      });

      const result = await engine.query({ text: "commit and create pr", limit: 10, maxHops: 0 });
      const answerMatches = model.answerMatches[0] ?? [];

      assert.equal(result.matches.length, answerMatches.length);
      assert.ok(answerMatches.length <= 5);
      assert.ok(answerMatches.length > 0);
      assert.ok(answerMatches.every((match) => match.kind === "entity" || match.kind === "relation"));
      assert.ok(answerMatches.every((match) => match.kind !== "episode" && match.kind !== "source"));
      assert.ok(answerMatches.every((match) => match.text.length <= 2012));
    } finally {
      await engine.close();
    }
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
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
          experienceOutcome: "success",
          summary: "Only extraction exists",
          successExperience: "Store meaningful extraction results when no query can be answered.",
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
          experienceOutcome: "success",
          summary: "ETR maps to cashier temporary receipt",
          successExperience: "Preserve exact technical object mappings when normalizing extracted fields.",
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

test("engine skips storing exact duplicate memory text", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-dedupe-"));
  let extractionCalls = 0;
  const engine = await MemoryEngine.create({
    vaultPath,
    modelProvider: {
      async extractMemory() {
        extractionCalls += 1;
        return {
          experienceOutcome: "success",
          summary: "Project Atlas uses Obsidian memory",
          successExperience: "Record durable tool choices that support local memory workflows.",
          entities: [
            { name: "Project Atlas", type: "project", aliases: ["Atlas"], tags: ["project"], confidence: 0.9 },
            { name: "Obsidian", type: "artifact", aliases: [], tags: ["tool"], confidence: 0.9 }
          ],
          relations: [{ sourceId: "Project Atlas", targetId: "Obsidian", predicate: "uses", description: "Project Atlas uses Obsidian for memory." }]
        };
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
    const first = await engine.ingest({ text: "Project Atlas uses Obsidian for memory." });
    const second = await engine.ingest({ text: "Project Atlas uses Obsidian for memory." });
    const snapshot = await engine.export();

    assert.equal(extractionCalls, 1);
    assert.equal(first.meta.status, "created");
    assert.equal(second.meta.status, "duplicate");
    assert.equal(second.meta.duplicate, true);
    assert.equal(second.episode.id, first.episode.id);
    assert.equal(snapshot.episodes.length, 1);
    assert.equal(snapshot.entities.length, 2);
    assert.equal(snapshot.relations.length, 1);
  } finally {
    await engine.close();
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("engine enhances similar entities and relations instead of creating near duplicates", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-merge-"));
  const extractions: ExtractedMemory[] = [
    {
      experienceOutcome: "success",
      summary: "Project Atlas uses Obsidian memory",
      successExperience: "Use an editable local memory store for durable agent memory.",
      entities: [
        { name: "Project Atlas", type: "project", summary: "Project Atlas stores memory.", aliases: ["Atlas"], tags: ["project"], confidence: 0.7 },
        { name: "Obsidian", type: "artifact", summary: "Obsidian is the memory vault.", aliases: [], tags: ["tool"], confidence: 0.8 }
      ],
      relations: [{ sourceId: "Project Atlas", targetId: "Obsidian", predicate: "uses", description: "Project Atlas uses Obsidian for memory.", confidence: 0.7 }]
    },
    {
      experienceOutcome: "success",
      summary: "Atlas uses Obsidian for local first memory",
      successExperience: "Prefer local-first memory storage that remains editable by humans.",
      entities: [
        { name: "Atlas", type: "project", summary: "Atlas stores local-first agent memory.", aliases: ["Project Atlas"], tags: ["local-first"], confidence: 0.95 },
        { name: "Obsidian", type: "artifact", summary: "Obsidian keeps the Markdown vault.", aliases: [], tags: ["markdown"], confidence: 0.9 }
      ],
      relations: [{ sourceId: "Atlas", targetId: "Obsidian", predicate: "uses", description: "Atlas uses Obsidian for local-first memory.", confidence: 0.95 }]
    }
  ];
  const engine = await MemoryEngine.create({
    vaultPath,
    modelProvider: {
      async extractMemory() {
        const next = extractions.shift();
        if (!next) throw new Error("unexpected extraction");
        return next;
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
    const first = await engine.ingest({ text: "Project Atlas uses Obsidian for memory." });
    const second = await engine.ingest({ text: "Atlas uses Obsidian for local-first memory." });
    const snapshot = await engine.export();
    const project = snapshot.entities.find((entity) => entity.name === "Project Atlas");
    const relation = snapshot.relations.find((item) => item.predicate === "uses");

    assert.equal(snapshot.entities.length, 2);
    assert.equal(snapshot.relations.length, 1);
    assert.equal(second.meta.status, "merged");
    assert.equal(second.meta.merged, true);
    assert.equal(second.meta.entitiesMerged, 2);
    assert.equal(second.meta.relationsMerged, 1);
    assert.equal(second.entities.find((entity) => entity.name === "Project Atlas")?.id, first.entities[0]?.id);
    assert.ok(project?.summary?.includes("Project Atlas stores memory."));
    assert.ok(project?.summary?.includes("Atlas stores local-first agent memory."));
    assert.deepEqual(project?.tags.sort(), ["local-first", "project"]);
    assert.ok(relation?.description?.includes("Project Atlas uses Obsidian for memory."));
    assert.ok(relation?.description?.includes("Atlas uses Obsidian for local-first memory."));
    assert.equal(relation?.evidenceIds.length, 2);
  } finally {
    await engine.close();
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("engine uses SQLite duplicate and merge lookups without reading the full vault snapshot", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-fast-ingest-"));
  class SnapshotFailingVaultStore extends ObsidianVaultStore {
    override async readSnapshot(): Promise<GraphSnapshot> {
      throw new Error("readSnapshot should not be called on the SQLite fast ingest path");
    }
  }

  const extractions: ExtractedMemory[] = [
    {
      experienceOutcome: "success",
      summary: "Project Atlas uses Obsidian memory",
      successExperience: "Use a local-first memory store for durable agent context.",
      entities: [
        { name: "Project Atlas", type: "project", aliases: ["Atlas"], tags: ["project"], confidence: 0.9 },
        { name: "Obsidian", type: "artifact", aliases: [], tags: ["tool"], confidence: 0.9 }
      ],
      relations: [{ sourceId: "Project Atlas", targetId: "Obsidian", predicate: "uses", description: "Project Atlas uses Obsidian for memory." }]
    },
    {
      experienceOutcome: "success",
      summary: "Atlas uses Obsidian for local first memory",
      successExperience: "Keep durable agent memory in a human-editable local store.",
      entities: [
        { name: "Atlas", type: "project", aliases: ["Project Atlas"], tags: ["local-first"], confidence: 0.95 },
        { name: "Obsidian", type: "artifact", aliases: [], tags: ["markdown"], confidence: 0.9 }
      ],
      relations: [{ sourceId: "Atlas", targetId: "Obsidian", predicate: "uses", description: "Atlas uses Obsidian for local-first memory." }]
    }
  ];

  const engine = await MemoryEngine.create({
    vaultPath,
    vaultStore: new SnapshotFailingVaultStore(vaultPath),
    modelProvider: {
      async extractMemory() {
        const next = extractions.shift();
        if (!next) throw new Error("unexpected extraction");
        return next;
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
    await engine.ingest({ text: "Project Atlas uses Obsidian for memory." });
    await engine.ingest({ text: "Atlas uses Obsidian for local-first memory." });
    await engine.ingest({ text: "Project Atlas uses Obsidian for memory." });
    const snapshot = await engine.export();

    assert.equal(snapshot.episodes.length, 2);
    assert.equal(snapshot.entities.length, 2);
    assert.equal(snapshot.relations.length, 1);
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

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryEngine, type ModelProvider, type RawDocument, type WikiPage, type WikiSchema, type WikiSearchResult, type WikiUpdatePlan } from "../src/index.js";

class FakeWikiModelProvider implements ModelProvider {
  plans: WikiUpdatePlan[] = [];
  answerInputs: WikiSearchResult[][] = [];

  async planWikiUpdates(input: { raw: RawDocument; existingPages: WikiPage[]; schema: WikiSchema }): Promise<WikiUpdatePlan> {
    const title = input.raw.text.includes("Obsidian") || input.existingPages.some((page) => page.title === "Project Atlas") ? "Project Atlas" : input.raw.label;
    const existing = input.existingPages.find((page) => page.title === title);
    const body = [
      "# Project Atlas",
      "",
      existing?.body.includes("local-first") ? "Project Atlas uses Obsidian for local-first agent memory and keeps wiki pages human editable." : "Project Atlas uses Obsidian for local-first agent memory.",
      "",
      "It relates to [[Obsidian]].",
      "",
      "## Sources",
      ...(existing?.sourceIds ?? []).map((id) => `- ${id}`),
      `- ${input.raw.id}`
    ].join("\n");
    const plan = {
      pages: [
        {
          title,
          type: "project",
          summary: "Project Atlas uses Obsidian for local-first agent memory.",
          tags: ["memory"],
          aliases: ["Atlas"],
          links: ["Obsidian"],
          sourceIds: [input.raw.id],
          body
        }
      ],
      notes: ["updated project page"]
    };
    this.plans.push(plan);
    return plan;
  }

  async synthesizeWikiAnswer(input: { query: string; results: WikiSearchResult[] }): Promise<string> {
    this.answerInputs.push(input.results);
    return input.results.length > 0 ? `Atlas memory is described in ${input.results[0]?.page.title}.` : "The wiki does not contain enough information to answer.";
  }

  async lintWiki(): Promise<[]> {
    return [];
  }
}

test("init creates LLM Wiki layout and starter schema", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "llm-wiki-init-"));
  try {
    const engine = await MemoryEngine.create({ vaultPath, modelProvider: new FakeWikiModelProvider() });
    await engine.init();
    assert.match(await readFile(join(vaultPath, "schema", "page-types.md"), "utf8"), /Page Types/);
    assert.match(await readFile(join(vaultPath, ".llm-wiki", "config.json"), "utf8"), /index\.db/);
    const status = await engine.status();
    assert.equal(status.counts.rawDocuments, 0);
    assert.equal(status.counts.wikiPages, 0);
    await engine.close();
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("ingest writes immutable raw source and creates or updates wiki pages", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "llm-wiki-ingest-"));
  const model = new FakeWikiModelProvider();
  try {
    const engine = await MemoryEngine.create({ vaultPath, modelProvider: model });
    const first = await engine.ingest({ text: "Project Atlas uses Obsidian for local-first agent memory.", source: { label: "Planning chat" } });
    const second = await engine.ingest({ text: "Project Atlas keeps wiki pages human editable.", source: { label: "Follow-up chat" } });

    assert.match(first.raw.path, /^raw\//);
    assert.equal(first.pages[0]?.title, "Project Atlas");
    assert.equal(second.pages[0]?.path, first.pages[0]?.path);

    const pageMarkdown = await readFile(join(vaultPath, "wiki", "project-atlas.md"), "utf8");
    assert.match(pageMarkdown, /## Sources/);
    assert.match(pageMarkdown, new RegExp(first.raw.id));
    assert.match(pageMarkdown, new RegExp(second.raw.id));
    assert.match(pageMarkdown, /\[\[Obsidian\]\]/);

    const pages = await engine.pages();
    const sources = await engine.sources();
    assert.equal(pages.length, 1);
    assert.equal(sources.length, 2);
    await engine.close();
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("query searches wiki pages and returns page/source citations", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "llm-wiki-query-"));
  const model = new FakeWikiModelProvider();
  try {
    const engine = await MemoryEngine.create({ vaultPath, modelProvider: model });
    await engine.ingest({ text: "Project Atlas uses Obsidian for local-first agent memory." });
    const result = await engine.query({ text: "How does Atlas store memory?" });

    assert.match(result.answer, /Project Atlas/);
    assert.equal(result.pages[0]?.title, "Project Atlas");
    assert.equal(result.sources.length, 1);
    assert.equal(model.answerInputs[0]?.[0]?.page.title, "Project Atlas");
    await engine.close();
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("reindex rebuilds search index from raw and wiki files", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "llm-wiki-reindex-"));
  const model = new FakeWikiModelProvider();
  try {
    const engine = await MemoryEngine.create({ vaultPath, modelProvider: model });
    await engine.ingest({ text: "Project Atlas uses Obsidian for local-first agent memory." });
    await engine.reindex();
    const status = await engine.status();
    assert.equal(status.counts.rawDocuments, 1);
    assert.equal(status.counts.wikiPages, 1);
    assert.equal(status.counts.sourceRefs, 1);
    await engine.close();
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("lint reports broken links, missing sources, and unreferenced raw documents", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "llm-wiki-lint-"));
  try {
    const engine = await MemoryEngine.create({ vaultPath, modelProvider: new FakeWikiModelProvider() });
    await engine.init();
    await writeFile(
      join(vaultPath, "wiki", "orphan.md"),
      ["---", "id: page:orphan", "title: Orphan", "type: concept", "summary: Orphan page.", "tags: []", "aliases: []", "links: [Missing Page]", "source_ids: []", "created_at: 2026-04-28T00:00:00.000Z", "updated_at: 2026-04-28T00:00:00.000Z", "---", "# Orphan", "", "Links to [[Missing Page]]."].join("\n"),
      "utf8"
    );
    const raw = await engine.ingest({ text: "Project Atlas uses Obsidian." });
    await writeFile(join(vaultPath, raw.pages[0]?.path ?? "wiki/project-atlas.md"), "# Project Atlas\n\nNo frontmatter now.\n", "utf8");

    const issues = await engine.lint();
    assert.ok(issues.some((issue) => issue.code === "missing_source"));
    assert.ok(issues.some((issue) => issue.code === "missing_sources_section"));
    assert.ok(issues.some((issue) => issue.code === "broken_wikilink"));
    await engine.close();
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

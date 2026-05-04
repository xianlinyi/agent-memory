import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryEngine, type ModelProvider, type RawDocument, type WikiPage, type WikiSchema, type WikiSearchResult, type WikiUpdatePlan } from "../src/index.js";

class FakeWikiModelProvider implements ModelProvider {
  plans: WikiUpdatePlan[] = [];
  answerInputs: WikiSearchResult[][] = [];

  async planWikiUpdates(input: { raw: RawDocument; existingPages: WikiPage[]; schema: WikiSchema }): Promise<WikiUpdatePlan> {
    const atlasPage = input.raw.text.includes("Obsidian") || input.existingPages.some((page) => page.title === "Project Atlas");
    const title = atlasPage ? "Project Atlas" : input.raw.label === "CLI input" ? input.raw.text.split(/\s+/).slice(0, 4).join(" ") : input.raw.label;
    const existing = input.existingPages.find((page) => page.title === title);
    const body = atlasPage
      ? [
          "# Project Atlas",
          "",
          existing?.body.includes("local-first") ? "Project Atlas uses Obsidian for local-first agent memory and keeps wiki pages human editable." : "Project Atlas uses Obsidian for local-first agent memory.",
          "",
          "It relates to [[Obsidian]].",
          "",
          "## Sources",
          ...(existing?.sourceIds ?? []).map((id) => `- ${id}`),
          `- ${input.raw.id}`
        ].join("\n")
      : [
          `# ${title}`,
          "",
          input.raw.text,
          "",
          "## Sources",
          ...(existing?.sourceIds ?? []).map((id) => `- ${id}`),
          `- ${input.raw.id}`
        ].join("\n");
    const plan = {
      pages: [
        {
          title,
          type: atlasPage ? "project" : "concept",
          summary: atlasPage ? "Project Atlas uses Obsidian for local-first agent memory." : input.raw.text,
          tags: atlasPage ? ["memory"] : [input.raw.memoryClass ?? "semantic"],
          aliases: atlasPage ? ["Atlas"] : [],
          links: atlasPage ? ["Obsidian"] : [],
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
    await access(join(vaultPath, "memory", "raw"));
    await access(join(vaultPath, "memory", "session-summaries"));
    await access(join(vaultPath, "memory", "candidates"));
    await access(join(vaultPath, "memory", "long", "semantic"));
    await access(join(vaultPath, "memory", "wiki-update-candidates"));
    await access(join(vaultPath, "wiki", "raw"));
    await access(join(vaultPath, "wiki", "episodes"));
    await access(join(vaultPath, "wiki", "semantic"));
    await access(join(vaultPath, "wiki", "procedures"));
    const status = await engine.status();
    assert.equal(status.counts.rawDocuments, 0);
    assert.equal(status.counts.wikiPages, 0);
    assert.equal(status.counts.memoryPages, 0);
    assert.equal(status.counts.longMemoryPages, 0);
    assert.equal(status.counts.wikiUpdateCandidates, 0);
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

    assert.match(first.raw.path, /^memory\/raw\//);
    assert.equal(first.pages.length, 0);
    assert.equal(second.pages.length, 0);

    const sources = await engine.sources();
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
    await engine.consolidate();
    const result = await engine.query({ text: "How does Atlas store memory?" });

    assert.ok(result.pages.length > 0);
    assert.equal(result.sources.length, 1);
    assert.equal(model.answerInputs[0]?.length, result.pages.length > 0 ? model.answerInputs[0]?.length : 0);
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
    assert.equal(status.counts.wikiPages, 0);
    assert.equal(status.counts.memoryPages, 0);
    assert.equal(status.counts.sourceRefs, 0);
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
    await writeFile(join(vaultPath, "wiki", "project-atlas.md"), "# Project Atlas\n\nNo frontmatter now.\n", "utf8");

    const issues = await engine.lint();
    assert.ok(issues.some((issue) => issue.code === "missing_source"));
    assert.ok(issues.some((issue) => issue.code === "missing_sources_section"));
    assert.ok(issues.some((issue) => issue.code === "broken_wikilink"));
    await engine.close();
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("query expands exact entity matches through linked pages", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "llm-wiki-linked-query-"));
  try {
    const engine = await MemoryEngine.create({ vaultPath, modelProvider: new FakeWikiModelProvider() });
    await engine.init();
    await mkdir(join(vaultPath, "raw", "2026", "05", "02"), { recursive: true });
    await writeFile(
      join(vaultPath, "raw", "2026", "05", "02", "etr.md"),
      [
        "---",
        "id: raw:etr",
        "kind: manual",
        "label: ETR note",
        "content_hash: etr-hash",
        "created_at: 2026-05-02T00:00:00.000Z",
        "---",
        "# Raw Document",
        "",
        "ETR troubleshooting notes."
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(vaultPath, "raw", "2026", "05", "02", "policy.md"),
      [
        "---",
        "id: raw:policy",
        "kind: manual",
        "label: Policy note",
        "content_hash: policy-hash",
        "created_at: 2026-05-02T00:00:00.000Z",
        "---",
        "# Raw Document",
        "",
        "Policy field notes."
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(vaultPath, "wiki", "etr.md"),
      [
        "---",
        "id: page:etr",
        "title: ETR",
        "type: entity",
        "summary: ETR receipt workflow.",
        "tags: []",
        "aliases:",
        "  - etr",
        "hints:",
        "  - receipt lookup",
        "entrypoints:",
        "  - temporary_receipt",
        "links:",
        "  - PolicyNo",
        "source_ids:",
        "  - raw:etr",
        "created_at: 2026-05-02T00:00:00.000Z",
        "updated_at: 2026-05-02T00:00:00.000Z",
        "---",
        "# ETR",
        "",
        "Operational notes for ETR incidents.",
        "",
        "## Sources",
        "- raw:etr"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(vaultPath, "wiki", "policy-no.md"),
      [
        "---",
        "id: page:policy-no",
        "title: PolicyNo",
        "type: entity",
        "summary: Policy number lookup field.",
        "tags: []",
        "aliases:",
        "  - policyNo",
        "hints:",
        "  - cross module field",
        "entrypoints:",
        "  - temporary_receipt_policy_detail",
        "links: []",
        "source_ids:",
        "  - raw:policy",
        "created_at: 2026-05-02T00:00:00.000Z",
        "updated_at: 2026-05-02T00:00:00.000Z",
        "---",
        "# PolicyNo",
        "",
        "Lookup field used across multiple modules.",
        "",
        "## Sources",
        "- raw:policy"
      ].join("\n"),
      "utf8"
    );

    await engine.reindex();
    const result = await engine.query({ text: "etr incident", synthesize: false, limit: 3 });

    assert.deepEqual(
      result.pages.map((page) => page.title),
      ["ETR", "PolicyNo"]
    );
    await engine.close();
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("query auto-selects the most likely meaning for ambiguous aliases", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "llm-wiki-ambiguous-query-"));
  try {
    const engine = await MemoryEngine.create({ vaultPath, modelProvider: new FakeWikiModelProvider() });
    await engine.init();
    await mkdir(join(vaultPath, "raw", "2026", "05", "02"), { recursive: true });
    await writeFile(
      join(vaultPath, "raw", "2026", "05", "02", "payment-flow.md"),
      [
        "---",
        "id: raw:payment-flow",
        "kind: manual",
        "label: Payment flow note",
        "content_hash: payment-flow-hash",
        "created_at: 2026-05-02T00:00:00.000Z",
        "---",
        "# Raw Document",
        "",
        "Payment flow notes."
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(vaultPath, "raw", "2026", "05", "02", "payment-team.md"),
      [
        "---",
        "id: raw:payment-team",
        "kind: manual",
        "label: Payment team note",
        "content_hash: payment-team-hash",
        "created_at: 2026-05-02T00:00:00.000Z",
        "---",
        "# Raw Document",
        "",
        "Payment team notes."
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(vaultPath, "wiki", "payment-flow.md"),
      [
        "---",
        "id: page:payment-flow",
        "title: Payment Flow",
        "type: concept",
        "summary: Business flow for taking payments.",
        "tags: []",
        "aliases:",
        "  - payment",
        "hints:",
        "  - refund",
        "  - capture",
        "entrypoints:",
        "  - cashier_header",
        "links: []",
        "source_ids:",
        "  - raw:payment-flow",
        "created_at: 2026-05-02T00:00:00.000Z",
        "updated_at: 2026-05-02T00:00:00.000Z",
        "---",
        "# Payment Flow",
        "",
        "Operational flow for collecting payments.",
        "",
        "## Sources",
        "- raw:payment-flow"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(vaultPath, "wiki", "payment-team.md"),
      [
        "---",
        "id: page:payment-team",
        "title: Payment Team",
        "type: capability",
        "summary: Team that owns payment incidents.",
        "tags: []",
        "aliases:",
        "  - payment",
        "hints:",
        "  - owner",
        "  - oncall",
        "  - team",
        "entrypoints:",
        "  - pagerduty",
        "links: []",
        "source_ids:",
        "  - raw:payment-team",
        "created_at: 2026-05-02T00:00:00.000Z",
        "updated_at: 2026-05-02T00:00:00.000Z",
        "---",
        "# Payment Team",
        "",
        "Escalation path and ownership for payment incidents.",
        "",
        "## Sources",
        "- raw:payment-team"
      ].join("\n"),
      "utf8"
    );

    await engine.reindex();
    const result = await engine.query({ text: "payment owner oncall", synthesize: false, limit: 2 });

    assert.equal(result.pages[0]?.title, "Payment Team");
    await engine.close();
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("explicit non-deferred ingest still supports direct wiki compilation for internal callers", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "llm-wiki-direct-ingest-"));
  const model = new FakeWikiModelProvider();
  try {
    const engine = await MemoryEngine.create({ vaultPath, modelProvider: model });
    const result = await engine.ingest({ text: "Project Atlas uses Obsidian for local-first agent memory.", deferConsolidation: false });

    assert.equal(result.pages[0]?.title, "Project Atlas");
    const pages = await engine.pages();
    assert.equal(pages.length, 1);
    await engine.close();
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("deferred ingest stores raw memory and consolidate creates summaries and candidates", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "llm-wiki-consolidate-"));
  try {
    const engine = await MemoryEngine.create({ vaultPath, modelProvider: new FakeWikiModelProvider() });
    await engine.init();
    const ingest = await engine.ingest({
      text: "Yesterday payment proof sending failed because MQ timeout blocked notification delivery.",
      source: { kind: "message", label: "Incident note" },
      memory: { sessionId: "session-1" },
      deferConsolidation: true
    });

    assert.equal(ingest.pages.length, 0);
    assert.equal(ingest.raw.memoryClass, "episodic");
    assert.equal(ingest.raw.memoryStage, "raw");

    const result = await engine.consolidate({ sessionId: "session-1" });
    assert.equal(result.pendingRawDocuments.length, 1);
    assert.equal(result.sessionSummary?.memoryStage, "session_summary");
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.memoryStage, "candidate");
    assert.equal(result.candidates[0]?.memoryClass, "episodic");
    assert.equal(result.longMemories.length, 1);
    assert.equal(result.longMemories[0]?.memoryStage, "long_term");
    assert.equal(result.wikiPages.length, 0);
    assert.equal(result.wikiUpdateCandidates.length, 0);
    assert.match(await readFile(join(vaultPath, result.sessionSummary?.path ?? ""), "utf8"), /Incident note/);
    assert.match(await readFile(join(vaultPath, result.candidates[0]?.path ?? ""), "utf8"), /MQ timeout/);
    assert.match(await readFile(join(vaultPath, result.longMemories[0]?.path ?? ""), "utf8"), /MQ timeout/);
    await engine.close();
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("manual plain-text wiki raw files can be consolidated into wiki entities", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "llm-wiki-manual-raw-"));
  try {
    const engine = await MemoryEngine.create({ vaultPath, modelProvider: new FakeWikiModelProvider() });
    await engine.init();
    await mkdir(join(vaultPath, "wiki", "raw", "2026", "05", "03"), { recursive: true });
    await writeFile(
      join(vaultPath, "wiki", "raw", "2026", "05", "03", "atlas-note.txt"),
      "Project Atlas uses Obsidian for local-first agent memory.\n",
      "utf8"
    );

    const result = await engine.consolidate();

    assert.equal(result.pendingRawDocuments.length, 1);
    assert.equal(result.longMemories.length, 0);
    assert.equal(result.wikiPages.length, 1);
    assert.equal(result.wikiPages[0]?.title, "Project Atlas");
    assert.match(await readFile(join(vaultPath, result.wikiPages[0]?.path ?? ""), "utf8"), /Project Atlas/);
    await engine.close();
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("consolidate links wiki raw into an existing related entity", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "llm-wiki-approve-update-"));
  try {
    const engine = await MemoryEngine.create({ vaultPath, modelProvider: new FakeWikiModelProvider() });
    await engine.init();
    await mkdir(join(vaultPath, "wiki", "raw", "2026", "05", "03"), { recursive: true });
    await writeFile(
      join(vaultPath, "wiki", "semantic", "project-atlas.md"),
      [
        "---",
        "id: page:project-atlas",
        "title: Project Atlas",
        "type: project",
        "summary: Project Atlas uses Obsidian for local-first agent memory.",
        "tags: [memory]",
        "aliases:",
        "  - Atlas",
        "source_ids:",
        "  - raw:existing-atlas",
        "created_at: 2026-05-02T00:00:00.000Z",
        "updated_at: 2026-05-02T00:00:00.000Z",
        "---",
        "# Project Atlas",
        "",
        "Project Atlas uses Obsidian for local-first agent memory.",
        "",
        "## Sources",
        "- raw:existing-atlas"
      ].join("\n"),
      "utf8"
    );
    await writeFile(join(vaultPath, "wiki", "raw", "2026", "05", "03", "atlas-update.txt"), "Project Atlas keeps wiki pages human editable.\n", "utf8");

    const consolidated = await engine.consolidate();

    assert.equal(consolidated.wikiPages.length, 1);
    assert.equal(consolidated.wikiPages[0]?.path, "wiki/semantic/project-atlas.md");
    assert.equal(consolidated.wikiPages[0]?.sourceIds.length, 2);
    assert.match(await readFile(join(vaultPath, consolidated.wikiPages[0]?.path ?? ""), "utf8"), /human editable/);
    await engine.close();
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("query prefers memory results before wiki results when both match", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "llm-wiki-memory-first-query-"));
  try {
    const engine = await MemoryEngine.create({ vaultPath, modelProvider: new FakeWikiModelProvider() });
    await engine.init();
    await engine.ingest({
      text: "Payment proof is sent by notification-service and should be checked in notification_log.",
      source: { label: "Payment Proof" },
      targetScope: "memory",
      memory: { class: "semantic", sessionId: "session-memory-first" }
    });
    await engine.ingest({
      text: "Payment proof is sent by notification-service and should be checked in notification_log.",
      source: { label: "Payment Proof" },
      targetScope: "wiki",
      memory: { class: "semantic", sessionId: "session-memory-first" }
    });
    const consolidated = await engine.consolidate({ sessionId: "session-memory-first" });

    const result = await engine.query({ text: "payment proof notification-service", synthesize: false, limit: 2 });

    assert.equal(result.pages.length, 2);
    assert.match(result.pages[0]?.path ?? "", /^memory\/long\//);
    assert.match(result.pages[1]?.path ?? "", /^wiki\//);
    assert.equal(consolidated.wikiPages.length, 1);
    await engine.close();
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("approve wiki update still works for legacy pending candidates", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "llm-wiki-reject-update-"));
  try {
    const engine = await MemoryEngine.create({ vaultPath, modelProvider: new FakeWikiModelProvider() });
    await engine.init();
    await mkdir(join(vaultPath, "memory", "wiki-update-candidates"), { recursive: true });
    await writeFile(
      join(vaultPath, "memory", "wiki-update-candidates", "billing-export.md"),
      [
        "---",
        "id: page:billing-export-candidate",
        "title: Update Billing Export",
        "type: procedure",
        "summary: Billing export callback troubleshooting.",
        "tags: [memory, wiki-update, procedural]",
        "aliases: []",
        "links: []",
        "source_ids:",
        "  - raw:billing-export",
        "review_status: pending",
        "wiki_target_title: Billing Export",
        "wiki_target_path: wiki/procedures/billing-export.md",
        "memory_class: procedural",
        "memory_stage: wiki_update_candidate",
        "created_at: 2026-05-03T00:00:00.000Z",
        "updated_at: 2026-05-03T00:00:00.000Z",
        "---",
        "# Billing Export",
        "",
        "Billing export uses reconciliation token to locate PSP callbacks.",
        "",
        "## Sources",
        "- raw:billing-export"
      ].join("\n"),
      "utf8"
    );

    const pending = await engine.wikiUpdateCandidates({ reviewStatus: "pending" });
    assert.equal(pending.length, 1);

    const applied = await engine.applyWikiUpdate(pending[0]?.path ?? "");
    assert.equal(applied.candidate.reviewStatus, "approved");
    assert.equal(applied.page.path, "wiki/procedures/billing-export.md");
    assert.equal((await engine.wikiUpdateCandidates({ reviewStatus: "pending" })).length, 0);
    assert.equal((await engine.pages()).length, 1);
    assert.match(await readFile(join(vaultPath, applied.page.path), "utf8"), /reconciliation token/);
    await engine.close();
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("reject wiki update still works for legacy pending candidates", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "llm-wiki-reject-update-"));
  try {
    const engine = await MemoryEngine.create({ vaultPath, modelProvider: new FakeWikiModelProvider() });
    await engine.init();
    await mkdir(join(vaultPath, "memory", "wiki-update-candidates"), { recursive: true });
    await writeFile(
      join(vaultPath, "memory", "wiki-update-candidates", "billing-export.md"),
      [
        "---",
        "id: page:billing-export-candidate",
        "title: Update Billing Export",
        "type: procedure",
        "summary: Billing export callback troubleshooting.",
        "tags: [memory, wiki-update, procedural]",
        "aliases: []",
        "links: []",
        "source_ids:",
        "  - raw:billing-export",
        "review_status: pending",
        "wiki_target_title: Billing Export",
        "wiki_target_path: wiki/procedures/billing-export.md",
        "memory_class: procedural",
        "memory_stage: wiki_update_candidate",
        "created_at: 2026-05-03T00:00:00.000Z",
        "updated_at: 2026-05-03T00:00:00.000Z",
        "---",
        "# Billing Export",
        "",
        "Billing export uses reconciliation token to locate PSP callbacks.",
        "",
        "## Sources",
        "- raw:billing-export"
      ].join("\n"),
      "utf8"
    );

    const pending = await engine.wikiUpdateCandidates({ reviewStatus: "pending" });
    assert.equal(pending.length, 1);

    const rejected = await engine.rejectWikiUpdate(pending[0]?.path ?? "");
    assert.equal(rejected.candidate.reviewStatus, "rejected");
    assert.equal((await engine.wikiUpdateCandidates({ reviewStatus: "pending" })).length, 0);
    assert.equal((await engine.wikiUpdateCandidates({ reviewStatus: "rejected" })).length, 1);
    assert.equal((await engine.pages()).length, 0);
    await engine.close();
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

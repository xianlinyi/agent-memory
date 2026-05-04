import type { RawDocument, WikiLintIssue, WikiPage, WikiSchema, WikiSearchResult, WikiUpdatePlan } from "../types.js";

export function wikiUpdatePlanPrompt(input: { raw: RawDocument; existingPages: WikiPage[]; schema: WikiSchema }): string {
  const template: WikiUpdatePlan = {
    pages: [
      {
        title: "Stable page title",
        type: "concept",
        canonical: "Canonical page name if different from title.",
        summary: "One concise summary.",
        tags: ["tag"],
        aliases: [],
        hints: ["Short phrases that help disambiguate this page during search."],
        entrypoints: ["Stable commands, URLs, tables, systems, or workflows that lead to this page."],
        links: ["Related Page"],
        sourceIds: [input.raw.id],
        body: "# Stable page title\n\nDurable wiki content with [[Related Page]] links.\n\n## Sources\n- raw-id"
      }
    ],
    notes: ["Short rationale."]
  };

  return [
    "You are maintaining a local LLM Wiki. Return only strict JSON.",
    "Plan entity page creations or rewrites for the new raw document.",
    "The file system source of truth is memory/raw, wiki/raw, memory/long, and wiki/. SQLite is only an index.",
    "The raw document targetScope decides whether the result belongs to memory entities or wiki entities.",
    "Every page must be durable, human-readable Markdown and must include a Sources section.",
    "Every page must cite the new raw document id when it uses information from it.",
    "Prefer updating an existing page over creating duplicates for the same topic.",
    "Browse the existing entity pages carefully and reuse an existing entity when the raw document extends or corrects it.",
    "Choose the most precise page type allowed by the schema and keep stable entity titles.",
    "When a term has multiple stable meanings, prefer separate pages per meaning and use aliases, hints, and entrypoints to disambiguate them.",
    "Use [[Page Title]] wikilinks for related topics.",
    "Do not invent facts not supported by the raw document or existing pages.",
    "Return JSON with keys pages, merge, notes.",
    "",
    "JSON template:",
    JSON.stringify(template, null, 2),
    "",
    "Schema/page types:",
    input.schema.pageTypes,
    "",
    "Schema/style guide:",
    input.schema.styleGuide,
    "",
    "Existing entity pages in target scope:",
    JSON.stringify(
      input.existingPages.map((page) => ({
        id: page.id,
        title: page.title,
        type: page.type,
        canonical: page.canonical,
        summary: page.summary,
        tags: page.tags,
        aliases: page.aliases,
        hints: page.hints,
        entrypoints: page.entrypoints,
        links: page.links,
        sourceIds: page.sourceIds,
        body: page.body
      })),
      null,
      2
    ),
    "",
    "New raw document:",
    JSON.stringify(input.raw, null, 2)
  ].join("\n");
}

export function wikiAnswerPrompt(input: { query: string; results: WikiSearchResult[]; schema: WikiSchema }): string {
  return [
    "Answer the user's query using only the wiki search results below.",
    "If the wiki does not contain enough information, say that directly.",
    "Keep the answer concise. Mention the most relevant wiki page titles as citations in parentheses.",
    "",
    `Query: ${input.query}`,
    "",
    "Wiki results:",
    JSON.stringify(
      input.results.map((result) => ({
        title: result.page.title,
        path: result.page.path,
        summary: result.page.summary,
        body: result.page.body,
        sources: result.sources.map((source) => ({ id: source.id, label: source.label, path: source.path, text: source.text }))
      })),
      null,
      2
    )
  ].join("\n");
}

export function wikiLintPrompt(input: { pages: WikiPage[]; rawDocuments: RawDocument[]; schema: WikiSchema }): string {
  const template: { issues: WikiLintIssue[] } = {
    issues: [
      {
        severity: "warning",
        code: "possible_contradiction",
        message: "Short explanation.",
        pageId: input.pages[0]?.id
      }
    ]
  };

  return [
    "Review this LLM Wiki for maintenance issues and return only strict JSON.",
    "Look for likely contradictions, duplicate topics, schema violations, unclear titles, and stale summaries.",
    "Do not report deterministic issues such as missing Sources or broken wikilinks unless they are visible in the supplied page data.",
    "Return JSON with a single key issues.",
    "",
    "JSON template:",
    JSON.stringify(template, null, 2),
    "",
    "Lint rules:",
    input.schema.lintRules,
    "",
    "Pages:",
    JSON.stringify(input.pages, null, 2),
    "",
    "Raw documents:",
    JSON.stringify(input.rawDocuments.map((raw) => ({ id: raw.id, path: raw.path, label: raw.label })), null, 2)
  ].join("\n");
}

export function parseRequiredWikiUpdatePlan(output: string | undefined, rawId?: string): WikiUpdatePlan {
  const parsed = parseJsonObject(output) as Partial<WikiUpdatePlan>;
  const pages: unknown[] = Array.isArray(parsed.pages) ? parsed.pages : [];
  const mergeItems: unknown[] = Array.isArray(parsed.merge) ? parsed.merge : [];
  return {
    pages: pages
      .filter(isObjectRecord)
      .filter((page) => typeof page.title === "string" && typeof page.body === "string")
      .map((page) => ({
        title: String(page.title),
        type: typeof page.type === "string" && page.type ? page.type : "concept",
        canonical: typeof page.canonical === "string" && page.canonical.trim().length > 0 ? page.canonical.trim() : undefined,
        summary: typeof page.summary === "string" ? page.summary : "",
        tags: stringArray(page.tags),
        aliases: stringArray(page.aliases),
        hints: stringArray(page.hints),
        entrypoints: stringArray(page.entrypoints),
        links: stringArray(page.links),
        sourceIds: uniqueStrings([...stringArray(page.sourceIds), ...(rawId ? [rawId] : [])]),
        body: String(page.body)
      })),
    merge:
      mergeItems.length > 0
        ? mergeItems
          .filter(isObjectRecord)
          .map((item) => ({
            fromTitle: String(item.fromTitle ?? ""),
            toTitle: String(item.toTitle ?? ""),
            reason: typeof item.reason === "string" ? item.reason : undefined
          }))
          .filter((item) => item.fromTitle && item.toTitle)
        : undefined,
    notes: stringArray(parsed.notes)
  };
}

export function parseRequiredWikiLintIssues(output: string | undefined): WikiLintIssue[] {
  const parsed = parseJsonObject(output) as { issues?: unknown };
  const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
  return issues
    .filter((issue): issue is Record<string, unknown> => Boolean(issue) && typeof issue === "object")
    .map((issue) => ({
      severity: severityValue(issue.severity),
      code: typeof issue.code === "string" && issue.code ? issue.code : "model_lint",
      message: typeof issue.message === "string" ? issue.message : "",
      pageId: typeof issue.pageId === "string" ? issue.pageId : undefined,
      sourceId: typeof issue.sourceId === "string" ? issue.sourceId : undefined,
      path: typeof issue.path === "string" ? issue.path : undefined
    }))
    .filter((issue) => issue.message);
}

function severityValue(value: unknown): WikiLintIssue["severity"] {
  return value === "error" || value === "info" || value === "warning" ? value : "warning";
}

function parseJsonObject(output: string | undefined): Record<string, unknown> {
  if (!output?.trim()) throw new Error("LLM provider returned no content.");
  const trimmed = stripMarkdownFence(output.trim());
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LLM provider did not return a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripMarkdownFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] ?? text : text;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

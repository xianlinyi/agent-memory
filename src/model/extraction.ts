import type { ExtractedMemory, MemoryMatch, QueryHopCandidate, QueryHopDecision, QueryInterpretation } from "../types.js";

export function extractionPrompt(text: string): string {
  return [
    "Extract agent memory as strict JSON with keys summary, entities, relations.",
    "Each entity must include name and may include type, aliases, tags, summary, confidence.",
    "Entity type must be one of concept, person, project, bug, rule, artifact, decision, topic, unknown.",
    "Relations should use sourceId and targetId as entity names when stable IDs are unknown.",
    "Do not wrap the JSON in markdown.",
    "",
    text
  ].join("\n");
}

export function queryPrompt(text: string): string {
  return [
    "Interpret this memory search query as strict JSON with keys keywords, entities, predicates, expandedQuery.",
    "keywords, entities, and predicates must be arrays of short strings.",
    "expandedQuery must be a concise FTS-friendly string containing the most important terms.",
    "Do not answer the query. Do not wrap the JSON in markdown.",
    "",
    text
  ].join("\n");
}

export function answerPrompt(query: string, interpretation: QueryInterpretation, matches: MemoryMatch[]): string {
  return [
    "Answer the user's memory query in natural language using only the structured memory matches below.",
    "If the matches are empty or insufficient, say that the memory store does not contain enough information.",
    "Keep the answer concise and cite relevant match IDs inline when useful.",
    "",
    `Query: ${query}`,
    "",
    "Query interpretation:",
    JSON.stringify(interpretation, null, 2),
    "",
    "Memory matches:",
    JSON.stringify(matches, null, 2)
  ].join("\n");
}

export function queryHopPrompt(input: {
  query: string;
  interpretation: QueryInterpretation;
  hop: number;
  maxHops: number;
  matches: MemoryMatch[];
  candidates: QueryHopCandidate[];
  visitedNodeIds: string[];
}): string {
  return [
    "Decide whether this memory graph query needs another hop.",
    "Return strict JSON with keys continue, nodeIds, reason.",
    "continue must be a boolean.",
    "nodeIds must contain only IDs from Candidate nodes and should include at most 5 nodes.",
    "Choose another hop only when the current matches are insufficient and the candidate nodes are likely to add relevant evidence.",
    "Do not exceed the max hop budget. Do not wrap the JSON in markdown.",
    "",
    `Query: ${input.query}`,
    `Current hop: ${input.hop}`,
    `Max hops: ${input.maxHops}`,
    "",
    "Query interpretation:",
    JSON.stringify(input.interpretation, null, 2),
    "",
    "Visited node IDs:",
    JSON.stringify(input.visitedNodeIds, null, 2),
    "",
    "Current memory matches:",
    JSON.stringify(input.matches, null, 2),
    "",
    "Candidate nodes:",
    JSON.stringify(input.candidates, null, 2)
  ].join("\n");
}

export function compactPrompt(text: string): string {
  return `Compact these memory notes into concise durable knowledge:\n\n${text}`;
}

export function parseJsonObject<T>(value: string): T | undefined {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;

  try {
    return JSON.parse(value.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}

export function parseRequiredExtraction(value: string | undefined): ExtractedMemory {
  if (!value?.trim()) {
    throw new Error("LLM memory extraction failed: provider returned no content.");
  }

  const parsed = parseJsonObject<ExtractedMemory>(value);
  if (!parsed) {
    throw new Error("LLM memory extraction failed: provider did not return valid JSON.");
  }

  const normalized = normalizeExtraction(parsed);
  if (!normalized.summary.trim()) {
    throw new Error("LLM memory extraction failed: JSON response is missing a summary.");
  }
  if (normalized.entities.length === 0) {
    throw new Error("LLM memory extraction failed: JSON response contains no entities.");
  }

  return normalized;
}

export function parseRequiredQueryInterpretation(value: string | undefined): QueryInterpretation {
  if (!value?.trim()) {
    throw new Error("LLM query interpretation failed: provider returned no content.");
  }

  const parsed = parseJsonObject<Partial<QueryInterpretation>>(value);
  if (!parsed) {
    throw new Error("LLM query interpretation failed: provider did not return valid JSON.");
  }

  const interpretation: QueryInterpretation = {
    keywords: stringArray(parsed.keywords),
    entities: stringArray(parsed.entities),
    predicates: stringArray(parsed.predicates),
    expandedQuery: typeof parsed.expandedQuery === "string" ? parsed.expandedQuery.trim() : ""
  };

  if (!interpretation.expandedQuery) {
    interpretation.expandedQuery = [...interpretation.entities, ...interpretation.predicates, ...interpretation.keywords].join(" ");
  }
  if (!interpretation.expandedQuery.trim()) {
    throw new Error("LLM query interpretation failed: JSON response contains no searchable terms.");
  }

  return interpretation;
}

export function parseRequiredQueryHopDecision(value: string | undefined): QueryHopDecision {
  if (!value?.trim()) {
    throw new Error("LLM query hop decision failed: provider returned no content.");
  }

  const parsed = parseJsonObject<Partial<QueryHopDecision>>(value);
  if (!parsed) {
    throw new Error("LLM query hop decision failed: provider did not return valid JSON.");
  }

  return {
    continue: Boolean(parsed.continue),
    nodeIds: stringArray(parsed.nodeIds),
    reason: typeof parsed.reason === "string" ? parsed.reason.trim() : undefined
  };
}

export function normalizeExtraction(extraction: ExtractedMemory): ExtractedMemory {
  return {
    summary: extraction.summary || "",
    entities: (extraction.entities ?? []).filter((entity) => entity.name),
    relations: extraction.relations ?? []
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

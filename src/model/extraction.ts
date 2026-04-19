import type { EntityType, ExtractedMemory, MemoryMatch, QueryHopCandidate, QueryHopDecision, QueryInterpretation } from "../types.js";

export function extractionPrompt(text: string): string {
  const template = {
    experienceOutcome: "success",
    summary: "One concise sentence summarizing the durable memory.",
    entities: [
      {
        name: "Meaningful entity name exactly as it appears in the input",
        type: "concept",
        aliases: ["useful alternative name"],
        tags: ["stable category"],
        summary: "One concise sentence about this entity.",
        confidence: 0.8,
        externalRefs: {
          key: "string value"
        }
      }
    ],
    relations: [
      {
        sourceId: "Exact source entity name from entities[].name",
        targetId: "Exact target entity name from entities[].name",
        predicate: "short_snake_case_predicate",
        description: "One concise sentence explaining the relation.",
        weight: 1,
        confidence: 0.8,
        evidenceIds: []
      }
    ]
  };

  return [
    "Extract durable agent memory from the input and return only strict JSON.",
    "Use exactly this top-level shape: experienceOutcome, summary, entities, relations.",
    "First decide whether the input describes a success experience, a failure experience, or an unknown outcome.",
    "Extract only meaningful, durable entities and relationships that are explicitly stated or strongly implied by the input.",
    "For success experiences, extract reusable entities and relations that explain what worked, what depends on what, or what should be remembered next time.",
    "For failure experiences, first analyze whether there are named, durable, reusable entities worth remembering.",
    "For failure experiences, return entities only for concrete reusable entities such as projects, bugs, files, tables, APIs, tools, commands, decisions, rules, or named concepts.",
    "For failure experiences, use [] for entities and relations when the failure only describes a transient attempt, vague error, or non-reusable detail.",
    "Treat best practices, durable preferences, constraints, repeatable procedures, and accepted approaches as rule entities when they can guide future behavior.",
    "Do not create entities for throwaway labels, internal codenames, arbitrary placeholders, vague pronouns, or incidental words unless they identify a meaningful reusable thing.",
    "Do not introduce special names, codenames, or examples that are not present in the input.",
    "",
    "JSON template:",
    JSON.stringify(template, null, 2),
    "",
    "Field rules:",
    "experienceOutcome must be one of success, failure, unknown.",
    "summary must be a string.",
    "entities must be an array. Each entity must include name. Use [] when there are no aliases or tags.",
    "Entity name, summary, aliases, tags, externalRefs values, relation IDs, predicates, and descriptions must be strings.",
    "Do not return nested objects or arrays inside string fields.",
    "Entity type must be one of concept, person, project, bug, rule, artifact, decision, topic, unknown.",
    "Use artifact for concrete files, tables, APIs, commands, tools, documents, and other named technical objects.",
    "Preserve database, schema, table, API, file, and command names exactly, including dots and underscores.",
    "relations must be an array. Use sourceId and targetId values that exactly match entity names from entities.",
    "Each relation must connect two meaningful extracted entities and must be directly supported by the input.",
    "Use [] for relations when the input only defines one entity or no durable meaningful relationship.",
    "Do not answer or explain the input. Do not wrap the JSON in markdown.",
    "",
    "Input:",
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
    "Keep the answer to at most two short sentences.",
    "Do not list match IDs, entity IDs, keywords, or every matched item unless the user explicitly asks for details.",
    "If the matches are empty or insufficient, say only that the memory store does not contain enough information to answer.",
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
    "Default to continue=false.",
    "Only continue when the current matches do not contain enough evidence to answer the query, the query has a specific missing entity/relation/detail, and the candidate nodes are very likely to provide that missing evidence.",
    "Do not continue for broad context, curiosity, weak associations, or when the current matches already include direct evidence for the requested entity or relation.",
    "nodeIds must contain only IDs from Candidate nodes and should include at most 3 nodes.",
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
  if (normalized.experienceOutcome !== "failure" && normalized.entities.length === 0) {
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
  const entities = Array.isArray(extraction.entities) ? extraction.entities : [];
  const relations = Array.isArray(extraction.relations) ? extraction.relations : [];

  return {
    experienceOutcome: experienceOutcomeValue(extraction.experienceOutcome),
    summary: textValue(extraction.summary),
    entities: entities
      .map((entity) => ({
        name: textValue(entity.name),
        type: entityTypeValue(entity.type),
        summary: optionalTextValue(entity.summary),
        aliases: stringArray(entity.aliases),
        tags: stringArray(entity.tags),
        confidence: numberValue(entity.confidence),
        externalRefs: stringRecord(entity.externalRefs)
      }))
      .filter((entity) => entity.name),
    relations: relations
      .map((relation) => ({
        sourceId: textValue(relation.sourceId),
        targetId: textValue(relation.targetId),
        predicate: textValue(relation.predicate),
        description: optionalTextValue(relation.description),
        weight: numberValue(relation.weight),
        confidence: numberValue(relation.confidence),
        evidenceIds: stringArray(relation.evidenceIds)
      }))
      .filter((relation) => relation.sourceId && relation.targetId && relation.predicate)
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") return JSON.stringify(value);
  return "";
}

function optionalTextValue(value: unknown): string | undefined {
  const text = textValue(value);
  return text || undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, textValue(item)]));
}

function entityTypeValue(value: unknown): EntityType | undefined {
  const type = textValue(value);
  return isEntityType(type) ? type : undefined;
}

function experienceOutcomeValue(value: unknown): ExtractedMemory["experienceOutcome"] {
  const outcome = textValue(value);
  return outcome === "success" || outcome === "failure" || outcome === "unknown" ? outcome : undefined;
}

function isEntityType(value: string): value is EntityType {
  return ["concept", "person", "project", "bug", "rule", "artifact", "decision", "topic", "unknown"].includes(value);
}

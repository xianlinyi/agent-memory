import type { EntityType, ExtractedMemory, IngestKeyInformation, IngestReviewDecision, MemoryMatch, QueryHopCandidate, QueryHopDecision, QueryInterpretation } from "../types.js";

export function extractionPrompt(text: string): string {
  const template = {
    experienceOutcome: "success",
    summary: "One concise sentence summarizing the key information.",
    successExperience: "General reusable lesson for successful behavior, without specific entity names.",
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
    "Run the ingest extraction workflow and return only strict JSON.",
    "Use exactly this top-level shape: experienceOutcome, summary, successExperience, hasExplicitConceptSpecification, entities, relations.",
    "Step 1: extract the key information from the input. The summary must describe only the key information.",
    "Step 2: strictly decide whether the key information contains meaningful, durable entities. If it does not, return [] for entities and relations.",
    "Step 2: when meaningful entities exist, extract only those entities and then extract only their directly supported relationships.",
    "Step 3: only decide success or failure for experience behavior or behavior paths.",
    "Step 3: if the key information is a clear concept definition, concept mapping, classification, name, or artifact specification, set hasExplicitConceptSpecification to true and preserve it for storage without judging success or failure.",
    "Step 3: for failed or unknown behavior, set successExperience to an empty string and do not invent success lessons.",
    "Step 3: for successful behavior, extract successExperience as a public, reusable path or practice. It must not contain specific entity names, aliases, private codenames, project names, table names, API names, file names, user names, or one-off identifiers.",
    "Step 3: successExperience must be generalized enough to guide future work across similar situations.",
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
    "successExperience must be a string. Use an empty string unless experienceOutcome is success.",
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

export function ingestKeyInformationPrompt(text: string): string {
  const template: IngestKeyInformation = {
    summary: "One concise sentence containing only key information.",
    facts: ["Atomic key fact from the input."]
  };

  return [
    "In this ingest session, step 1 is to extract only key information from the input.",
    "Return only strict JSON with keys summary and facts.",
    "summary must be one concise sentence.",
    "facts must be short atomic facts. Omit transient chatter, failed attempts without reusable meaning, and incidental wording.",
    "Do not classify success or failure yet. Do not extract entities or relations yet.",
    "Do not wrap the JSON in markdown.",
    "",
    "JSON template:",
    JSON.stringify(template, null, 2),
    "",
    "Input:",
    text
  ].join("\n");
}

export function ingestEntitiesPrompt(keyInformation: IngestKeyInformation): string {
  const template: ExtractedMemory = {
    summary: "One concise sentence summarizing the key information.",
    hasExplicitRelationOrBehaviorPath: true,
    hasExplicitConceptSpecification: false,
    entities: [
      {
        name: "Meaningful entity name exactly as stated in the key information",
        type: "concept",
        aliases: [],
        tags: [],
        summary: "One concise sentence about this entity.",
        confidence: 0.8
      }
    ],
    relations: [
      {
        sourceId: "Exact source entity name from entities[].name",
        targetId: "Exact target entity name from entities[].name",
        predicate: "short_snake_case_predicate",
        description: "One concise sentence explaining the explicitly confirmed relation.",
        weight: 1,
        confidence: 0.8,
        evidenceIds: []
      }
    ]
  };

  return [
    "Continue the same ingest session. Step 2 is entity and relation extraction from the key information only.",
    "Return only strict JSON with keys summary, hasExplicitRelationOrBehaviorPath, hasExplicitConceptSpecification, entities, relations.",
    "Strictly decide whether the key information contains meaningful, durable entities with practical value.",
    "If there are no meaningful entities, return [] for entities and relations.",
    "Ignore temporary entities that are unlikely to be reused long term, such as a specific numbered PR, issue, build, run, log entry, branch snapshot, commit hash, or one-off generated identifier.",
    "Do not create entities for generic workflow words such as PR, pull request, commit, branch, or build unless the input names a durable concept, rule, tool, or reusable practice around them.",
    "When a temporary item contains useful behavior, extract the reusable rule or practice instead of the temporary item itself.",
    "Set hasExplicitConceptSpecification to true when the user explicitly defines, names, maps, classifies, or specifies a meaningful concept or artifact, even if there is no behavior path to judge as success or failure.",
    "Only extract relationships that the user explicitly confirmed, or behavior paths that the user explicitly described.",
    "Set hasExplicitRelationOrBehaviorPath to true only when there is at least one explicitly confirmed relation or explicitly described behavior path.",
    "Do not infer weak relations from co-occurrence. Do not classify success or failure yet.",
    "Do not wrap the JSON in markdown.",
    "",
    "JSON template:",
    JSON.stringify(template, null, 2),
    "",
    "Key information:",
    JSON.stringify(keyInformation, null, 2)
  ].join("\n");
}

export function ingestOutcomePrompt(input: { keyInformation: IngestKeyInformation; extraction: ExtractedMemory }): string {
  const template: ExtractedMemory = {
    experienceOutcome: "success",
    summary: "One concise sentence summarizing the key information.",
    successExperience: "Public reusable successful behavior path without specific entity names.",
    hasExplicitRelationOrBehaviorPath: true,
    hasExplicitConceptSpecification: false,
    entities: [],
    relations: []
  };

  return [
    "Continue the same ingest session. Step 3 is outcome classification and success-experience extraction for experience behavior only.",
    "Return only strict JSON with keys experienceOutcome, summary, successExperience, hasExplicitRelationOrBehaviorPath, hasExplicitConceptSpecification, entities, relations.",
    "Only judge success or failure when the key information describes an experience behavior or behavior path.",
    "Do not judge success or failure for pure concept definitions, concept mappings, classifications, names, or artifact specifications.",
    "Decide whether the experience behavior is essentially successful behavior, failed behavior, or unknown.",
    "experienceOutcome must be one of success, failure, unknown.",
    "If the outcome is failure or unknown, successExperience must be an empty string.",
    "If the outcome is success, successExperience must be a public, reusable behavior path or practice.",
    "successExperience must not contain specific entity names, aliases, private codenames, project names, table names, API names, file names, user names, or one-off identifiers.",
    "Preserve hasExplicitConceptSpecification, entities, and relations from step 2 unless they clearly violate the rules.",
    "Do not wrap the JSON in markdown.",
    "",
    "JSON template:",
    JSON.stringify(template, null, 2),
    "",
    "Key information:",
    JSON.stringify(input.keyInformation, null, 2),
    "",
    "Step 2 extraction:",
    JSON.stringify(input.extraction, null, 2)
  ].join("\n");
}

export function ingestReviewPrompt(input: { extraction: ExtractedMemory; candidates: MemoryMatch[] }): string {
  const template: IngestReviewDecision = {
    action: "store",
    reason: "Short reason.",
    replaceEntityIds: [],
    replaceRelationIds: [],
    successExperience: "Optional improved public reusable lesson."
  };

  return [
    "Review a proposed memory ingest against existing memory candidates and return only strict JSON.",
    "Use exactly this top-level shape: action, reason, replaceEntityIds, replaceRelationIds, successExperience.",
    "action must be one of store, skip, replace.",
    "Use skip when the proposed memory is a duplicate or highly similar to existing memory and adds no meaningful improvement.",
    "Use replace when the proposed memory improves, corrects, or generalizes existing memory. Include only existing candidate IDs that should be replaced.",
    "Use store when it is meaningfully new.",
    "successExperience must remain public and reusable. It must not contain specific entity names, aliases, private codenames, project names, table names, API names, file names, user names, or one-off identifiers.",
    "Do not invent IDs. replaceEntityIds may contain only candidate IDs whose kind is entity. replaceRelationIds may contain only candidate IDs whose kind is relation.",
    "Do not wrap the JSON in markdown.",
    "",
    "JSON template:",
    JSON.stringify(template, null, 2),
    "",
    "Proposed extraction:",
    JSON.stringify(input.extraction, null, 2),
    "",
    "Existing candidates:",
    JSON.stringify(input.candidates, null, 2)
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
  if (normalized.experienceOutcome === "success" && normalized.entities.length === 0) {
    throw new Error("LLM memory extraction failed: JSON response contains no entities.");
  }

  return normalized;
}

export function parseRequiredIngestKeyInformation(value: string | undefined): IngestKeyInformation {
  if (!value?.trim()) {
    throw new Error("LLM ingest key information extraction failed: provider returned no content.");
  }

  const parsed = parseJsonObject<Partial<IngestKeyInformation>>(value);
  if (!parsed) {
    throw new Error("LLM ingest key information extraction failed: provider did not return valid JSON.");
  }

  const keyInformation = {
    summary: textValue(parsed.summary),
    facts: stringArray(parsed.facts)
  };
  if (!keyInformation.summary.trim() && keyInformation.facts.length === 0) {
    throw new Error("LLM ingest key information extraction failed: JSON response contains no key information.");
  }
  return keyInformation;
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

export function parseRequiredIngestReviewDecision(value: string | undefined, candidates: MemoryMatch[]): IngestReviewDecision {
  if (!value?.trim()) {
    throw new Error("LLM ingest review failed: provider returned no content.");
  }

  const parsed = parseJsonObject<Partial<IngestReviewDecision>>(value);
  if (!parsed) {
    throw new Error("LLM ingest review failed: provider did not return valid JSON.");
  }

  const candidateEntityIds = new Set(candidates.filter((candidate) => candidate.kind === "entity").map((candidate) => candidate.id));
  const candidateRelationIds = new Set(candidates.filter((candidate) => candidate.kind === "relation").map((candidate) => candidate.id));
  const action = parsed.action === "skip" || parsed.action === "replace" ? parsed.action : "store";
  return {
    action,
    reason: optionalTextValue(parsed.reason),
    replaceEntityIds: stringArray(parsed.replaceEntityIds).filter((id) => candidateEntityIds.has(id)),
    replaceRelationIds: stringArray(parsed.replaceRelationIds).filter((id) => candidateRelationIds.has(id)),
    successExperience: optionalTextValue(parsed.successExperience)
  };
}

export function normalizeExtraction(extraction: ExtractedMemory): ExtractedMemory {
  const entities = Array.isArray(extraction.entities) ? extraction.entities : [];
  const relations = Array.isArray(extraction.relations) ? extraction.relations : [];

  return {
    experienceOutcome: experienceOutcomeValue(extraction.experienceOutcome),
    summary: textValue(extraction.summary),
    successExperience: optionalTextValue(extraction.successExperience),
    hasExplicitRelationOrBehaviorPath: Boolean(extraction.hasExplicitRelationOrBehaviorPath),
    hasExplicitConceptSpecification: Boolean(extraction.hasExplicitConceptSpecification),
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

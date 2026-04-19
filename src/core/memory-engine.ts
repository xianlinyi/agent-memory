import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { applyAutomaticCopilotIsolation, defaultConfig, INTERNAL_DIR, loadConfig, writeConfig } from "../config.js";
import { normalizeExtraction } from "../model/extraction.js";
import { createModelProvider } from "../model/model-factory.js";
import type { ModelProvider } from "../model/model-provider.js";
import type { GraphStore } from "../store/graph-store.js";
import { NodeSqliteFtsGraphStore } from "../store/node-sqlite-fts-store.js";
import { NoopEmbeddingProvider, type EmbeddingProvider } from "../store/embedding.js";
import { NoopVectorStore, type VectorStore } from "../store/vector-store.js";
import type {
  AgentMemoryConfig,
  Entity,
  Episode,
  ExtractedMemory,
  GraphSnapshot,
  IngestInput,
  IngestKeyInformation,
  IngestProgressEvent,
  IngestResult,
  IngestReviewDecision,
  MemoryMatch,
  MemoryStatus,
  QueryHopCandidate,
  QueryInterpretation,
  QueryInput,
  QueryProgressEvent,
  QueryResult,
  QueryTraversalStep,
  Relation,
  SourceRef
} from "../types.js";
import { stableId } from "../utils/ids.js";
import { importNodeSqlite } from "../utils/node-sqlite.js";
import { nowIso } from "../utils/time.js";
import { ObsidianVaultStore, type VaultStore } from "../vault/vault-store.js";

const FIXED_QUERY_HOPS = 3;
const MAX_DIRECT_MATCHES_PER_TERM = 2;
const MAX_RELATIONS_PER_NODE = 5;
const DEFAULT_QUERY_LIMIT = 5;
const MAX_QUERY_MATCHES = 5;
const MAX_MATCH_TEXT_CHARS = 2000;
const INGEST_CACHE_DIR = "ingest-cache";
const INGEST_CACHE_PROMOTION_RANK = 5;
const INGEST_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INGEST_CACHE_SIMILARITY_THRESHOLD = 0.75;

export interface MemoryEngineOptions {
  vaultPath: string;
  config?: AgentMemoryConfig;
  modelProvider?: ModelProvider;
  graphStore?: GraphStore;
  vaultStore?: VaultStore;
  embeddingProvider?: EmbeddingProvider;
  vectorStore?: VectorStore;
}

export class MemoryEngine {
  private constructor(
    readonly config: AgentMemoryConfig,
    private readonly modelProvider: ModelProvider,
    private readonly graphStore: GraphStore,
    private readonly vaultStore: VaultStore,
    readonly embeddingProvider: EmbeddingProvider,
    readonly vectorStore: VectorStore
  ) {}

  static async create(options: MemoryEngineOptions): Promise<MemoryEngine> {
    const loadedConfig = options.config ?? (await loadConfig(options.vaultPath));
    const config = options.modelProvider ? loadedConfig : await applyAutomaticCopilotIsolation(loadedConfig);
    const modelProvider = options.modelProvider ?? createModelProvider(config);
    const graphStore =
      options.graphStore ??
      new NodeSqliteFtsGraphStore({
        databasePath: config.databasePath,
        vaultPath: config.vaultPath
      });
    const vaultStore = options.vaultStore ?? new ObsidianVaultStore(config.vaultPath);

    return new MemoryEngine(
      config,
      modelProvider,
      graphStore,
      vaultStore,
      options.embeddingProvider ?? new NoopEmbeddingProvider(),
      options.vectorStore ?? new NoopVectorStore()
    );
  }

  async init(): Promise<void> {
    await this.vaultStore.init();
    await writeConfig(this.config);
    await this.graphStore.init();
  }

  async close(): Promise<void> {
    await this.modelProvider.close?.();
    await this.graphStore.close();
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    const trace = createIngestTracer(input.onProgress);
    await this.ensureReady();
    await trace("ensureReady");
    const timestamp = nowIso();
    let existingSnapshot: GraphSnapshot | undefined;
    const getExistingSnapshot = async () => {
      existingSnapshot ??= await this.vaultStore.readSnapshot();
      return existingSnapshot;
    };
    const sourceDraft = input.source
      ? {
          id: stableId("source", [input.source.kind ?? "cli", input.source.label, input.source.uri, input.text]),
          kind: input.source.kind ?? "cli",
          label: input.source.label ?? input.source.uri ?? "CLI input",
          uri: input.source.uri,
          text: input.text,
          createdAt: timestamp,
          updatedAt: timestamp
        }
      : undefined;
    const duplicateEpisode = this.graphStore.findEpisodeByText
      ? await this.graphStore.findEpisodeByText(input.text)
      : findExactEpisode((await getExistingSnapshot()).episodes, input.text);
    if (duplicateEpisode) {
      const duplicateSnapshot = existingSnapshot ?? (await this.graphStore.graph());
      return {
        source: duplicateEpisode.sourceId
          ? (await this.graphStore.findSourceById?.(duplicateEpisode.sourceId)) ?? duplicateSnapshot.sources.find((source) => source.id === duplicateEpisode.sourceId)
          : undefined,
        episode: duplicateEpisode,
        entities:
          (await this.graphStore.findEntitiesByIds?.(duplicateEpisode.entityIds)) ??
          duplicateSnapshot.entities.filter((entity) => duplicateEpisode.entityIds.includes(entity.id)),
        relations:
          (await this.graphStore.findRelationsByEvidenceId?.(duplicateEpisode.id)) ??
          duplicateSnapshot.relations.filter((relation) => relation.evidenceIds.includes(duplicateEpisode.id)),
        meta: ingestMeta("duplicate", 0, 0)
      };
    }

    const session = await this.modelProvider.startIngestSession?.();
    let keyInformation: IngestKeyInformation | undefined;
    let extracted: ExtractedMemory;
    let review: IngestReviewDecision | undefined;
    try {
      if (session) {
        await trace("ingest.step1.input", { input: { text: input.text } });
        keyInformation = await session.extractKeyInformation({ text: input.text });
        await trace("ingest.step1.output", { output: keyInformation });
        await trace("ingest.step2.input", { input: { keyInformation } });
        extracted = normalizeExtraction(await session.extractEntitiesAndRelations({ keyInformation }));
        await trace("ingest.step2.output", { output: extracted });
        if (extracted.entities.length === 0) {
          await session.close?.();
          return {
            episode: skippedEpisode(input.text, extracted.summary || keyInformation.summary, timestamp),
            entities: [],
            relations: [],
            meta: ingestMeta("skipped", 0, 0, "no meaningful durable entities")
          };
        }
        if (!extracted.hasExplicitRelationOrBehaviorPath && !extracted.hasExplicitConceptSpecification) {
          await trace("ingest.cache.input", { input: { keyInformation, extraction: extracted } });
          const cacheResult = await this.recordIngestCache(keyInformation, extracted, timestamp);
          await trace("ingest.cache.output", { output: cacheResult });
          if (!cacheResult.promoted) {
            await session.close?.();
            return {
              episode: skippedEpisode(input.text, extracted.summary || keyInformation.summary, timestamp),
              entities: [],
              relations: [],
              meta: ingestMeta("skipped", 0, 0, `cached pending confirmation rank=${cacheResult.rank}`)
            };
          }
        }
        if (!extracted.hasExplicitConceptSpecification) {
          await trace("ingest.step3.input", { input: { keyInformation, extraction: extracted } });
          extracted = normalizeExtraction(await session.classifyOutcomeAndExtractSuccess({ keyInformation, extraction: extracted }));
          await trace("ingest.step3.output", { output: extracted });
        } else {
          await trace("ingest.step3.skipped", { details: { reason: "explicit concept specification" } });
        }
      } else {
        await trace("ingest.legacyExtract.input", { input: { text: input.text } });
        extracted = normalizeExtraction(await this.modelProvider.extractMemory({ text: input.text }));
        await trace("ingest.legacyExtract.output", { output: extracted });
      }
    } catch (error) {
      await session?.close?.();
      throw error;
    }
    if (!extracted.hasExplicitConceptSpecification && extracted.experienceOutcome !== "success") {
      await session?.close?.();
      return {
        episode: skippedEpisode(input.text, extracted.summary, timestamp),
        entities: [],
        relations: [],
        meta: ingestMeta("skipped", 0, 0, `experience outcome is ${extracted.experienceOutcome ?? "unknown"}`)
      };
    }
    if (extracted.entities.length === 0) {
      await session?.close?.();
      return {
        episode: skippedEpisode(input.text, extracted.summary, timestamp),
        entities: [],
        relations: [],
        meta: ingestMeta("skipped", 0, 0, "no meaningful durable entities")
      };
    }

    const reviewCandidates = await this.findIngestReviewCandidates(extracted, 5);
    if (session) {
      try {
        await trace("ingest.step4.input", { input: { extraction: extracted, candidates: reviewCandidates } });
        review = await session.reviewIngestMemory({ extraction: extracted, candidates: reviewCandidates });
        await trace("ingest.step4.output", { output: review });
      } catch (error) {
        await session.close?.();
        throw error;
      }
      await session.close?.();
    } else {
      if (this.modelProvider.reviewIngestMemory) {
        await trace("ingest.step4.input", { input: { extraction: extracted, candidates: reviewCandidates } });
        review = await this.modelProvider.reviewIngestMemory({ extraction: extracted, candidates: reviewCandidates });
        await trace("ingest.step4.output", { output: review });
      }
    }
    if (review?.successExperience) {
      extracted = { ...extracted, successExperience: review.successExperience };
    }
    if (review?.action === "skip") {
      return {
        episode: skippedEpisode(input.text, extracted.summary, timestamp),
        entities: [],
        relations: [],
        meta: ingestMeta("duplicate", 0, 0, review.reason ?? "duplicate or highly similar memory")
      };
    }

    const reviewReplacementEntities =
      review?.action === "replace" && review.replaceEntityIds.length > 0
        ? (await this.graphStore.findEntitiesByIds?.(review.replaceEntityIds)) ?? (await getExistingSnapshot()).entities.filter((entity) => review.replaceEntityIds.includes(entity.id))
        : [];
    const reviewReplacementRelations =
      review?.action === "replace" && review.replaceRelationIds.length > 0
        ? (await this.graphStore.findRelationsByIds?.(review.replaceRelationIds)) ?? (await getExistingSnapshot()).relations.filter((relation) => review.replaceRelationIds.includes(relation.id))
        : [];
    const source = sourceDraft ? await this.createSource(sourceDraft) : undefined;
    await trace("ingest.write.start", { details: { entities: extracted.entities.length, relations: extracted.relations.length } });

    const entities: Entity[] = [];
    const entityIdByName = new Map<string, string>();
    let entitiesMerged = 0;
    let relationsMerged = 0;

    for (const partial of extracted.entities) {
      const generatedId = stableId("entity", [partial.name, partial.type]);
      const incoming: Entity = {
        id: generatedId,
        name: partial.name,
        type: partial.type ?? "concept",
        summary: partial.summary,
        aliases: partial.aliases ?? [],
        tags: partial.tags ?? [],
        confidence: partial.confidence ?? 0.5,
        createdAt: timestamp,
        updatedAt: timestamp,
        externalRefs: partial.externalRefs
      };
      const match =
        review?.action === "replace"
          ? findSimilarEntity(reviewReplacementEntities, incoming) ?? takeFirstUnusedEntity(reviewReplacementEntities, entities)
          : review
            ? undefined
            : findSimilarEntity(
                (await this.graphStore.findEntityCandidates?.({ name: incoming.name, aliases: incoming.aliases, type: incoming.type, limit: 20 })) ??
                  (await getExistingSnapshot()).entities,
                incoming
              );
      const entity = match ? (review?.action === "replace" ? replaceEntity(match, incoming, timestamp) : mergeEntity(match, incoming, timestamp)) : incoming;
      if (match) entitiesMerged += 1;
      const written = await this.vaultStore.writeEntity(entity);
      await this.graphStore.upsertEntity(written);
      entities.push(written);
      entityIdByName.set(partial.name, written.id);
      entityIdByName.set(generatedId, written.id);
      entityIdByName.set(written.id, written.id);
      for (const alias of written.aliases) {
        entityIdByName.set(alias, written.id);
      }
    }

    const episode: Episode = {
      id: stableId("episode", [source?.id, input.text]),
      title: (extracted.successExperience ?? extracted.summary).split(/\s+/).slice(0, 8).join(" ") || input.text.split(/\s+/).slice(0, 8).join(" ") || "Memory episode",
      text: input.text,
      summary: extracted.successExperience ?? extracted.summary,
      sourceId: source?.id,
      entityIds: entities.map((entity) => entity.id),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const writtenEpisode = await this.vaultStore.writeEpisode(episode);
    await this.graphStore.upsertEpisode(writtenEpisode);

    const relations: Relation[] = [];
    for (const partial of extracted.relations) {
      const sourceId = entityIdByName.get(partial.sourceId) ?? partial.sourceId;
      const targetId = entityIdByName.get(partial.targetId) ?? partial.targetId;
      if (!entities.some((entity) => entity.id === sourceId) || !entities.some((entity) => entity.id === targetId)) {
        continue;
      }
      const relation: Relation = {
        id: stableId("relation", [sourceId, partial.predicate, targetId]),
        sourceId,
        targetId,
        predicate: partial.predicate,
        description: partial.description,
        weight: partial.weight ?? 1,
        confidence: partial.confidence ?? 0.5,
        evidenceIds: [writtenEpisode.id, ...(partial.evidenceIds ?? [])],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const match =
        review?.action === "replace"
          ? findSimilarRelation(reviewReplacementRelations, relation) ?? takeFirstUnusedRelation(reviewReplacementRelations, relations)
          : review
            ? undefined
            : this.graphStore.findRelationByTriple
              ? await this.graphStore.findRelationByTriple({
                  sourceId: relation.sourceId,
                  predicate: relation.predicate,
                  targetId: relation.targetId
                })
              : findSimilarRelation((await getExistingSnapshot()).relations, relation);
      const reviewedRelation = match ? (review?.action === "replace" ? replaceRelation(match, relation, timestamp) : mergeRelation(match, relation, timestamp)) : relation;
      if (match) relationsMerged += 1;
      const written = await this.vaultStore.writeRelation(reviewedRelation);
      await this.graphStore.upsertRelation(written);
      relations.push(written);
    }

    const result = { source, episode: writtenEpisode, entities, relations, meta: ingestMeta(entitiesMerged + relationsMerged > 0 ? "merged" : "created", entitiesMerged, relationsMerged) };
    await trace("ingest.write.output", { output: result });
    return result;
  }

  async query(input: QueryInput): Promise<QueryResult> {
    const trace = createQueryTracer(input.onProgress);
    await this.ensureReady();
    await trace("ensureReady");
    const limit = normalizeQueryLimit(input.limit);
    const maxHops = FIXED_QUERY_HOPS;
    await trace("prepare", { limit, maxHops, requestedMaxHops: input.maxHops, relationsPerNode: MAX_RELATIONS_PER_NODE });
    const interpretation = await this.modelProvider.extractQuery({ text: input.text });
    const intent = inferQueryIntent(input.text, interpretation);
    await trace("model.extractQuery", {
      keywords: interpretation.keywords,
      entities: interpretation.entities,
      predicates: interpretation.predicates,
      searchTerms: querySearchTerms(interpretation),
      targetEntityTypes: intent.targetEntityTypes
    });
    const directMatches = await this.searchQueryTerms(interpretation, intent, trace);
    await trace("graph.search", { matches: directMatches.length, perTermLimit: MAX_DIRECT_MATCHES_PER_TERM });
    const expanded = await this.expandMatchesFixedHops(directMatches, intent, maxHops, trace);
    const traversal = expanded.traversal;
    const synthesisMatches = normalizeQueryMatches(dedupeMatches([...expanded.matches, ...directMatches]));
    await trace("graph.expand.complete", { matches: synthesisMatches.length, hops: traversal.length });
    const matches = normalizeQueryMatches(selectEvidenceMatches(synthesisMatches));
    let answer = "";
    if (input.synthesize !== false) {
      answer = await this.modelProvider.synthesizeAnswer({ query: input.text, interpretation, matches: synthesisMatches });
      await trace("model.synthesizeAnswer", { answerChars: answer.length });
    } else {
      await trace("model.synthesizeAnswer.skipped", { reason: "synthesize=false" });
    }
    await trace("query.complete", { matches: matches.length });
    return { query: input.text, interpretation, matches, answer, traversal };
  }

  async link(input: { from: string; to: string; type: string; description?: string }): Promise<Relation> {
    await this.ensureReady();
    const timestamp = nowIso();
    const graph = await this.graphStore.graph();
    const entityIds = new Set(graph.entities.map((entity) => entity.id));
    const missingIds = [input.from, input.to].filter((id) => !entityIds.has(id));
    if (missingIds.length > 0) {
      throw new Error(`Cannot create relation with unknown entity id(s): ${missingIds.join(", ")}`);
    }
    const relation: Relation = {
      id: stableId("relation", [input.from, input.type, input.to]),
      sourceId: input.from,
      targetId: input.to,
      predicate: input.type,
      description: input.description,
      weight: 1,
      confidence: 1,
      evidenceIds: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const written = await this.vaultStore.writeRelation(relation);
    await this.graphStore.upsertRelation(written);
    return written;
  }

  async graph(entityId?: string): Promise<GraphSnapshot> {
    await this.ensureReady();
    return this.graphStore.graph(entityId);
  }

  async rebuild(): Promise<void> {
    await this.ensureReady();
    const snapshot = await this.vaultStore.readSnapshot();
    await this.graphStore.rebuild(snapshot);
    await this.vaultStore.repairLinks?.();
  }

  async reindex(): Promise<void> {
    await this.ensureReady();
    await this.graphStore.reindex();
  }

  async compact(): Promise<string> {
    await this.ensureReady();
    const snapshot = await this.graphStore.graph();
    const text = snapshot.episodes.map((episode) => `${episode.title}\n${episode.text}`).join("\n\n---\n\n");
    return this.modelProvider.compact ? this.modelProvider.compact({ text }) : text;
  }

  async export(): Promise<GraphSnapshot> {
    await this.ensureReady();
    return this.graphStore.graph();
  }

  async import(input: { path: string }): Promise<GraphSnapshot> {
    await this.ensureReady();
    const content = await readFile(resolve(input.path), "utf8");
    const parsed = JSON.parse(content) as Partial<GraphSnapshot>;
    const snapshot: GraphSnapshot = {
      entities: parsed.entities ?? [],
      relations: parsed.relations ?? [],
      episodes: parsed.episodes ?? [],
      sources: parsed.sources ?? []
    };
    for (const source of snapshot.sources) await this.vaultStore.writeSource(source);
    for (const entity of snapshot.entities) await this.vaultStore.writeEntity(entity);
    for (const episode of snapshot.episodes) await this.vaultStore.writeEpisode(episode);
    for (const relation of snapshot.relations) await this.vaultStore.writeRelation(relation);
    await this.graphStore.rebuild(await this.vaultStore.readSnapshot());
    return snapshot;
  }

  async status(): Promise<MemoryStatus> {
    await this.ensureReady();
    return this.graphStore.status();
  }

  async doctor(options?: { modelCall?: boolean }): Promise<Array<{ name: string; ok: boolean; message: string }>> {
    const checks: Array<{ name: string; ok: boolean; message: string }> = [];
    checks.push({
      name: "node",
      ok: isSupportedNode(),
      message: `Node.js ${process.version}; required >=22.13.`
    });

    try {
      await importNodeSqlite();
      checks.push({ name: "node:sqlite", ok: true, message: "node:sqlite is importable." });
    } catch (error) {
      checks.push({ name: "node:sqlite", ok: false, message: error instanceof Error ? error.message : String(error) });
    }

    try {
      await this.init();
      const status = await this.status();
      checks.push({ name: "vault", ok: true, message: `Vault ready at ${status.vaultPath}.` });
      checks.push({ name: "sqlite", ok: true, message: `Database ready at ${status.databasePath}.` });
    } catch (error) {
      checks.push({ name: "vault/sqlite", ok: false, message: error instanceof Error ? error.message : String(error) });
    }

    const modelCheck = this.modelProvider.doctor ? await this.modelProvider.doctor({ modelCall: options?.modelCall }) : { ok: true, message: "No model doctor check defined." };
    checks.push({ name: "model", ...modelCheck });
    return checks;
  }

  private async createSource(source: SourceRef): Promise<SourceRef> {
    const written = await this.vaultStore.writeSource(source);
    await this.graphStore.upsertSource(written);
    return written;
  }

  private async findIngestReviewCandidates(extracted: ExtractedMemory, limit: number): Promise<MemoryMatch[]> {
    const terms = uniqueStrings([
      extracted.successExperience ?? "",
      extracted.summary,
      ...extracted.entities.flatMap((entity) => [entity.name, entity.summary ?? "", ...(entity.aliases ?? []), ...(entity.tags ?? [])]),
      ...extracted.relations.flatMap((relation) => [relation.sourceId, relation.predicate, relation.targetId, relation.description ?? ""])
    ]);
    return normalizeQueryMatches(await this.graphStore.search(terms.join(" "), limit, { kinds: ["entity", "relation"] }));
  }

  private async recordIngestCache(keyInformation: IngestKeyInformation, extraction: ExtractedMemory, timestamp: string): Promise<{ promoted: boolean; rank: number }> {
    const cacheDir = join(this.config.vaultPath, INTERNAL_DIR, INGEST_CACHE_DIR);
    await mkdir(cacheDir, { recursive: true });
    const now = Date.parse(timestamp);
    const entries = await readIngestCacheEntries(cacheDir, now);
    const text = ingestCacheComparableText(keyInformation, extraction);
    const best = entries
      .map((entry) => ({ entry, similarity: textSimilarity(text, ingestCacheComparableText(entry.keyInformation, entry.extraction)) }))
      .sort((left, right) => right.similarity - left.similarity)[0];

    if (best && best.similarity >= INGEST_CACHE_SIMILARITY_THRESHOLD) {
      const updated: IngestCacheEntry = {
        ...best.entry,
        rank: best.entry.rank + 1,
        updatedAt: timestamp,
        keyInformation,
        extraction
      };
      await writeIngestCacheEntry(cacheDir, updated);
      return { promoted: updated.rank >= INGEST_CACHE_PROMOTION_RANK, rank: updated.rank };
    }

    const entry: IngestCacheEntry = {
      id: stableId("ingest-cache", [text]),
      rank: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      keyInformation,
      extraction
    };
    await writeIngestCacheEntry(cacheDir, entry);
    return { promoted: false, rank: entry.rank };
  }

  private async searchQueryTerms(interpretation: Awaited<ReturnType<ModelProvider["extractQuery"]>>, intent: QueryIntent, trace?: QueryProgressReporter): Promise<MemoryMatch[]> {
    const terms = querySearchTerms(interpretation);
    await trace?.("graph.search.terms", { terms, targetEntityTypes: intent.targetEntityTypes, limitPerTerm: MAX_DIRECT_MATCHES_PER_TERM });
    const matches: MemoryMatch[] = [];
    for (const term of terms) {
      const termMatches = normalizeQueryMatches(await this.graphStore.search(term, MAX_DIRECT_MATCHES_PER_TERM, { kinds: ["entity", "relation"] }), MAX_DIRECT_MATCHES_PER_TERM);
      await trace?.("graph.search.term", { term, matches: matchLogItems(termMatches), limit: MAX_DIRECT_MATCHES_PER_TERM });
      matches.push(...termMatches);
    }
    return normalizeQueryMatches(matches);
  }

  private async expandMatchesFixedHops(
    directMatches: MemoryMatch[],
    intent: QueryIntent,
    maxHops: number,
    trace?: QueryProgressReporter
  ): Promise<{ matches: MemoryMatch[]; traversal: QueryTraversalStep[] }> {
    const traversal: QueryTraversalStep[] = [];
    const visitedNodeIds = new Set<string>();
    const matches: MemoryMatch[] = [];
    let candidates = entityCandidatesFromMatches(directMatches);

    for (let hop = 0; hop < maxHops; hop += 1) {
      const availableCandidates = candidates.filter((candidate) => !visitedNodeIds.has(candidate.id));
      await trace?.("graph.expand.hop.candidates", { hop: hop + 1, candidates: availableCandidates.map(candidateLogItem), relationsPerNode: MAX_RELATIONS_PER_NODE });
      if (availableCandidates.length === 0) break;

      const selectedNodeIds = availableCandidates.map((candidate) => candidate.id);
      for (const nodeId of selectedNodeIds) visitedNodeIds.add(nodeId);
      const expanded = await this.expandNodes(selectedNodeIds, intent);
      await trace?.("graph.expandNodes", {
        hop: hop + 1,
        selectedNodes: selectedNodeIds.length,
        addedMatches: expanded.matches.length,
        candidates: expanded.candidates.length,
        expandedNodes: expanded.expandedNodes
      });
      matches.push(...expanded.matches);
      traversal.push({
        hop: hop + 1,
        fromNodeIds: selectedNodeIds,
        selectedNodeIds,
        addedMatchIds: expanded.matches.map((match) => `${match.kind}:${match.id}`),
        decisionReason: `fixed ${maxHops}-hop expansion`
      });
      candidates = dedupeCandidates(expanded.candidates);
    }

    return { matches: dedupeMeaningfulMatches(matches), traversal };
  }

  private async expandNodes(nodeIds: string[], intent: QueryIntent): Promise<{ matches: MemoryMatch[]; candidates: QueryHopCandidate[]; expandedNodes: QueryNodeExpansion[] }> {
    const matches: MemoryMatch[] = [];
    const candidates: QueryHopCandidate[] = [];
    const expandedNodes: QueryNodeExpansion[] = [];
    for (const nodeId of nodeIds) {
      const graph = await this.graphStore.graph(nodeId);
      const entityById = new Map(graph.entities.map((entity) => [entity.id, entity]));
      const nodeEntity = entityById.get(nodeId);
      const nodeRelations = prioritizedRelationsForNode(graph, nodeId, intent).slice(0, MAX_RELATIONS_PER_NODE);
      const nodeMatches: MemoryMatch[] = [];
      for (const relation of nodeRelations) {
        const relationMatch: MemoryMatch = {
          kind: "relation",
          id: relation.id,
          title: relation.predicate,
          text: relation.description ?? `${relation.sourceId} ${relation.predicate} ${relation.targetId}`,
          score: 0.8,
          metadata: relationMatchesIntent(graph, relation, nodeId, intent) ? { targetEntityTypeHit: true } : undefined
        };
        matches.push(relationMatch);
        nodeMatches.push(relationMatch);
      }
      const candidateIds = uniqueStrings(
        nodeRelations
          .flatMap((relation) => [relation.sourceId, relation.targetId])
          .filter((id) => id !== nodeId)
      );
      for (const id of candidateIds) {
        const entity = entityById.get(id);
        if (!entity) continue;
        const entityMatch: MemoryMatch = {
          kind: "entity",
          id: entity.id,
          title: entity.name,
          text: [entity.name, entity.summary, entity.aliases.join(" "), entity.tags.join(" ")].filter(Boolean).join("\n"),
          score: 0.75
        };
        matches.push(entityMatch);
        nodeMatches.push(entityMatch);
        candidates.push({ id: entity.id, title: entity.name, summary: truncateText(entity.summary, MAX_MATCH_TEXT_CHARS) });
      }
      expandedNodes.push({
        id: nodeId,
        title: nodeEntity?.name ?? nodeId,
        matches: matchLogItems(nodeMatches),
        nextCandidates: candidates.filter((candidate) => candidateIds.includes(candidate.id)).map(candidateLogItem)
      });
    }
    return {
      matches: dedupeMeaningfulMatches(matches),
      candidates: dedupeCandidates(candidates),
      expandedNodes
    };
  }

  private async ensureReady(): Promise<void> {
    await this.vaultStore.init();
    await this.graphStore.init();
  }
}

export async function createDefaultEngine(vaultPath: string): Promise<MemoryEngine> {
  const config = defaultConfig(vaultPath);
  return MemoryEngine.create({ vaultPath, config });
}

function dedupeMatches<T extends { kind: string; id: string }>(matches: T[]): T[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${match.kind}:${match.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeMeaningfulMatches<T extends { kind: string; id: string; title: string; text: string }>(matches: T[]): T[] {
  const seenIds = new Set<string>();
  const seenMeanings = new Set<string>();
  return matches.filter((match) => {
    const idKey = `${match.kind}:${match.id}`;
    if (seenIds.has(idKey)) return false;
    const meaningKey = `${match.kind}:${normalizeComparableText([match.title, match.text].join(" "))}`;
    if (seenMeanings.has(meaningKey)) return false;
    seenIds.add(idKey);
    seenMeanings.add(meaningKey);
    return true;
  });
}

function selectEvidenceMatches(matches: MemoryMatch[]): MemoryMatch[] {
  const relations = matches.filter((match) => match.kind === "relation");
  const targetRelations = relations.filter((match) => match.metadata?.targetEntityTypeHit === true);
  if (targetRelations.length > 0) return targetRelations;
  return relations.length > 0 ? relations : matches;
}

function matchLogItems(matches: MemoryMatch[]): QueryLogMatch[] {
  return matches.map((match) => ({
    kind: match.kind,
    id: match.id,
    title: match.title,
    text: truncateText(match.text, 160)
  }));
}

function candidateLogItem(candidate: QueryHopCandidate): QueryLogCandidate {
  return {
    id: candidate.id,
    title: candidate.title,
    summary: truncateText(candidate.summary, 160)
  };
}

function dedupeCandidates(candidates: QueryHopCandidate[]): QueryHopCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

function entityCandidatesFromMatches(matches: MemoryMatch[]): QueryHopCandidate[] {
  return dedupeCandidates(
    matches
      .filter((match) => match.kind === "entity")
      .map((match) => ({
        id: match.id,
        title: match.title,
        summary: truncateText(match.text, MAX_MATCH_TEXT_CHARS)
      }))
  );
}

function querySearchTerms(interpretation: QueryInterpretation): string[] {
  const terms = uniqueStrings([...interpretation.keywords, ...interpretation.entities, ...interpretation.predicates]);
  return terms.length > 0 ? terms : uniqueStrings([interpretation.expandedQuery]);
}

function inferQueryIntent(query: string, interpretation: QueryInterpretation): QueryIntent {
  const text = normalizeComparableText([query, ...interpretation.keywords, ...interpretation.entities, ...interpretation.predicates, interpretation.expandedQuery].join(" "));
  const targetEntityTypes: Entity["type"][] = [];
  if (/\b(who|whom|person|people|reviewer|reviewers|owner|owners|assignee|assignees|approver|approvers|author|authors)\b/.test(text) || /谁|哪位|提给谁|提交给谁|负责人|评审人|审核人|审批人|作者/.test(text)) {
    targetEntityTypes.push("person");
  }
  return { targetEntityTypes: uniqueEntityTypes(targetEntityTypes) };
}

function prioritizedRelationsForNode(graph: GraphSnapshot, nodeId: string, intent: QueryIntent): Relation[] {
  const entityById = new Map(graph.entities.map((entity) => [entity.id, entity]));
  return graph.relations
    .filter((relation) => relation.sourceId === nodeId || relation.targetId === nodeId)
    .map((relation, index) => ({
      relation,
      index,
      score: relationIntentScore(relation, nodeId, entityById, intent)
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.relation);
}

function relationIntentScore(relation: Relation, nodeId: string, entityById: Map<string, Entity>, intent: QueryIntent): number {
  const otherId = relation.sourceId === nodeId ? relation.targetId : relation.sourceId;
  const otherEntity = entityById.get(otherId);
  if (!otherEntity) return 0;
  if (intent.targetEntityTypes.includes(otherEntity.type)) return 10;
  if (otherEntity.tags.some((tag) => intent.targetEntityTypes.includes(tag as Entity["type"]))) return 8;
  return 0;
}

function relationMatchesIntent(graph: GraphSnapshot, relation: Relation, nodeId: string, intent: QueryIntent): boolean {
  if (intent.targetEntityTypes.length === 0) return false;
  const entityById = new Map(graph.entities.map((entity) => [entity.id, entity]));
  return relationIntentScore(relation, nodeId, entityById, intent) > 0;
}

function uniqueEntityTypes(values: Entity["type"][]): Entity["type"][] {
  const seen = new Set<Entity["type"]>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function ingestMeta(status: IngestResult["meta"]["status"], entitiesMerged: number, relationsMerged: number, reason?: string): IngestResult["meta"] {
  return {
    status,
    duplicate: status === "duplicate",
    merged: status === "merged",
    skipped: status === "skipped",
    entitiesMerged,
    relationsMerged,
    reason
  };
}

function skippedEpisode(text: string, summary: string | undefined, timestamp: string): Episode {
  return {
    id: stableId("episode", ["skipped", text]),
    title: summary?.split(/\s+/).slice(0, 8).join(" ") || text.split(/\s+/).slice(0, 8).join(" ") || "Skipped memory episode",
    text,
    summary,
    entityIds: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function findExactEpisode(episodes: Episode[], text: string): Episode | undefined {
  const normalizedText = normalizeComparableText(text);
  return episodes.find((episode) => normalizeComparableText(episode.text) === normalizedText);
}

function takeFirstUnusedEntity(candidates: Entity[], written: Entity[]): Entity | undefined {
  const used = new Set(written.map((entity) => entity.id));
  return candidates.find((candidate) => !used.has(candidate.id));
}

function takeFirstUnusedRelation(candidates: Relation[], written: Relation[]): Relation | undefined {
  const used = new Set(written.map((relation) => relation.id));
  return candidates.find((candidate) => !used.has(candidate.id));
}

function findSimilarEntity(entities: Entity[], incoming: Entity): Entity | undefined {
  const incomingNames = entityComparableNames(incoming);
  return entities.find((entity) => {
    if (entity.type !== incoming.type && entity.type !== "unknown" && incoming.type !== "unknown") return false;
    const existingNames = entityComparableNames(entity);
    if (incomingNames.some((name) => existingNames.includes(name))) return true;
    return incomingNames.some((incomingName) => existingNames.some((existingName) => textSimilarity(incomingName, existingName) >= 0.9));
  });
}

function findSimilarRelation(relations: Relation[], incoming: Relation): Relation | undefined {
  return relations.find((relation) => {
    if (relation.sourceId !== incoming.sourceId || relation.targetId !== incoming.targetId || relation.predicate !== incoming.predicate) return false;
    return true;
  });
}

function mergeEntity(existing: Entity, incoming: Entity, timestamp: string): Entity {
  return {
    ...existing,
    name: preferredText(existing.name, incoming.name),
    type: existing.type === "unknown" ? incoming.type : existing.type,
    summary: mergeText(existing.summary, incoming.summary),
    aliases: uniqueStrings([...existing.aliases, incoming.name, ...incoming.aliases].filter((alias) => normalizeComparableText(alias) !== normalizeComparableText(existing.name))),
    tags: uniqueStrings([...existing.tags, ...incoming.tags]),
    confidence: Math.max(existing.confidence, incoming.confidence),
    createdAt: existing.createdAt,
    updatedAt: timestamp,
    externalRefs: { ...existing.externalRefs, ...incoming.externalRefs },
    filePath: existing.filePath
  };
}

function replaceEntity(existing: Entity, incoming: Entity, timestamp: string): Entity {
  return {
    ...incoming,
    id: existing.id,
    aliases: uniqueStrings([incoming.name, ...incoming.aliases].filter((alias) => normalizeComparableText(alias) !== normalizeComparableText(incoming.name))),
    createdAt: existing.createdAt,
    updatedAt: timestamp,
    filePath: existing.filePath
  };
}

function mergeRelation(existing: Relation, incoming: Relation, timestamp: string): Relation {
  return {
    ...existing,
    description: mergeText(existing.description, incoming.description),
    weight: Math.max(existing.weight, incoming.weight),
    confidence: Math.max(existing.confidence, incoming.confidence),
    evidenceIds: uniqueStrings([...existing.evidenceIds, ...incoming.evidenceIds]),
    createdAt: existing.createdAt,
    updatedAt: timestamp,
    filePath: existing.filePath
  };
}

function replaceRelation(existing: Relation, incoming: Relation, timestamp: string): Relation {
  return {
    ...incoming,
    id: existing.id,
    evidenceIds: uniqueStrings(incoming.evidenceIds),
    createdAt: existing.createdAt,
    updatedAt: timestamp,
    filePath: existing.filePath
  };
}

function entityComparableNames(entity: Entity): string[] {
  return uniqueStrings([entity.name, ...entity.aliases].map(normalizeComparableText).filter(Boolean));
}

function mergeText(existing: string | undefined, incoming: string | undefined): string | undefined {
  const existingText = existing?.trim();
  const incomingText = incoming?.trim();
  if (!existingText) return incomingText;
  if (!incomingText) return existingText;
  const existingComparable = normalizeComparableText(existingText);
  const incomingComparable = normalizeComparableText(incomingText);
  if (existingComparable === incomingComparable || existingComparable.includes(incomingComparable)) return existingText;
  if (incomingComparable.includes(existingComparable)) return incomingText;
  return `${existingText}\n\n${incomingText}`;
}

function preferredText(existing: string, incoming: string): string {
  return incoming.length > existing.length && normalizeComparableText(incoming).includes(normalizeComparableText(existing)) ? incoming : existing;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = normalizeComparableText(trimmed);
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
}

function textSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeComparableText(left);
  const normalizedRight = normalizeComparableText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    const shorter = Math.min(normalizedLeft.length, normalizedRight.length);
    const longer = Math.max(normalizedLeft.length, normalizedRight.length);
    return shorter / longer;
  }
  return Math.max(jaccard(tokenize(normalizedLeft), tokenize(normalizedRight)), jaccard(characterBigrams(normalizedLeft), characterBigrams(normalizedRight)));
}

function normalizeComparableText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokenize(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

function characterBigrams(value: string): string[] {
  const compact = value.replace(/\s+/g, "");
  if (compact.length <= 1) return compact ? [compact] : [];
  const grams: string[] = [];
  for (let index = 0; index < compact.length - 1; index += 1) {
    grams.push(compact.slice(index, index + 2));
  }
  return grams;
}

function jaccard(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) intersection += 1;
  }
  return intersection / new Set([...leftSet, ...rightSet]).size;
}

function normalizeQueryLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_QUERY_LIMIT;
  if (!Number.isFinite(value)) return DEFAULT_QUERY_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_QUERY_MATCHES);
}

function normalizeQueryMatches(matches: MemoryMatch[], maxMatches?: number): MemoryMatch[] {
  const normalized = dedupeMeaningfulMatches(matches).filter((match) => match.kind === "entity" || match.kind === "relation");
  return (maxMatches === undefined ? normalized : normalized.slice(0, maxMatches)).map((match) => ({
      ...match,
      text: truncateText(match.text, MAX_MATCH_TEXT_CHARS)
    }));
}

function truncateText(value: string | undefined, maxChars: number): string {
  if (!value) return "";
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}\n[truncated]`;
}

type QueryProgressReporter = (stage: string, details?: Record<string, unknown>) => Promise<void>;
type IngestProgressReporter = (stage: string, payload?: { input?: unknown; output?: unknown; details?: Record<string, unknown> }) => Promise<void>;

interface QueryLogMatch {
  kind: MemoryMatch["kind"];
  id: string;
  title: string;
  text: string;
}

interface QueryLogCandidate {
  id: string;
  title: string;
  summary: string;
}

interface QueryNodeExpansion {
  id: string;
  title: string;
  matches: QueryLogMatch[];
  nextCandidates: QueryLogCandidate[];
}

interface QueryIntent {
  targetEntityTypes: Entity["type"][];
}

interface IngestCacheEntry {
  id: string;
  rank: number;
  createdAt: string;
  updatedAt: string;
  keyInformation: IngestKeyInformation;
  extraction: ExtractedMemory;
}

async function readIngestCacheEntries(cacheDir: string, now: number): Promise<IngestCacheEntry[]> {
  const entries: IngestCacheEntry[] = [];
  for (const name of await readdir(cacheDir)) {
    if (!name.endsWith(".json")) continue;
    const filePath = join(cacheDir, name);
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as IngestCacheEntry;
      const createdAt = Date.parse(parsed.createdAt);
      if (Number.isFinite(createdAt) && now - createdAt > INGEST_CACHE_MAX_AGE_MS) {
        await unlink(filePath).catch(() => undefined);
        continue;
      }
      if (parsed.id && parsed.keyInformation && parsed.extraction) entries.push(parsed);
    } catch {
      await unlink(filePath).catch(() => undefined);
    }
  }
  return entries;
}

async function writeIngestCacheEntry(cacheDir: string, entry: IngestCacheEntry): Promise<void> {
  await writeFile(join(cacheDir, `${slugForCacheFile(entry.id)}.json`), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
}

function slugForCacheFile(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function ingestCacheComparableText(keyInformation: IngestKeyInformation, extraction: ExtractedMemory): string {
  return [
    keyInformation.summary,
    ...keyInformation.facts,
    extraction.summary,
    ...extraction.entities.map((entity) => [entity.name, entity.summary, ...(entity.aliases ?? []), ...(entity.tags ?? [])].filter(Boolean).join(" ")),
    ...extraction.relations.map((relation) => [relation.sourceId, relation.predicate, relation.targetId, relation.description].filter(Boolean).join(" "))
  ].join("\n");
}

function createQueryTracer(onProgress?: QueryInput["onProgress"]): QueryProgressReporter {
  const startedAt = Date.now();
  let lastAt = startedAt;
  return async (stage: string, details?: Record<string, unknown>) => {
    if (!onProgress) return;
    const now = Date.now();
    const event: QueryProgressEvent = {
      stage,
      durationMs: now - lastAt,
      totalMs: now - startedAt,
      details
    };
    lastAt = now;
    await onProgress(event);
  };
}

function createIngestTracer(onProgress?: IngestInput["onProgress"]): IngestProgressReporter {
  const startedAt = Date.now();
  let lastAt = startedAt;
  return async (stage: string, payload?: { input?: unknown; output?: unknown; details?: Record<string, unknown> }) => {
    if (!onProgress) return;
    const now = Date.now();
    const event: IngestProgressEvent = {
      stage,
      durationMs: now - lastAt,
      totalMs: now - startedAt,
      input: payload?.input,
      output: payload?.output,
      details: payload?.details
    };
    lastAt = now;
    await onProgress(event);
  };
}

function isSupportedNode(): boolean {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

export async function textOrFile(value: string): Promise<{ text: string; label: string; uri?: string }> {
  try {
    const text = await readFile(resolve(value), "utf8");
    return { text, label: basename(value), uri: resolve(value) };
  } catch {
    return { text: value, label: "CLI input" };
  }
}

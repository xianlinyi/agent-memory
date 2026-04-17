import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { defaultConfig, loadConfig, writeConfig } from "../config.js";
import { CopilotCliModelProvider } from "../model/copilot-cli-provider.js";
import { CopilotSdkModelProvider } from "../model/copilot-sdk-provider.js";
import type { ModelProvider } from "../model/model-provider.js";
import type { GraphStore } from "../store/graph-store.js";
import { NodeSqliteFtsGraphStore } from "../store/node-sqlite-fts-store.js";
import { NoopEmbeddingProvider, type EmbeddingProvider } from "../store/embedding.js";
import { NoopVectorStore, type VectorStore } from "../store/vector-store.js";
import type {
  AgentMemoryConfig,
  Entity,
  Episode,
  GraphSnapshot,
  IngestInput,
  MemoryMatch,
  MemoryStatus,
  QueryHopCandidate,
  QueryInput,
  QueryResult,
  QueryTraversalStep,
  Relation,
  SourceRef
} from "../types.js";
import { stableId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";
import { ObsidianVaultStore, type VaultStore } from "../vault/vault-store.js";

const DEFAULT_MAX_HOPS = 2;
const MAX_HOPS = 3;
const MAX_NODES_PER_HOP = 5;

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
    const config = options.config ?? (await loadConfig(options.vaultPath));
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

  async ingest(input: IngestInput): Promise<{ source?: SourceRef; episode: Episode; entities: Entity[]; relations: Relation[] }> {
    await this.ensureReady();
    const timestamp = nowIso();
    const extracted = await this.modelProvider.extractMemory({ text: input.text });
    const source = input.source
      ? await this.createSource({
          id: stableId("source", [input.source.kind ?? "cli", input.source.label, input.source.uri, input.text]),
          kind: input.source.kind ?? "cli",
          label: input.source.label ?? input.source.uri ?? "CLI input",
          uri: input.source.uri,
          text: input.text,
          createdAt: timestamp,
          updatedAt: timestamp
        })
      : undefined;

    const entities: Entity[] = [];
    const entityIdByName = new Map<string, string>();

    for (const partial of extracted.entities) {
      const id = stableId("entity", [partial.name, partial.type]);
      const entity: Entity = {
        id,
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
      const written = await this.vaultStore.writeEntity(entity);
      await this.graphStore.upsertEntity(written);
      entities.push(written);
      entityIdByName.set(partial.name, id);
      entityIdByName.set(id, id);
    }

    const episode: Episode = {
      id: stableId("episode", [source?.id, input.text]),
      title: extracted.summary.split(/\s+/).slice(0, 8).join(" ") || input.text.split(/\s+/).slice(0, 8).join(" ") || "Memory episode",
      text: input.text,
      summary: extracted.summary,
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
      const written = await this.vaultStore.writeRelation(relation);
      await this.graphStore.upsertRelation(written);
      relations.push(written);
    }

    return { source, episode: writtenEpisode, entities, relations };
  }

  async query(input: QueryInput): Promise<QueryResult> {
    await this.ensureReady();
    const limit = input.limit ?? 10;
    const maxHops = normalizeMaxHops(input.maxHops);
    const interpretation = await this.modelProvider.extractQuery({ text: input.text });
    const directMatches = await this.graphStore.search(interpretation.expandedQuery, limit);
    let traversal: QueryTraversalStep[] | undefined;
    let matches: MemoryMatch[];
    if (maxHops === 0) {
      matches = directMatches;
    } else if (this.modelProvider.decideQueryHop) {
      const expanded = await this.expandMatchesWithModel(input.text, interpretation, directMatches, limit, maxHops);
      matches = expanded.matches;
      traversal = expanded.traversal;
    } else {
      const expanded = await this.expandEntityMatches(directMatches, limit);
      matches = dedupeMatches([...directMatches, ...expanded]).slice(0, limit);
    }
    const answer = await this.modelProvider.synthesizeAnswer({ query: input.text, interpretation, matches });
    return { query: input.text, interpretation, matches, answer, traversal };
  }

  async link(input: { from: string; to: string; type: string; description?: string }): Promise<Relation> {
    await this.ensureReady();
    const timestamp = nowIso();
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
    await this.graphStore.rebuild(await this.vaultStore.readSnapshot());
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
      await import("node:sqlite");
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

  private async expandEntityMatches(matches: Awaited<ReturnType<GraphStore["search"]>>, limit: number): Promise<Awaited<ReturnType<GraphStore["search"]>>> {
    const expanded: Awaited<ReturnType<GraphStore["search"]>> = [];
    for (const match of matches.filter((item) => item.kind === "entity")) {
      const graph = await this.graphStore.graph(match.id);
      for (const relation of graph.relations.slice(0, limit)) {
        expanded.push({
          kind: "relation",
          id: relation.id,
          title: relation.predicate,
          text: relation.description ?? `${relation.sourceId} ${relation.predicate} ${relation.targetId}`,
          score: Math.max(match.score - 0.1, 0)
        });
      }
    }
    return expanded;
  }

  private async expandMatchesWithModel(
    query: string,
    interpretation: Awaited<ReturnType<ModelProvider["extractQuery"]>>,
    directMatches: MemoryMatch[],
    limit: number,
    maxHops: number
  ): Promise<{ matches: MemoryMatch[]; traversal: QueryTraversalStep[] }> {
    const traversal: QueryTraversalStep[] = [];
    const visitedNodeIds = new Set<string>();
    let matches = [...directMatches];
    let candidates = entityCandidatesFromMatches(directMatches);

    for (let hop = 0; hop < maxHops; hop += 1) {
      const availableCandidates = candidates.filter((candidate) => !visitedNodeIds.has(candidate.id));
      if (availableCandidates.length === 0) break;

      const decision = await this.modelProvider.decideQueryHop?.({
        query,
        interpretation,
        hop,
        maxHops,
        matches: matches.slice(0, limit),
        candidates: availableCandidates,
        visitedNodeIds: [...visitedNodeIds]
      });
      if (!decision?.continue) break;

      const candidateIds = new Set(availableCandidates.map((candidate) => candidate.id));
      const selectedNodeIds = decision.nodeIds
        .filter((id) => candidateIds.has(id) && !visitedNodeIds.has(id))
        .slice(0, MAX_NODES_PER_HOP);
      if (selectedNodeIds.length === 0) break;

      for (const nodeId of selectedNodeIds) visitedNodeIds.add(nodeId);
      const expanded = await this.expandNodes(selectedNodeIds, limit);
      matches = dedupeMatches([...matches, ...expanded.matches]).slice(0, limit);
      traversal.push({
        hop: hop + 1,
        fromNodeIds: availableCandidates.map((candidate) => candidate.id),
        selectedNodeIds,
        addedMatchIds: expanded.matches.map((match) => `${match.kind}:${match.id}`),
        decisionReason: decision.reason
      });
      candidates = dedupeCandidates(expanded.candidates);
    }

    return { matches, traversal };
  }

  private async expandNodes(nodeIds: string[], limit: number): Promise<{ matches: MemoryMatch[]; candidates: QueryHopCandidate[] }> {
    const matches: MemoryMatch[] = [];
    const candidates: QueryHopCandidate[] = [];
    for (const nodeId of nodeIds) {
      const graph = await this.graphStore.graph(nodeId);
      for (const entity of graph.entities) {
        candidates.push({ id: entity.id, title: entity.name, summary: entity.summary });
      }
      for (const relation of graph.relations.slice(0, limit)) {
        matches.push({
          kind: "relation",
          id: relation.id,
          title: relation.predicate,
          text: relation.description ?? `${relation.sourceId} ${relation.predicate} ${relation.targetId}`,
          score: 0.8
        });
      }
    }
    return {
      matches: dedupeMatches(matches),
      candidates: dedupeCandidates(candidates)
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

function createModelProvider(config: AgentMemoryConfig): ModelProvider {
  if (config.model.provider === "copilot-cli") {
    return new CopilotCliModelProvider({
      command: config.model.command ?? "copilot",
      args: config.model.args ?? ["ask", "{prompt}"],
      promptInput: config.model.promptInput ?? "argument",
      timeoutMs: config.model.timeoutMs
    });
  }

  return new CopilotSdkModelProvider({
    model: config.model.model,
    reasoningEffort: config.model.reasoningEffort,
    timeoutMs: config.model.timeoutMs,
    cliPath: config.model.cliPath,
    cliUrl: config.model.cliUrl,
    cliArgs: config.model.cliArgs,
    cwd: config.model.cwd,
    configDir: config.model.configDir,
    githubToken: config.model.githubToken,
    useLoggedInUser: config.model.useLoggedInUser,
    logLevel: config.model.logLevel
  });
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
        summary: match.text
      }))
  );
}

function normalizeMaxHops(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_HOPS;
  if (!Number.isFinite(value)) return DEFAULT_MAX_HOPS;
  return Math.min(Math.max(Math.trunc(value), 0), MAX_HOPS);
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

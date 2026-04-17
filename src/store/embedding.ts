export interface EmbeddingProvider {
  embed?(input: { text: string }): Promise<number[]>;
}

export class NoopEmbeddingProvider implements EmbeddingProvider {}

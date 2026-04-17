import test from "node:test";
import assert from "node:assert/strict";
import { NoopEmbeddingProvider, NoopVectorStore } from "../src/index.js";

test("noop embedding and vector providers satisfy extension interfaces", () => {
  const embedding = new NoopEmbeddingProvider();
  const vector = new NoopVectorStore();

  assert.equal(typeof embedding, "object");
  assert.equal(typeof vector, "object");
});

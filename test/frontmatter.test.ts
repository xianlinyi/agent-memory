import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdownDocument, stringifyMarkdownDocument } from "../src/utils/frontmatter.js";

test("frontmatter roundtrip preserves common scalar and list fields", () => {
  const markdown = stringifyMarkdownDocument({
    frontmatter: {
      id: "entity:abc",
      type: "concept",
      aliases: ["Agent Memory", "AM"],
      confidence: 0.9,
      active: true
    },
    body: "# Agent Memory\n\nLocal-first memory."
  });

  const parsed = parseMarkdownDocument(markdown);
  assert.equal(parsed.frontmatter.id, "entity:abc");
  assert.deepEqual(parsed.frontmatter.aliases, ["Agent Memory", "AM"]);
  assert.equal(parsed.frontmatter.confidence, 0.9);
  assert.equal(parsed.frontmatter.active, true);
  assert.match(parsed.body, /Local-first memory/);
});

test("frontmatter roundtrip preserves session source metadata", () => {
  const markdown = stringifyMarkdownDocument({
    frontmatter: {
      id: "episode:abc",
      source_id: "source:abc",
      source_kind: "message",
      source_label: "Planning chat",
      source_uri: "memory://planning",
      entity_ids: ["entity:project-atlas"]
    },
    body: "# Planning session\n\n## Observation\nProject Atlas uses local memory."
  });

  const parsed = parseMarkdownDocument(markdown);
  assert.equal(parsed.frontmatter.source_id, "source:abc");
  assert.equal(parsed.frontmatter.source_kind, "message");
  assert.equal(parsed.frontmatter.source_label, "Planning chat");
  assert.equal(parsed.frontmatter.source_uri, "memory://planning");
  assert.deepEqual(parsed.frontmatter.entity_ids, ["entity:project-atlas"]);
});

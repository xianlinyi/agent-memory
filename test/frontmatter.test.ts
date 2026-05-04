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

test("frontmatter roundtrip preserves entity routing metadata", () => {
  const markdown = stringifyMarkdownDocument({
    frontmatter: {
      id: "page:payment-team",
      type: "capability",
      canonical: "Payment Team",
      aliases: ["payment"],
      hints: ["owner", "oncall"],
      entrypoints: ["pagerduty", "slack://payments-oncall"]
    },
    body: "# Payment Team\n\nEscalation path for payment incidents."
  });

  const parsed = parseMarkdownDocument(markdown);
  assert.equal(parsed.frontmatter.canonical, "Payment Team");
  assert.deepEqual(parsed.frontmatter.hints, ["owner", "oncall"]);
  assert.deepEqual(parsed.frontmatter.entrypoints, ["pagerduty", "slack://payments-oncall"]);
});

test("frontmatter roundtrip preserves memory staging metadata", () => {
  const markdown = stringifyMarkdownDocument({
    frontmatter: {
      id: "raw:incident-1",
      memory_class: "episodic",
      memory_stage: "candidate",
      session_id: "session-123",
      event_time: "2026-05-03T08:30:00.000Z",
      importance: 0.9,
      confidence: 0.7,
      supersedes: ["raw:incident-0"]
    },
    body: "# Raw Document\n\nPayment proof failed because MQ timed out."
  });

  const parsed = parseMarkdownDocument(markdown);
  assert.equal(parsed.frontmatter.memory_class, "episodic");
  assert.equal(parsed.frontmatter.memory_stage, "candidate");
  assert.equal(parsed.frontmatter.session_id, "session-123");
  assert.equal(parsed.frontmatter.event_time, "2026-05-03T08:30:00.000Z");
  assert.equal(parsed.frontmatter.importance, 0.9);
  assert.equal(parsed.frontmatter.confidence, 0.7);
  assert.deepEqual(parsed.frontmatter.supersedes, ["raw:incident-0"]);
});

test("frontmatter roundtrip preserves wiki update candidate metadata", () => {
  const markdown = stringifyMarkdownDocument({
    frontmatter: {
      id: "page:update-payment-proof",
      memory_stage: "wiki_update_candidate",
      review_status: "pending",
      wiki_target_title: "Payment Proof",
      wiki_target_path: "wiki/semantic/payment-proof.md",
      approved_at: "2026-05-03T12:00:00.000Z"
    },
    body: "# Payment Proof\n\nProposed wiki content."
  });

  const parsed = parseMarkdownDocument(markdown);
  assert.equal(parsed.frontmatter.memory_stage, "wiki_update_candidate");
  assert.equal(parsed.frontmatter.review_status, "pending");
  assert.equal(parsed.frontmatter.wiki_target_title, "Payment Proof");
  assert.equal(parsed.frontmatter.wiki_target_path, "wiki/semantic/payment-proof.md");
  assert.equal(parsed.frontmatter.approved_at, "2026-05-03T12:00:00.000Z");
});

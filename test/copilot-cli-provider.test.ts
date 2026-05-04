import test from "node:test";
import assert from "node:assert/strict";
import { CopilotCliModelProvider, type RawDocument } from "../src/index.js";

test("copilot CLI provider can pass wiki update prompt as an argument placeholder", async () => {
  const provider = new CopilotCliModelProvider({
    command: process.execPath,
    args: [
      "-e",
      [
        "const prompt = process.argv[1];",
        "if (!prompt.includes('local LLM Wiki')) process.exit(2);",
        "console.log(JSON.stringify({ pages: [{ title: 'Atlas', body: '# Atlas\\n\\nUses wiki.\\n\\n## Sources\\n- raw:test' }] }));"
      ].join(""),
      "{prompt}"
    ],
    promptInput: "argument",
    timeoutMs: 5000
  });

  const raw: RawDocument = { id: "raw:test", path: "raw/test.md", kind: "cli", label: "Test", contentHash: "hash", createdAt: new Date(0).toISOString(), text: "Atlas uses wiki." };
  const plan = await provider.planWikiUpdates({ raw, existingPages: [], schema: { pageTypes: "", styleGuide: "", lintRules: "" } });
  assert.equal(plan.pages[0]?.title, "Atlas");
  assert.deepEqual(plan.pages[0]?.sourceIds, ["raw:test"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { CopilotCliModelProvider } from "../src/index.js";

test("copilot CLI provider can pass prompt as an argument placeholder", async () => {
  const provider = new CopilotCliModelProvider({
    command: process.execPath,
    args: [
      "-e",
      [
        "const prompt = process.argv[1];",
        "if (!prompt.includes('Interpret this memory search query')) process.exit(2);",
        "console.log(JSON.stringify({ keywords: ['atlas'], entities: ['Atlas'], predicates: ['uses'], expandedQuery: 'Atlas uses' }));"
      ].join(""),
      "{prompt}"
    ],
    promptInput: "argument",
    timeoutMs: 5000
  });

  const query = await provider.extractQuery({ text: "Atlas uses what?" });
  assert.equal(query.expandedQuery, "Atlas uses");
  assert.deepEqual(query.entities, ["Atlas"]);
});

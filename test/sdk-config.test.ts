import test from "node:test";
import assert from "node:assert/strict";
import { createModelProvider, defaultConfig } from "../src/index.js";

test("createModelProvider uses AGENT_MEMORY_GITHUB_TOKEN when config token is absent", () => {
  const originalAgentMemoryToken = process.env.AGENT_MEMORY_GITHUB_TOKEN;
  const originalGithubToken = process.env.GITHUB_TOKEN;
  try {
    process.env.AGENT_MEMORY_GITHUB_TOKEN = "ghu_agent_memory_env_token";
    delete process.env.GITHUB_TOKEN;

    const provider = createModelProvider(defaultConfig("/tmp/agent-memory-sdk-env")) as unknown as {
      clientOptions(): { githubToken?: string; useLoggedInUser?: boolean };
    };
    const clientOptions = provider.clientOptions();

    assert.equal(clientOptions.githubToken, "ghu_agent_memory_env_token");
    assert.equal(clientOptions.useLoggedInUser, false);
  } finally {
    if (originalAgentMemoryToken === undefined) delete process.env.AGENT_MEMORY_GITHUB_TOKEN;
    else process.env.AGENT_MEMORY_GITHUB_TOKEN = originalAgentMemoryToken;
    if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalGithubToken;
  }
});

test("createModelProvider prefers explicit config token over environment token", () => {
  const originalAgentMemoryToken = process.env.AGENT_MEMORY_GITHUB_TOKEN;
  try {
    process.env.AGENT_MEMORY_GITHUB_TOKEN = "ghu_agent_memory_env_token";
    const config = defaultConfig("/tmp/agent-memory-sdk-config");
    config.model.githubToken = "ghu_agent_memory_config_token";
    config.model.useLoggedInUser = true;

    const provider = createModelProvider(config) as unknown as {
      clientOptions(): { githubToken?: string; useLoggedInUser?: boolean };
    };
    const clientOptions = provider.clientOptions();

    assert.equal(clientOptions.githubToken, "ghu_agent_memory_config_token");
    assert.equal(clientOptions.useLoggedInUser, true);
  } finally {
    if (originalAgentMemoryToken === undefined) delete process.env.AGENT_MEMORY_GITHUB_TOKEN;
    else process.env.AGENT_MEMORY_GITHUB_TOKEN = originalAgentMemoryToken;
  }
});
import { describe, expect, test } from "bun:test";
import { matchScore } from "../src/core/search.ts";

describe("catalog search", () => {
  test("matches every word in any order", () => {
    expect(matchScore("flash deepseek", "deepseek/deepseek-v4-flash", "DeepSeek: DeepSeek V4 Flash")).not.toBeNull();
    expect(matchScore("glm 5.3", "z-ai/glm-5.3-flash", "Z.ai: GLM 5.3 Flash")).not.toBeNull();
    expect(matchScore("gpt5", "openai/gpt-5", "OpenAI: GPT-5")).not.toBeNull();
    expect(matchScore("deepseek pro", "deepseek/deepseek-v4-flash", "DeepSeek: DeepSeek V4 Flash")).toBeNull();
  });

  test("exact words rank above prefixes", () => {
    const exact = matchScore("mistral small", "mistralai/mistral-small", "Mistral: Mistral Small")!;
    const prefix = matchScore("mistr sma", "mistralai/mistral-small", "Mistral: Mistral Small")!;
    expect(exact).toBeGreaterThan(prefix);
  });
});

test("single digits do not match inside versions", () => {
  expect(matchScore("glm 5", "z-ai/glm-4.5", "Z.ai: GLM 4.5")).toBeNull();
  expect(matchScore("glm 5", "z-ai/glm-5.3-flash", "Z.ai: GLM 5.3 Flash")).not.toBeNull();
});

test("versions match with or without the v prefix", () => {
  const id = "deepseek/deepseek-v4.1-flash";
  const name = "DeepSeek: DeepSeek V4.1 Flash";
  expect(matchScore("4.1", id, name)).not.toBeNull();
  expect(matchScore("deepseek v4.1", id, name)).not.toBeNull();
  expect(matchScore("deepseek 4.1", id, name)).not.toBeNull();
  expect(matchScore("4.1", "deepseek/deepseek-v4-flash", "DeepSeek: DeepSeek V4 Flash")).toBeNull();
});

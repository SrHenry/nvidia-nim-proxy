import { describe, it, expect } from "vitest";
import { createTokenizer } from "../../src/infrastructure/tokenizer.js";

describe("createTokenizer", () => {
  const tokenizer = createTokenizer();

  it("estimates tokens for simple text", () => {
    const tokens = tokenizer.estimateTokens("hello world");
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it("returns 0 for empty/null input", () => {
    expect(tokenizer.estimateTokens("")).toBe(0);
    expect(tokenizer.estimateTokens(null)).toBe(0);
    expect(tokenizer.estimateTokens(undefined)).toBe(0);
  });

  it("estimates message tokens", () => {
    const messages = [
      { role: "user", content: "hello world" },
    ];
    const tokens = tokenizer.estimateMessageTokens(messages);
    expect(tokens).toBeGreaterThan(4); // at least role overhead
  });

  it("returns 0 for non-array input", () => {
    expect(tokenizer.estimateMessageTokens(null)).toBe(0);
    expect(tokenizer.estimateMessageTokens("string")).toBe(0);
  });
});

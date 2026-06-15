import { describe, it, expect, beforeEach } from "vitest";
import { createModelInjector } from "../../src/domain/model-injector.js";

describe("createModelInjector", () => {
  let injector;

  beforeEach(() => {
    injector = createModelInjector({
      thinkingModels: [
        {
          pattern: /^z-ai\/glm-?5\.?1/i,
          injection: {
            chat_template_kwargs: { enable_thinking: true },
          },
        },
        {
          pattern: /^minimaxai\/minimax-m3$/i,
          injection: {
            chat_template_kwargs: { enable_thinking: true },
          },
        },
      ],
    });
  });

  it("patches GLM 5.1 with thinking enabled", () => {
    const body = { model: "z-ai/glm-5.1", messages: [] };
    const result = injector.patch("z-ai/glm-5.1", body);
    expect(result.chat_template_kwargs).toEqual({
      enable_thinking: true,
    });
  });

  it("patches MiniMax M3 with thinking enabled", () => {
    const body = { model: "minimaxai/minimax-m3", messages: [] };
    const result = injector.patch("minimaxai/minimax-m3", body);
    expect(result.chat_template_kwargs).toEqual({
      enable_thinking: true,
    });
  });

  it("does not patch unknown models", () => {
    const body = { model: "meta/llama-3.1-8b-instruct", messages: [] };
    const result = injector.patch("meta/llama-3.1-8b-instruct", body);
    expect(result.chat_template_kwargs).toBeUndefined();
  });

  it("preserves existing chat_template_kwargs", () => {
    const body = {
      model: "z-ai/glm-5.1",
      messages: [],
      chat_template_kwargs: { temperature: 0.7 },
    };
    const result = injector.patch("z-ai/glm-5.1", body);
    expect(result.chat_template_kwargs).toEqual({
      temperature: 0.7,
      enable_thinking: true,
    });
  });

  it("returns body unchanged for null/undefined", () => {
    expect(injector.patch("model", null)).toBeNull();
    expect(injector.patch("model", undefined)).toBeUndefined();
  });
});

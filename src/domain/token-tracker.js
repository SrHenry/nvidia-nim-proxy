const MAX_TOKEN_USAGE_ENTRIES = 500;

export function createTokenTracker(tokenizer, rateLimiter, logger) {
  let tokenUsage = [];
  let tokenUsageSummary = {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalRequests: 0,
    windowTokens: 0,
    windowStart: 0,
  };

  function now() {
    return Date.now();
  }

  function record(model, promptTokens, completionTokens, source) {
    const entry = {
      ts: now(),
      model,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      source,
    };

    tokenUsage.push(entry);

    if (tokenUsage.length > MAX_TOKEN_USAGE_ENTRIES) {
      tokenUsage = tokenUsage.slice(-MAX_TOKEN_USAGE_ENTRIES);
    }

    tokenUsageSummary.totalPromptTokens += promptTokens;
    tokenUsageSummary.totalCompletionTokens += completionTokens;
    tokenUsageSummary.totalRequests++;

    const windowMs = 60_000;
    const summaryCutoff = now() - windowMs;
    const recentUsage = tokenUsage.filter((e) => e.ts > summaryCutoff);
    tokenUsageSummary.windowTokens = recentUsage.reduce(
      (sum, e) => sum + e.totalTokens,
      0
    );
    tokenUsageSummary.windowStart = recentUsage.length
      ? recentUsage[0].ts
      : 0;

    if (logger) {
      logger.info(
        {
          model,
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          source,
          windowTokens: tokenUsageSummary.windowTokens,
        },
        "token usage"
      );
    }
  }

  function estimateFromResponse(model, body, responseBody) {
    let promptTokens = 0;
    let completionTokens = 0;
    let source = "estimated";

    if (body?.messages) {
      promptTokens = tokenizer.estimateMessageTokens(body.messages);
    }

    if (responseBody?.usage?.prompt_tokens != null) {
      promptTokens = responseBody.usage.prompt_tokens;
      source = "nim";
    }
    if (responseBody?.usage?.completion_tokens != null) {
      completionTokens = responseBody.usage.completion_tokens;
      source = "nim";
    }

    if (completionTokens === 0 && responseBody?.choices) {
      for (const choice of responseBody.choices) {
        const content =
          choice?.message?.content || choice?.delta?.content || "";
        if (content) {
          completionTokens += tokenizer.estimateTokens(content);
        }
      }
    }

    return { promptTokens, completionTokens, source };
  }

  function getSummary() {
    return { ...tokenUsageSummary };
  }

  function getEntries() {
    return [...tokenUsage];
  }

  function loadState(loaded) {
    if (loaded.tokenUsage) {
      tokenUsage = loaded.tokenUsage;
    }
    if (loaded.tokenUsageSummary) {
      tokenUsageSummary = {
        ...tokenUsageSummary,
        ...loaded.tokenUsageSummary,
      };
    }
  }

  function getState() {
    return { tokenUsage, tokenUsageSummary };
  }

  return {
    record,
    estimateFromResponse,
    getSummary,
    getEntries,
    loadState,
    getState,
  };
}

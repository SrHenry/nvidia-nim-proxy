import { Transform } from "node:stream";

export function createSSETapStream(model, body, tokenizer, tokenTracker) {
  let lineBuffer = "";
  let usage = null;
  let usageFromMeta = null;
  let contentTokens = 0;

  const tap = new Transform({
    transform(chunk, encoding, cb) {
      tap.push(chunk);

      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);

            if (parsed.usage) {
              usage = parsed.usage;
            }

            if (parsed.choices) {
              for (const choice of parsed.choices) {
                const content = choice?.delta?.content || choice?.delta?.reasoning_content || "";
                if (content) {
                  contentTokens += tokenizer.estimateTokens(content);
                }
              }
            }
          } catch {
            // not JSON, skip
          }
        } else if (line.startsWith(": ")) {
          const meta = line.slice(2).trim();
          if (meta) {
            try {
              const parsed = JSON.parse(meta);
              if (parsed.input_tokens != null || parsed.output_tokens != null) {
                usageFromMeta = parsed;
              }
            } catch {
              // not JSON, skip
            }
          }
        }
      }

      cb();
    },

    flush(cb) {
      if (lineBuffer.trim()) {
        const line = lineBuffer.trim();
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data !== "[DONE]") {
            try {
              const parsed = JSON.parse(data);
              if (parsed.usage) {
                usage = parsed.usage;
              }
            } catch {
              // ignore
            }
          }
        } else if (line.startsWith(": ")) {
          const meta = line.slice(2).trim();
          if (meta) {
            try {
              const parsed = JSON.parse(meta);
              if (parsed.input_tokens != null || parsed.output_tokens != null) {
                usageFromMeta = parsed;
              }
            } catch {
              // ignore
            }
          }
        }
      }

      let promptTokens = 0;
      let completionTokens = 0;
      let source = "estimated";

      if (body?.messages) {
        promptTokens = tokenizer.estimateMessageTokens(body.messages);
      }

      if (usage) {
        if (usage.prompt_tokens != null) {
          promptTokens = usage.prompt_tokens;
          source = "nim";
        }
        if (usage.completion_tokens != null) {
          completionTokens = usage.completion_tokens;
          source = "nim";
        }
      }

      if (source === "estimated" && usageFromMeta) {
        if (usageFromMeta.input_tokens != null) {
          promptTokens = usageFromMeta.input_tokens;
          source = "nim";
        }
        if (usageFromMeta.output_tokens != null) {
          completionTokens = usageFromMeta.output_tokens;
          source = "nim";
        }
      }

      if (source === "estimated") {
        completionTokens = contentTokens;
      }

      this.finalTokens = { promptTokens, completionTokens, source };

      cb();
    },
  });

  return tap;
}

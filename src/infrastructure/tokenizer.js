import { getEncoding } from "js-tiktoken";

export function createTokenizer(encoding = "cl100k_base") {
  const enc = getEncoding(encoding);

  function estimateTokens(text) {
    if (!text || typeof text !== "string") return 0;
    return enc.encode(text).length;
  }

  function estimateMessageTokens(messages) {
    if (!Array.isArray(messages)) return 0;
    let total = 0;
    for (const msg of messages) {
      if (msg.content) {
        total += estimateTokens(
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content)
        );
      }
      if (msg.role) total += 4;
      total += 2;
    }
    return total;
  }

  return { estimateTokens, estimateMessageTokens };
}

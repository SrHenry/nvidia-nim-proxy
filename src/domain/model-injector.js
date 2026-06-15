export function createModelInjector(config) {
  function patch(model, body) {
    if (!body || typeof body !== "object") return body;

    for (const rule of config.thinkingModels) {
      if (rule.pattern.test(model)) {
        return {
          ...body,
          chat_template_kwargs: {
            ...(body.chat_template_kwargs || {}),
            ...rule.injection.chat_template_kwargs,
          },
        };
      }
    }

    return body;
  }

  return { patch };
}

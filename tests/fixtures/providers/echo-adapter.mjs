// R1 proof: a provider added purely through providers.yaml (`kind: custom` + `module:`), with no change to engine code.
// It answers every call with {"ok": true, "echo": <last user message>} and validates against the requested schema.

export function createProvider({ name, config, modelKey }) {
  const key = modelKey ?? config.default_model;
  const model = config.models[key];
  return {
    name,
    info: { name, kind: 'custom', model_key: key, model_id: model.id, structured_output: model.structured_output },
    async complete(system, messages, params, responseSchema) {
      const last = [...messages].reverse().find((m) => m.role === 'user');
      const answer = { ok: true, echo: last ? last.content : '' };
      const raw = JSON.stringify(answer);
      const words = (s) => s.split(/\s+/).filter(Boolean).length;
      const usage = { input_tokens: words(system) + messages.reduce((n, m) => n + words(m.content), 0), output_tokens: words(raw) };
      return {
        parsed: responseSchema ? responseSchema.parse(answer) : null,
        raw_text: raw,
        usage,
        latency_ms: 0,
        cost_usd: 0,
        provider: name,
        model: model.id,
        attempts: 1,
        warnings: params.temperature !== undefined && model.unsupported_params.includes('temperature')
          ? [{ code: 'PARAM_UNSUPPORTED', message: 'temperature dropped' }]
          : [],
      };
    },
  };
}

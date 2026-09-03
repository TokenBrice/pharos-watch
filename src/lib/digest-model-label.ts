const DIGEST_MODEL_LABELS = {
  "claude-opus-5": "Claude Opus 5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-fable-5": "Claude Fable 5",
} as const;

/**
 * Resolve the model credit from the model id persisted with a digest edition.
 * Unknown ids stay deliberately generic rather than being guessed from a
 * current runtime configuration or a model-name prefix.
 */
export function getDigestModelLabel(servedModel: string | null | undefined): string {
  if (servedModel === null || servedModel === undefined || servedModel === "") {
    return "Model not recorded";
  }
  return DIGEST_MODEL_LABELS[servedModel as keyof typeof DIGEST_MODEL_LABELS] ?? "Anthropic model";
}


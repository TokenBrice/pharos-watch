export function boundedJson(value: unknown, maxLength: number, fallback?: string): string | null {
  if (value == null) return null;
  try {
    const json = JSON.stringify(value);
    if (!json) return null;
    if (json.length <= maxLength) return json;
    return JSON.stringify({
      truncated: true,
      preview: json.slice(0, maxLength),
      originalLength: json.length,
    });
  } catch {
    return fallback ?? JSON.stringify({ unserializable: true });
  }
}

export function parseObjectMetadata(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return { raw: raw.slice(0, 1_000) };
  }
}

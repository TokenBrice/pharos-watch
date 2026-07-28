type JsonLdNode = Record<string, unknown>;

function isJsonLdNode(value: unknown): value is JsonLdNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractJsonLd(html: string): JsonLdNode[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .filter((json): json is string => Boolean(json))
    .flatMap((json) => {
      const parsed: unknown = JSON.parse(json);
      return Array.isArray(parsed) ? parsed : [parsed];
    })
    .filter(isJsonLdNode);
}

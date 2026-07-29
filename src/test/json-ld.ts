export type JsonLdNode = Record<string, unknown>;

export function isJsonLdNode(value: unknown): value is JsonLdNode {
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

export function findJsonLdNode(
  nodes: JsonLdNode[],
  predicate: (node: JsonLdNode) => boolean,
  label: string,
): JsonLdNode {
  const node = nodes.find(predicate);
  if (!node) {
    throw new Error(`Expected JSON-LD node: ${label}`);
  }
  return node;
}

export function getJsonLdNodeArrayProperty(node: JsonLdNode, property: string): JsonLdNode[] {
  const value = node[property];
  if (!Array.isArray(value) || !value.every(isJsonLdNode)) {
    throw new Error(`Expected JSON-LD property ${property} to be an array of nodes`);
  }
  return value;
}

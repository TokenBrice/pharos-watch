export interface EditorialReferences {
  routes: ReadonlySet<string>;
  coinIds: ReadonlySet<string>;
  cemeteryIds: ReadonlySet<string>;
}

/** Validate explicit link/identity fields without transforming any authored prose. */
export function editorialReferenceIssues(input: unknown, references: EditorialReferences): string[] {
  const issues: string[] = [];
  function visit(value: unknown, path: string): void {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\]\((\/[^)\s]+)\)/g)) visit({ href: match[1] }, path);
      return;
    }
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}.${index}`)); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const field = `${path}.${key}`;
      if (key === "href" && typeof child === "string") {
        if (child.startsWith("/") && !child.startsWith("//")) {
          const url = new URL(child, "https://pharos.watch");
          const route = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
          if (!references.routes.has(route)) issues.push(`${field}: Unknown internal route ${child}`);
        } else if (!/^https?:\/\//.test(child)) issues.push(`${field}: Invalid link ${child}`);
      } else if ((key === "coinId" || key === "primaryCoinId") && typeof child === "string") {
        if (!references.coinIds.has(child)) issues.push(`${field}: Unknown coin id ${child}`);
      } else if (key === "relatedCoinIds" && Array.isArray(child)) {
        for (const id of child) if (typeof id !== "string" || !references.coinIds.has(id)) issues.push(`${field}: Unknown coin id ${String(id)}`);
      } else if (key === "cemeteryId" && typeof child === "string") {
        if (!references.cemeteryIds.has(child)) issues.push(`${field}: Unknown cemetery id ${child}`);
      } else visit(child, field);
    }
  }
  visit(input, "content");
  return issues;
}

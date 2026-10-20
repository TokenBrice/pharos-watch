/** Immutable materializations always begin with publicationHealth. Remove only the
 * optional root metadata for old strict clients, preserving all other JSON bytes.
 * Buffer a root key, never a card, source table, or the complete publication. */
export function legacyV9FreshnessBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let mode: "copy" | "key" | "omit" = "copy";
  let pending = "";
  let key = "";
  let keyStarted = false;
  let valueStarted = false;
  const project = (text: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const parts: string[] = [];
    let start = mode === "copy" ? 0 : -1;
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!;
      if (mode === "key") {
        pending += char;
        if (!keyStarted) {
          if (char === '"') { keyStarted = true; key = '"'; }
          continue;
        }
        key += char;
        if (escaped) { escaped = false; continue; }
        if (char === "\\") { escaped = true; continue; }
        if (char !== '"') continue;
        if (JSON.parse(key) === "pillarFreshness") {
          mode = "omit";
          valueStarted = false;
        } else {
          parts.push(pending);
          mode = "copy";
          start = index + 1;
        }
        pending = "";
        continue;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') { quoted = true; continue; }
      if (char === "{" || char === "[") {
        depth++;
        if (mode === "omit") valueStarted = true;
      } else if (char === "}" || char === "]") {
        depth--;
        if (mode === "omit" && valueStarted && depth === 1) {
          mode = "copy";
          start = index + 1;
        }
      } else if (char === "," && depth === 1 && mode === "copy") {
        parts.push(text.slice(start, index));
        mode = "key";
        pending = ",";
        keyStarted = false;
        start = -1;
      }
    }
    if (start !== -1) parts.push(text.slice(start));
    if (parts.length) controller.enqueue(encoder.encode(parts.join("")));
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { project(decoder.decode(chunk, { stream: true }), controller); },
    flush(controller) {
      project(decoder.decode(), controller);
      if (depth !== 0 || quoted || mode !== "copy") throw new Error("Incomplete V9 freshness projection");
    },
  }));
}

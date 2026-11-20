export function readV9WireOptions(url?: URL) {
  return {
    operands: url?.searchParams.get("freshness") === "operands",
    reserveAdmission: url?.searchParams.get("reserveAdmission") === "diagnostics",
  };
}

/** Filter optional object fields from immutable JSON. In canonical bytes these
 * fields follow another property, so the preceding comma goes with the field. */
export function projectV9WireBody(
  body: ReadableStream<Uint8Array>,
  { operands, reserveAdmission }: ReturnType<typeof readV9WireOptions>,
): ReadableStream<Uint8Array> {
  if (operands && reserveAdmission) return body;
  const cardDepth = 3; // Both full and detail projections use cards[].
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const objectAtDepth: boolean[] = [];
  let depth = 0;
  let rootKey: string | undefined;
  let inCards = false;
  let quoted = false;
  let escaped = false;
  let mode: "copy" | "key" | "omit" = "copy";
  let pending = "";
  let key = "";
  let keyStarted = false;
  let valueStarted = false;
  let omittedAtDepth = 0;
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
        const name = JSON.parse(key) as string;
        if (depth === 1) rootKey = name;
        if ((!operands && depth === 1 && pending.startsWith(",") && name === "pillarFreshness") ||
            (!reserveAdmission && inCards && depth === cardDepth && name === "reserveCompositionAdmission")) {
          mode = "omit";
          valueStarted = false;
          omittedAtDepth = depth;
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
      if (char === '"') {
        if (!reserveAdmission && depth === 1 && rootKey === undefined) {
          parts.push(text.slice(start, index));
          mode = "key";
          pending = key = '"';
          keyStarted = true;
          start = -1;
        } else {
          quoted = true;
        }
        continue;
      }
      if (char === "{" || char === "[") {
        depth++;
        objectAtDepth[depth] = char === "{";
        if (depth === 2) inCards = char === "[" && rootKey === "cards";
        if (mode === "omit") valueStarted = true;
      } else if (char === "}" || char === "]") {
        depth--;
        if (mode === "omit" && valueStarted && depth === omittedAtDepth) {
          mode = "copy";
          start = index + 1;
        }
      } else if (char === "," && mode === "copy" && objectAtDepth[depth] &&
          (depth === 1 || (!reserveAdmission && inCards && depth === cardDepth))) {
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
      if (depth !== 0 || quoted || mode !== "copy") throw new Error("Incomplete V9 wire projection");
    },
  }));
}

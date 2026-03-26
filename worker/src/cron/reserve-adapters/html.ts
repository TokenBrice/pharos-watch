export function htmlLayoutChangedError(adapterName: string, detail: string): Error {
  return new Error(`${adapterName}: layout-changed: ${detail}`);
}

export function htmlParseError(adapterName: string, detail: string): Error {
  return new Error(`${adapterName}: parse-failed: ${detail}`);
}

function decodeEscapedJsonFragment(fragment: string): string {
  return fragment
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, "\"");
}

export function extractEscapedJsonValueAfterKey(
  html: string,
  key: string,
  adapterName: string,
): string {
  const keyIndex = html.indexOf(key);
  if (keyIndex < 0) {
    throw htmlLayoutChangedError(adapterName, `missing ${key}`);
  }

  const valueStart = keyIndex + key.length;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let index = valueStart; index < html.length; index += 1) {
    const char = html[index];
    if (start === -1) {
      if (char === "{" || char === "[") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return decodeEscapedJsonFragment(html.slice(start, index + 1));
      }
    }
  }

  throw htmlParseError(adapterName, `unterminated ${key}`);
}

export function extractEscapedJsonArrayBetween(
  html: string,
  startNeedle: string,
  endNeedle: string,
  adapterName: string,
): string {
  const start = html.indexOf(startNeedle);
  if (start === -1) {
    throw htmlLayoutChangedError(adapterName, `missing ${startNeedle}`);
  }

  const contentStart = start + startNeedle.length;
  const end = html.indexOf(endNeedle, contentStart);
  if (end === -1) {
    throw htmlLayoutChangedError(adapterName, `missing ${endNeedle}`);
  }

  return decodeEscapedJsonFragment(`${html.slice(contentStart, end)}]`);
}

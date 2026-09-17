export function stripTomlComment(line) {
  let quote = null;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && character === "\\") {
        escaped = true;
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") return line.slice(0, index);
  }

  return line;
}

export function countBracketDelta(value) {
  let delta = 0;
  let quote = null;
  let escaped = false;

  for (const character of value) {
    if (quote !== null) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && character === "\\") {
        escaped = true;
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[" || character === "{") delta += 1;
    if (character === "]" || character === "}") delta -= 1;
  }

  return delta;
}

export function parseAssignments(toml) {
  const assignments = [];
  const lines = toml.split(/\r?\n/);
  let section = "root";

  for (let index = 0; index < lines.length; index += 1) {
    const uncommented = stripTomlComment(lines[index]);
    const trimmed = uncommented.trim();
    const arrayTable = trimmed.startsWith("[[");
    const tableStart = arrayTable ? 2 : trimmed.startsWith("[") ? 1 : 0;
    const tableTerminator = arrayTable ? "]]" : "]";
    const tableEnd = tableStart > 0 ? trimmed.indexOf(tableTerminator, tableStart) : -1;
    const trailingTableText = tableEnd >= 0 ? trimmed.slice(tableEnd + tableTerminator.length).trim() : "";
    if (tableEnd >= 0 && (!trailingTableText || trailingTableText.startsWith("#"))) {
      section = trimmed.slice(tableStart, tableEnd).trim();
      continue;
    }

    const assignmentMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!assignmentMatch) continue;

    const [, key] = assignmentMatch;
    let value = stripTomlComment(assignmentMatch[2]).trim();
    let bracketDepth = countBracketDelta(value);
    while (bracketDepth > 0 && index + 1 < lines.length) {
      index += 1;
      const nextLine = stripTomlComment(lines[index]);
      value += `\n${nextLine.trim()}`;
      bracketDepth += countBracketDelta(nextLine);
    }
    assignments.push({ key, section, value });
  }

  return assignments;
}

export function unquote(value) {
  const trimmed = value?.trim();
  if (!trimmed || (trimmed[0] !== '"' && trimmed[0] !== "'")) return undefined;
  const quote = trimmed[0];
  let parsed = "";
  let escaped = false;
  for (let index = 1; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (quote === '"' && escaped) {
      parsed += character;
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) return parsed;
    parsed += character;
  }
  return undefined;
}

export function assignmentKey(section, key) {
  return `${section}\0${key}`;
}

export function buildAssignmentMap(assignments) {
  const map = new Map();
  for (const assignment of assignments) {
    map.set(assignmentKey(assignment.section, assignment.key), assignment.value.trim());
  }
  return map;
}

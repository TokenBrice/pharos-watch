export interface ParsedDimensionDetail {
  label: string;
  desc: string;
  subScore: number;
  isNegative: boolean;
  displayScore: string;
}

export function parseDimensionDetail(part: string): ParsedDimensionDetail | null {
  const match = part.match(/^(.+?):\s*(.+?)\s*\((-?\d+)\)$/);
  if (!match) return null;

  const [, label, desc, scoreStr] = match;
  const subScore = parseInt(scoreStr, 10);
  const isNegative = subScore < 0;
  const displayScore = isNegative ? String(subScore) : subScore === 0 ? "—" : `+${subScore}`;

  return { label, desc, subScore, isNegative, displayScore };
}

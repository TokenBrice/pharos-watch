export interface WranglerTomlAssignment {
  key: string;
  section: string;
  value: string;
}

export function stripTomlComment(line: string): string;
export function countBracketDelta(value: string): number;
export function parseAssignments(toml: string): WranglerTomlAssignment[];
export function unquote(value: string | null | undefined): string | undefined;
export function assignmentKey(section: string, key: string): string;
export function buildAssignmentMap(assignments: readonly WranglerTomlAssignment[]): Map<string, string>;

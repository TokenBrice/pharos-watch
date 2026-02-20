import type { BluechipGrade } from "./types";

export const BLUECHIP_REPORT_BASE = "https://bluechip.org/en/coins";

// Higher = better, used for sort ordering
export const GRADE_ORDER: Record<BluechipGrade, number> = {
  "A+": 12, A: 11, "A-": 10,
  "B+": 9,  B: 8,  "B-": 7,
  "C+": 6,  C: 5,  "C-": 4,
  D: 3,     F: 1,
};

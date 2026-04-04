import type { ChangelogEntry } from "./types";

import { entry as e20260324 } from "./2026-03-24";

const all: ChangelogEntry[] = [e20260324];

export const changelogs: ChangelogEntry[] = all.sort(
  (a, b) => b.dateRange.to.localeCompare(a.dateRange.to),
);

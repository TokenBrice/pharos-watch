import type { ChangelogEntry } from "./types";

import { entry as e20260308 } from "./2026-03-08";
import { entry as e20260316 } from "./2026-03-16";
import { entry as e20260324 } from "./2026-03-24";
import { entry as e20260404 } from "./2026-04-04";
import { entry as e20260412 } from "./2026-04-12";
import { entry as e20260419 } from "./2026-04-19";
import { entry as e20260426 } from "./2026-04-26";
import { entry as e20260503 } from "./2026-05-03";
import { entry as e20260510 } from "./2026-05-10";
import { entry as e20260517 } from "./2026-05-17";

const all: ChangelogEntry[] = [
  e20260308,
  e20260316,
  e20260324,
  e20260404,
  e20260412,
  e20260419,
  e20260426,
  e20260503,
  e20260510,
  e20260517,
];

export const changelogs: ChangelogEntry[] = all.sort(
  (a, b) => b.dateRange.to.localeCompare(a.dateRange.to),
);

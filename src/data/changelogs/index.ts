import type { ChangelogEntry } from "./types";

import e20260301 from "./2026-03-01.json";
import e20260308 from "./2026-03-08.json";
import e20260315 from "./2026-03-15.json";
import e20260322 from "./2026-03-22.json";
import e20260329 from "./2026-03-29.json";
import e20260405 from "./2026-04-05.json";
import e20260412 from "./2026-04-12.json";
import e20260419 from "./2026-04-19.json";
import e20260426 from "./2026-04-26.json";
import e20260503 from "./2026-05-03.json";
import e20260510 from "./2026-05-10.json";
import e20260517 from "./2026-05-17.json";
import e20260524 from "./2026-05-24.json";
import e20260531 from "./2026-05-31.json";
import e20260607 from "./2026-06-07.json";
import e20260614 from "./2026-06-14.json";
import e20260621 from "./2026-06-21.json";
import e20260628 from "./2026-06-28.json";
import e20260705 from "./2026-07-05.json";
import e20260712 from "./2026-07-12.json";
import e20260719 from "./2026-07-19.json";
import e20260726 from "./2026-07-26.json";
import e20260802 from "./2026-08-02.json";
import e20260809 from "./2026-08-09.json";
import e20260816 from "./2026-08-16.json";
import e20260823 from "./2026-08-23.json";
import e20260830 from "./2026-08-30.json";
import e20260906 from "./2026-09-06.json";
import e20260913 from "./2026-09-13.json";
import e20260920 from "./2026-09-20.json";
import e20260927 from "./2026-09-27.json";
import e20261004 from "./2026-10-04.json";
import e20261011 from "./2026-10-11.json";

const all = [
  e20260301,
  e20260308,
  e20260315,
  e20260322,
  e20260329,
  e20260405,
  e20260412,
  e20260419,
  e20260426,
  e20260503,
  e20260510,
  e20260517,
  e20260524,
  e20260531,
  e20260607,
  e20260614,
  e20260621,
  e20260628,
  e20260705,
  e20260712,
  e20260719,
  e20260726,
  e20260802,
  e20260809,
  e20260816,
  e20260823,
  e20260830,
  e20260906,
  e20260913,
  e20260920,
  e20260927,
  e20261004,
  e20261011,
] as ChangelogEntry[];

export const changelogs: ChangelogEntry[] = all.sort(
  (a, b) => b.dateRange.to.localeCompare(a.dateRange.to),
);

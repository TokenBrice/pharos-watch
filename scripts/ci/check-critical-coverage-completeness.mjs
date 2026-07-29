#!/usr/bin/env node

import { runCriticalCoverageCompletenessGuard } from "./check-critical-coverage.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCriticalCoverageCompletenessGuard();
}

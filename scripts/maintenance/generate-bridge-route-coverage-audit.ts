#!/usr/bin/env tsx

import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { buildBridgeRouteCoverageAudit } from "../lib/bridge-route-coverage-audit";

const generatedAtArg = process.argv.indexOf("--generated-at");
const generatedAt = generatedAtArg >= 0 ? process.argv[generatedAtArg + 1] : undefined;
if (generatedAtArg >= 0 && !generatedAt) throw new Error("--generated-at requires an ISO timestamp");

const audit = buildBridgeRouteCoverageAudit(TRACKED_STABLECOINS, generatedAt);
process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);

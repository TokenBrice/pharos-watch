#!/usr/bin/env node
import { runRuntimeReachabilityCli } from "./check-runtime-reachability";
void runRuntimeReachabilityCli([...process.argv.slice(0, 0), "--policy", "mint-burn"]);

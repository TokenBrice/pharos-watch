#!/usr/bin/env node

import { execSync } from "node:child_process";

const cmd = "npx --yes madge --circular --extensions ts,tsx --ts-config tsconfig.json shared";

try {
  execSync(cmd, { stdio: "inherit" });
} catch (error) {
  process.exit(error?.status ?? 1);
}

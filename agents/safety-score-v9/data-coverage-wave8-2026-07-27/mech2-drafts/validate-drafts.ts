import { readFileSync } from "node:fs";
import { MechanismReviewOverlaySchema } from "../../../../worker/src/lib/safety-score-v9-extension-mechanism.ts";

const files = ["iauon-ondo.json", "reusd-re-protocol.json"];
let failed = false;
for (const f of files) {
  const packet = JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
  const result = MechanismReviewOverlaySchema.safeParse(packet.overlayEntry);
  if (result.success) {
    console.log(`${f}: VALID`);
  } else {
    failed = true;
    console.log(`${f}: INVALID`);
    for (const issue of result.error.issues) {
      console.log(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
  }
  // also check journal JSON parses (already parsed as part of packet) and required packet keys
  const required = ["assetId","archetype","outcome","mergeMode","overlayEntry","journal","evidenceSummary","primarySources","blockedReason","missingSources"];
  const missing = required.filter((k) => !(k in packet));
  if (missing.length) { failed = true; console.log(`${f}: missing packet keys: ${missing.join(",")}`); }
}
process.exit(failed ? 1 : 0);

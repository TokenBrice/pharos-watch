#!/usr/bin/env python3
"""Apply one batch of staged entries to mechanism-review-overlays-v1.json.

replace: swap the existing overlays[] element in place (same index).
insert: insert immediately AFTER the last existing overlay of the same archetype.
Dump: json.dumps(data, indent=2, ensure_ascii=False) + "\n" (byte-round-trip format).
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(ROOT, "..", "..", "..", ".."))
OVERLAY_FILE = os.path.join(REPO, "shared/data/safety-score-v9/mechanism-review-overlays-v1.json")


def main(batch_no):
    staged = json.load(open(os.path.join(ROOT, "staging", "entries.json")))
    aids = staged["batches"][batch_no - 1]
    data = json.load(open(OVERLAY_FILE))
    overlays = data["overlays"]
    for aid in aids:
        rec = staged["entries"][aid]
        entry = rec["entry"]
        if rec["mode"] == "replace":
            idx = next((i for i, o in enumerate(overlays) if o["assetId"] == aid), None)
            if idx is None:
                raise SystemExit(f"replace target {aid} not found")
            overlays[idx] = entry
            print(f"replaced {aid} at index {idx}")
        else:
            if any(o["assetId"] == aid for o in overlays):
                raise SystemExit(f"insert target {aid} already exists")
            last = max(i for i, o in enumerate(overlays) if o["archetype"] == entry["archetype"])
            overlays.insert(last + 1, entry)
            print(f"inserted {aid} at index {last + 1} (after last {entry['archetype']})")
    ids = [o["assetId"] for o in overlays]
    assert len(ids) == len(set(ids)), "duplicate assetId"
    with open(OVERLAY_FILE, "w") as f:
        f.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print(f"batch {batch_no}: {len(aids)} entries applied; overlays now {len(overlays)}")


if __name__ == "__main__":
    main(int(sys.argv[1]))

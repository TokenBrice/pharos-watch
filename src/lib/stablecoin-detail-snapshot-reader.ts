import { readFileSync } from "node:fs";
import type { StablecoinDetailSnapshot } from "@/lib/api";

type DetailSnapshotRead =
  | { status: "available"; snapshot: StablecoinDetailSnapshot }
  | { status: "missing" | "malformed" | "unreadable"; snapshot: null };

export function readDetailSnapshot(file: string): DetailSnapshotRead {
  try {
    return { status: "available", snapshot: JSON.parse(readFileSync(file, "utf8")) as StablecoinDetailSnapshot };
  } catch (error) {
    const status = error instanceof Error && "code" in error && error.code === "ENOENT"
      ? "missing"
      : error instanceof SyntaxError ? "malformed" : "unreadable";
    console.warn(`[stablecoin-detail-snapshot] ${status}: ${file}; rendering without snapshot`);
    return { status, snapshot: null };
  }
}

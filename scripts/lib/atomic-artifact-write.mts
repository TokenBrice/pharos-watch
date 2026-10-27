import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Publish a complete file: write an exclusive sibling temporary, then rename it
 * over the destination so readers observe either the old or the new bytes,
 * never a truncated file. The destination is never unlinked first, and only the
 * temporary created here is cleaned up on failure (the original error is kept).
 */
export function atomicWriteFileSync(destination: string, content: string | Uint8Array): void {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // flag "wx" fails if the name exists, so we only ever own what we created.
    writeFileSync(temporary, content, typeof content === "string" ? { encoding: "utf8", flag: "wx" } : { flag: "wx" });
    renameSync(temporary, destination);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* keep the original error */ }
    throw error;
  }
}

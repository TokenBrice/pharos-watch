import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeStoredZip } from "../gsc-zip";

it("writes each payload's standard CRC32 in both ZIP directories", () => {
  const root = mkdtempSync(join(tmpdir(), "gsc-crc-"));
  try {
    const path = join(root, "export.zip");
    writeStoredZip(path, { "a.txt": "123456789", "b.txt": "hello", "empty.txt": "" });
    const zip = readFileSync(path);
    // Published CRC32 check vector, distinct payload, and empty-stream boundary.
    const entries = [
      { name: "a.txt", payload: "123456789", crc: 0xcbf43926 },
      { name: "b.txt", payload: "hello", crc: 0x3610a686 },
      { name: "empty.txt", payload: "", crc: 0 },
    ];
    let local = 0;
    let central = zip.readUInt32LE(zip.length - 6);
    for (const { name, payload, crc } of entries) {
      expect(zip.readUInt32LE(local)).toBe(0x04034b50);
      expect(zip.readUInt32LE(local + 14)).toBe(crc);
      const nameLength = zip.readUInt16LE(local + 26);
      expect(zip.subarray(local + 30, local + 30 + nameLength).toString()).toBe(name);
      expect(zip.subarray(local + 30 + nameLength, local + 30 + nameLength + payload.length).toString()).toBe(payload);
      expect(zip.readUInt32LE(central)).toBe(0x02014b50);
      expect(zip.readUInt32LE(central + 16)).toBe(crc);
      expect(zip.readUInt32LE(central + 42)).toBe(local);
      central += 46 + nameLength;
      local += 30 + nameLength + payload.length;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

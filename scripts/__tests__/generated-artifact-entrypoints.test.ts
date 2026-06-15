import { describe, expect, it } from "vitest";

describe("generated artifact scripts", () => {
  it("can import dataset generators without running their file-writing entrypoints", async () => {
    await expect(import("../maintenance/generate-cemetery-dataset")).resolves.toBeDefined();
    await expect(import("../maintenance/generate-postman-collection")).resolves.toBeDefined();
  });
});

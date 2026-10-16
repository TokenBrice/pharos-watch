import { describe, expect, it } from "vitest";
import {
  FeedbackWireFieldsSchema,
} from "@shared/types/feedback";
import { FeedbackBodySchema } from "../feedback/types";

const BROWSER_PAYLOAD = {
  type: "data-correction",
  description: "The current reserve source is stale on the stablecoin detail page.",
  expectedValue: "The issuer report dated yesterday.",
  stablecoinId: "usdc-circle",
  stablecoinName: "USD Coin",
  pageUrl: "/stablecoin/usdc-circle?tab=overview#reserves",
  pegValue: "$1.0000",
  contactHandle: "@pharos_user",
  website: "",
};

describe("feedback wire contract", () => {
  it("keeps Worker-only guards narrower than the shared wire fields", () => {
    const workerOnlyRejections = [
      { title: "x".repeat(101) },
      { expectedValue: "x".repeat(501) },
      { stablecoinId: "x".repeat(101) },
      { stablecoinName: "x".repeat(101) },
      { pageUrl: "https://evil.example/feedback" },
      { pageUrl: `/${"x".repeat(300)}` },
      { pegValue: "x".repeat(101) },
      { contactHandle: "x".repeat(101) },
      { website: "x".repeat(301) },
      { acceptedTerms: false },
    ];

    for (const override of workerOnlyRejections) {
      expect(FeedbackWireFieldsSchema.safeParse({ ...BROWSER_PAYLOAD, ...override }).success).toBe(true);
      expect(FeedbackBodySchema.safeParse({ ...BROWSER_PAYLOAD, ...override }).success).toBe(false);
    }

    const sharedRejections = [
      { type: "spam" },
      { description: "short" },
      { description: "x".repeat(2001) },
    ];

    for (const override of sharedRejections) {
      expect(FeedbackWireFieldsSchema.safeParse({ ...BROWSER_PAYLOAD, ...override }).success).toBe(false);
      expect(FeedbackBodySchema.safeParse({ ...BROWSER_PAYLOAD, ...override }).success).toBe(false);
    }
  });

});

// @vitest-environment jsdom

import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiReferencePanel } from "./api-reference-panel";

// Scrollspy behavior is independent of the server-rendered auth guidance.
vi.mock("@/components/api-reference-layout", () => ({
  ApiReferenceLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe("API reference authentication guidance", () => {
  it("links the FAQ to canonical auth instead of repeating an exemption roster", async () => {
    render(await ApiReferencePanel());
    const question = screen.getByText("Do I need an API key for every endpoint?").closest("details")!;
    const link = within(question).getByText("Public API Auth").closest("a");
    expect(link?.getAttribute("href")).toBe("/api/reference#public-api-auth");
    const auth = document.getElementById("public-api-auth")!;
    expect(auth).not.toBeNull();
    expect(within(auth).getByText("GET /api/dependency-graph/v1")).toBeTruthy();
    expect(within(auth).getByText("GET /api/dependency-scenarios/v1")).toBeTruthy();
    expect(question.querySelector("ul, ol")).toBeNull();
    expect(within(question).queryByText(/safety-grades|telegram-webhook|dependency-graph/)).toBeNull();
    const facts = screen.getByText("Quick facts").parentElement!;
    expect(within(facts).queryByText(/no-key|exempt/i)).toBeNull();
    const faqScript = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .find((script) => script.textContent?.includes('"@type":"FAQPage"'));
    const faq = JSON.parse(faqScript!.textContent!) as {
      mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }>;
    };
    const structuredAnswer = faq.mainEntity.find((item) => item.name === question.querySelector("summary")?.textContent);
    expect(structuredAnswer?.acceptedAnswer.text).toBe(question.querySelector("p")?.textContent);
  });
});

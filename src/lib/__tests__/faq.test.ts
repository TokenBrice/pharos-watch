import { describe, expect, it } from "vitest";
import { buildFaqJsonLd } from "@/lib/faq";


describe("buildFaqJsonLd", () => {
  it.each([
    { answer: "Send an API key in the header.", text: "Send an API key in the header." },
    { answer: "See [Public API Auth](/api/reference/#public-api-auth).", text: "See Public API Auth." },
    { answer: "Use [Access](/api/) or [Reference](https://pharos.watch/api/reference/).", text: "Use Access or Reference." },
    { answer: "Keep [bracketed] labels and https://pharos.watch/api/.", text: "Keep [bracketed] labels and https://pharos.watch/api/." },
  ])("projects inline links to readable answer text: $answer", ({ answer, text }) => {
    const schema = buildFaqJsonLd([{ question: "How do I use the API?", answer }]);

    expect(schema.mainEntity).toEqual([{
      "@type": "Question",
      name: "How do I use the API?",
      acceptedAnswer: { "@type": "Answer", text },
    }]);
  });
});

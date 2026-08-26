export interface StablecoinAiSummary {
  title: string;
  text: string;
  updatedAt: string;
  authoredBy?: "ai" | "human";
  model?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  factsAsOf?: string;
  sources?: Array<{
    label: string;
    url: `http${string}`;
  }>;
}

export type StablecoinAiSummariesById = Record<string, StablecoinAiSummary>;

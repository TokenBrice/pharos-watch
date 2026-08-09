export type DigestEditionType = "daily" | "weekly";

export interface DigestContentEntry {
  date: string;
  title: string;
  text: string;
  extended: string;
  generatedAt: number;
  digestType?: DigestEditionType;
  editionNumber?: number;
}

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

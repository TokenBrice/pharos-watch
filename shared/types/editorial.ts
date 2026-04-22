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
}

export type StablecoinAiSummariesById = Record<string, StablecoinAiSummary>;

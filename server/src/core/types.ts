export type Endpoint = {
  tag: string;
  provider: string;
  providerName: string;
  quantization: string;
  pIn: number;
  pOut: number;
  pCache: number;
  cacheKnown: boolean;
  uptime: number;
  uptime30m: number | null;
  tps: number | null;
  latencyMs: number | null;
  tools: boolean;
  zdr: boolean;
};

export type ModelInput = {
  slug: string;
  name: string;
  usageUsd: number;
  h: number;
  r: number;
  source: "usage" | "watchlist";
  openWeights?: boolean;
  inputTokens: number;
  endpoints: Endpoint[];
};

export type Snapshot = {
  takenAt: string;
  models: ModelInput[];
  skipped: string[];
};

export type Issue = { level: "bad" | "warn"; text: string };

export type EndpointClass = "ok" | "outlier" | "hard-bad";

export type ClassifiedEndpoint = Endpoint & {
  cls: EndpointClass;
  quant: "ok" | "low" | "unknown" | "closed";
  reasons: string[];
  issues: Issue[];
  cEff: number;
  score: number;
  weight: number;
};

export type ClassifiedModel = Omit<ModelInput, "endpoints"> & { endpoints: ClassifiedEndpoint[] };

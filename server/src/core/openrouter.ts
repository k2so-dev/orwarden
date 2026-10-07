export type RawPricing = {
  prompt?: string | null;
  completion?: string | null;
  input_cache_read?: string | null;
  discount?: number;
};

export type RawEndpoint = {
  name?: string;
  model_name?: string;
  tag: string;
  provider_name?: string;
  model_id?: string;
  quantization?: string | null;
  pricing: RawPricing;
  uptime_last_1d?: number | null;
  uptime_last_30m?: number | null;
  throughput_last_30m?: { p50?: number | null } | null;
  latency_last_30m?: { p50?: number | null } | null;
  status?: number;
  supported_parameters?: string[];
};

export type ActivityRow = {
  date: string;
  model: string;
  model_permaslug?: string;
  provider_name?: string;
  usage: number;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens?: number;
  cached_tokens: number;
};

export type Guardrail = {
  id: string;
  name: string;
  workspace_id?: string;
  ignored_providers: string[] | null;
  enforce_zdr?: boolean | null;
  enforce_zdr_anthropic?: boolean | null;
  enforce_zdr_openai?: boolean | null;
  enforce_zdr_google?: boolean | null;
  enforce_zdr_xai?: boolean | null;
  enforce_zdr_other?: boolean | null;
  [key: string]: unknown;
};

export type Workspace = { id: string; default_guardrail_id: string; name?: string };

export type KeyInfo = {
  label?: string;
  is_management_key?: boolean;
  workspace_id: string | null;
  expires_at?: string | null;
};

export type CatalogModel = {
  id: string;
  name: string;
  context_length?: number | null;
  hugging_face_id?: string | null;
  pricing?: RawPricing;
};

export type PresetConfig = Record<string, unknown>;

export type Preset = {
  id: string;
  slug: string;
  name: string;
  status?: string;
  updated_at?: string;
  designated_version?: { version?: number; config?: PresetConfig; updated_at?: string } | null;
};

export interface OpenRouterApi {
  getKey(): Promise<KeyInfo>;
  listWorkspaces(): Promise<Workspace[]>;
  getGuardrail(id: string): Promise<Guardrail>;
  patchGuardrail(id: string, body: { ignored_providers: string[] }): Promise<Guardrail>;
  getActivity(): Promise<ActivityRow[]>;
  getEndpoints(slug: string): Promise<RawEndpoint[] | null>;
  getZdrEndpoints(): Promise<RawEndpoint[]>;
  listModels(): Promise<CatalogModel[]>;
  getPreset(slug: string): Promise<Preset | null>;
  upsertPreset(slug: string, config: PresetConfig): Promise<Preset>;
}

export class HttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    body: string,
  ) {
    super(`${method} ${path} -> ${status}: ${body.slice(0, 300)}`);
  }
}

type ClientOptions = {
  baseUrl: string;
  key: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
};

export function createClient(opts: ClientOptions): OpenRouterApi {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? 2;

  async function request<T>(method: string, path: string, body?: unknown, allow404 = false): Promise<T | null> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await Bun.sleep(1000 * 2 ** (attempt - 1));
      try {
        const res = await doFetch(`${opts.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${opts.key}`,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 404 && allow404) return null;
        if (res.ok) return (await res.json()) as T;
        const err = new HttpError(method, path, res.status, await res.text());
        if (res.status !== 429 && res.status < 500) throw err;
        lastError = err;
      } catch (err) {
        if (err instanceof HttpError && err.status !== 429 && err.status < 500) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  const get = async <T>(path: string) => (await request<{ data: T }>("GET", path))!.data;

  return {
    getKey: () => get("/key"),
    listWorkspaces: () => get("/workspaces"),
    getGuardrail: (id) => get(`/guardrails/${encodeURIComponent(id)}`),
    patchGuardrail: async (id, body) =>
      (await request<{ data: Guardrail }>("PATCH", `/guardrails/${encodeURIComponent(id)}`, body))!.data,
    getActivity: () => get("/activity"),
    getEndpoints: async (slug) => {
      const res = await request<{ data: { endpoints: RawEndpoint[] } }>("GET", `/models/${slug}/endpoints`, undefined, true);
      return res ? res.data.endpoints : null;
    },
    getZdrEndpoints: () => get("/endpoints/zdr"),
    listModels: () => get("/models"),
    getPreset: async (slug) => {
      const res = await request<{ data: Preset }>("GET", `/presets/${encodeURIComponent(slug)}`, undefined, true);
      return res ? res.data : null;
    },
    upsertPreset: async (slug, config) =>
      (
        await request<{ data: Preset }>("POST", `/presets/${encodeURIComponent(slug)}/chat/completions`, {
          ...config,
          messages: [{ role: "user", content: "preset" }],
        })
      )!.data,
  };
}

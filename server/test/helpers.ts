import { classifyModel } from "../src/core/classify.ts";
import { normalizeEndpoint } from "../src/core/collect.ts";
import { DEFAULT_SETTINGS, mergeSettings, type Config } from "../src/settings.ts";
import type { ActivityRow, Guardrail, OpenRouterApi, Preset, RawEndpoint } from "../src/core/openrouter.ts";
import type { ClassifiedModel, Endpoint } from "../src/core/types.ts";
import fixture from "./fixtures/deepseek-v4.1-flash.json";

export const DEEPSEEK = fixture.model;

export function testConfig(raw: Record<string, any> = {}): Config {
  return mergeSettings(DEFAULT_SETTINGS, raw);
}

export function deepseekEndpoints(zdrOnly = true): RawEndpoint[] {
  const zdr = new Set(fixture.zdrTags);
  return (fixture.endpoints as RawEndpoint[]).filter((e) => !zdrOnly || zdr.has(e.tag));
}

export function deepseekModel(config: Config, usageUsd = 10, h = 0.8, r = 0.05): ClassifiedModel {
  return classifyModel(
    { slug: DEEPSEEK, name: "DeepSeek V4.1 Flash", usageUsd, inputTokens: 0, h, r, source: "usage", endpoints: deepseekEndpoints().map((e) => normalizeEndpoint(e)) },
    config,
  );
}

export function ep(tag: string, pIn: number, pOut: number, pCache: number, extra: Partial<Endpoint> = {}): Endpoint {
  return {
    tag,
    provider: tag.split("/")[0]!,
    providerName: tag.split("/")[0]!,
    quantization: "fp8",
    pIn,
    pOut,
    pCache,
    cacheKnown: true,
    uptime: 0.999,
    uptime30m: null,
    tps: 100,
    latencyMs: 500,
    tools: true,
    zdr: true,
    ...extra,
  };
}

export function model(
  config: Config,
  slug: string,
  usageUsd: number,
  endpoints: Endpoint[],
  h = 0.8,
  r = 0.05,
): ClassifiedModel {
  return classifyModel({ slug, name: slug, usageUsd, inputTokens: 0, h, r, source: "usage", endpoints }, config);
}

export function mockClient(opts: {
  ignored?: string[];
  activity?: ActivityRow[];
  endpoints?: Record<string, RawEndpoint[]>;
}) {
  const calls = { patches: [] as { id: string; body: unknown }[], presets: [] as { slug: string; config: unknown }[] };
  const presets = new Map<string, Preset>();
  const guardrail: Guardrail = {
    id: "g1",
    name: "Workspace w1 Default",
    workspace_id: "w1",
    ignored_providers: opts.ignored ?? [],
    allowed_data_regions: ["global"],
    enforce_zdr_other: true,
  };
  const endpoints = opts.endpoints ?? { [DEEPSEEK]: fixture.endpoints as RawEndpoint[] };
  const client: OpenRouterApi = {
    getKey: async () => ({ workspace_id: "w1", label: "test", is_management_key: true, expires_at: "2026-10-14T00:00:00Z" }),
    listWorkspaces: async () => [{ id: "w1", default_guardrail_id: "g1", name: "Test" }],
    getGuardrail: async () => structuredClone(guardrail),
    patchGuardrail: async (id, body) => {
      calls.patches.push({ id, body: structuredClone(body) });
      guardrail.ignored_providers = [...body.ignored_providers];
      return structuredClone(guardrail);
    },
    getActivity: async () =>
      opts.activity ?? [
        {
          date: "2026-10-06 00:00:00",
          model: DEEPSEEK,
          usage: 10,
          requests: 100,
          prompt_tokens: 1_000_000,
          completion_tokens: 50_000,
          cached_tokens: 800_000,
        },
      ],
    getEndpoints: async (slug) => endpoints[slug] ?? null,
    getZdrEndpoints: async () =>
      (fixture.endpoints as RawEndpoint[])
        .filter((e) => fixture.zdrTags.includes(e.tag))
        .map((e) => ({ ...e, model_id: DEEPSEEK })),
    listModels: async () => [{ id: DEEPSEEK, name: "DeepSeek V4.1 Flash", hugging_face_id: "deepseek-ai/DeepSeek-V4.1-Flash" }],
    getPreset: async (slug) => presets.get(slug) ?? null,
    upsertPreset: async (slug, config) => {
      calls.presets.push({ slug, config: structuredClone(config) });
      const preset = {
        id: slug,
        slug,
        name: slug,
        designated_version: { version: (presets.get(slug)?.designated_version?.version ?? 0) + 1, config: structuredClone(config) },
      };
      presets.set(slug, preset);
      return preset;
    },
  };
  return { client, guardrail, calls, presets };
}

export const NOW = () => new Date("2026-10-07T12:00:00Z");

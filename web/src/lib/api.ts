import type { AppType } from "@rerouter/server";
import { hc, type InferRequestType, type InferResponseType } from "hono/client";

export const client = hc<AppType>("/", { init: { credentials: "same-origin" } }).api;

export type ApiError = { error: string; message: string; details: unknown };

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message);
  }
}

export async function unwrap<T>(res: Promise<{ ok: boolean; status: number; json(): Promise<T> }>): Promise<T> {
  const r = await res;
  const body = await r.json();
  if (!r.ok) throw new RequestError(r.status, body as unknown as ApiError);
  return body;
}

export type Status = InferResponseType<typeof client.status.$get, 200>;
export type Overview = InferResponseType<typeof client.overview.$get, 200>;
export type ModelView = Overview["models"][number];
export type EndpointView = ModelView["endpoints"][number];
export type ProvidersView = InferResponseType<typeof client.providers.$get, 200>;
export type ProviderRow = ProvidersView["rows"][number];
export type PresetView = InferResponseType<typeof client.presets.$get, 200>[number];
export type Settings = InferResponseType<typeof client.settings.$get, 200>;
export type BanHistory = InferResponseType<typeof client.bans.history.$get, 200>;
export type ViewQuery = InferRequestType<typeof client.overview.$get>["query"];

import type { AppType } from "@orwarden/server";
import { hc, type ClientResponse, type InferRequestType, type InferResponseType } from "hono/client";

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

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502;
type Success<R> = R extends ClientResponse<infer T, infer S, any> ? (S extends ErrorStatus ? never : T) : never;

export async function unwrap<R extends ClientResponse<any, any, any>>(res: Promise<R>): Promise<Success<R>> {
  const r = await res;
  const body = await r.json();
  if (!r.ok) throw new RequestError(r.status, body as ApiError);
  return body as Success<R>;
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
export type CatalogItem = InferResponseType<typeof client.catalog.$get, 200>[number];
export type SyncResult = InferResponseType<(typeof client.presets.sync)["$post"], 200>[number];
export type ApplyResult = InferResponseType<(typeof client.bans.apply)["$post"], 200>;
export type HistoryItem = BanHistory[number];
export type TrendData = InferResponseType<typeof client.trend.$get, 200>;
export type ChangesView = InferResponseType<typeof client.changes.$get, 200>;
export type ChangeRow = ChangesView["changes"][number];
export type PresetSettingsPatch = InferRequestType<(typeof client.presets.settings)["$put"]>["json"];
export type ModelOverrides = NonNullable<PresetSettingsPatch["overrides"]>;

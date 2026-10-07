import { resolve } from "node:path";

export type Env = {
  port: number;
  password: string;
  dataDir: string;
  refreshCron: string;
  envKey: string | null;
  baseUrl: string;
  webDist: string;
  secureCookies: boolean;
};

export function readEnv(source: Record<string, string | undefined> = process.env): Env {
  const password = source.DASHBOARD_PASSWORD ?? "";
  if (password.length < 8) throw new Error("DASHBOARD_PASSWORD must be set (at least 8 characters)");
  return {
    port: Number(source.PORT ?? 3000),
    password,
    dataDir: resolve(source.DATA_DIR ?? "./data"),
    refreshCron: source.REFRESH_CRON || "0 * * * *",
    envKey: source.OPENROUTER_MANAGEMENT_KEY || null,
    baseUrl: source.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    webDist: resolve(source.WEB_DIST ?? new URL("../../web/dist", import.meta.url).pathname),
    secureCookies: source.SECURE_COOKIES === "true",
  };
}

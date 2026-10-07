import { createClient, type OpenRouterApi } from "../core/openrouter.ts";
import type { Store } from "../db.ts";
import type { Env } from "../env.ts";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../settings.ts";
import type { Vault } from "../vault.ts";
import type { AppSnapshot, BanInputs } from "./analysis.ts";

export class AppError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 502,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export type KeySource = "dashboard" | "env" | null;

export type RuntimeOptions = {
  env: Env;
  store: Store;
  vault: Vault;
  clientFactory?: (key: string) => OpenRouterApi;
  now?: () => Date;
};

const KEY_SECRET = "management_key";

export class Runtime {
  readonly env: Env;
  readonly store: Store;
  readonly vault: Vault;
  readonly now: () => Date;
  private readonly clientFactory: (key: string) => OpenRouterApi;
  private cachedSettings: Settings | null = null;
  private cachedSnapshot: AppSnapshot | null | undefined;
  private busy: Promise<unknown> | null = null;
  private cron: { stop(): void } | null = null;
  lastError: { at: string; message: string; status: number | null } | null = null;

  constructor(opts: RuntimeOptions) {
    this.env = opts.env;
    this.store = opts.store;
    this.vault = opts.vault;
    this.now = opts.now ?? (() => new Date());
    this.clientFactory = opts.clientFactory ?? ((key) => createClient({ baseUrl: opts.env.baseUrl, key }));
  }

  private baseSettings(): Settings {
    return mergeSettings(DEFAULT_SETTINGS, { refreshCron: this.env.refreshCron });
  }

  settings(): Settings {
    this.cachedSettings ??= mergeSettings(this.baseSettings(), this.store.getValue("settings") ?? {});
    return this.cachedSettings;
  }

  updateSettings(patch: unknown): Settings {
    const next = mergeSettings(this.settings(), patch);
    const cronChanged = next.refreshCron !== this.settings().refreshCron;
    this.store.setValue("settings", next);
    this.cachedSettings = next;
    if (cronChanged && this.cron) this.startScheduler(this.onTick!);
    return next;
  }

  resetSettings(): Settings {
    this.store.setValue("settings", {});
    this.cachedSettings = null;
    return this.settings();
  }

  async key(): Promise<{ key: string; source: Exclude<KeySource, null> } | null> {
    const sealed = this.store.getSecret(KEY_SECRET);
    if (sealed) {
      const key = await this.vault.decrypt(sealed);
      if (key) return { key, source: "dashboard" };
    }
    return this.env.envKey ? { key: this.env.envKey, source: "env" } : null;
  }

  async keySource(): Promise<KeySource> {
    return (await this.key())?.source ?? null;
  }

  async setKey(key: string): Promise<void> {
    const sealed = await this.vault.encrypt(key);
    this.store.setSecret(KEY_SECRET, sealed.iv, sealed.data);
  }

  deleteKey(): void {
    this.store.deleteSecret(KEY_SECRET);
  }

  clientFor(key: string): OpenRouterApi {
    return this.clientFactory(key);
  }

  async client(): Promise<OpenRouterApi> {
    const found = await this.key();
    if (!found) throw new AppError(409, "no-key", "Management key is not configured");
    return this.clientFactory(found.key);
  }

  snapshot(): AppSnapshot | null {
    if (this.cachedSnapshot === undefined) this.cachedSnapshot = this.store.latestSnapshot<AppSnapshot>();
    return this.cachedSnapshot;
  }

  requireSnapshot(): AppSnapshot {
    const s = this.snapshot();
    if (!s) throw new AppError(409, "no-data", "No data yet: run a refresh first");
    return s;
  }

  setSnapshot(snapshot: AppSnapshot): void {
    this.store.saveSnapshot(snapshot);
    this.cachedSnapshot = snapshot;
  }

  banInputs(): BanInputs {
    return { policies: this.store.policies(), states: this.store.loadStates() };
  }

  get isBusy(): boolean {
    return this.busy !== null;
  }

  async exclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.busy) throw new AppError(409, "busy", "Another operation is in progress");
    const p = task();
    this.busy = p;
    try {
      return await p;
    } finally {
      this.busy = null;
    }
  }

  private onTick: (() => Promise<void>) | null = null;

  startScheduler(tick: () => Promise<void>): void {
    this.cron?.stop();
    this.onTick = tick;
    this.cron = Bun.cron(this.settings().refreshCron, () => {
      if (this.busy) return;
      tick().catch((err) => console.error(`scheduled refresh failed: ${err instanceof Error ? err.message : err}`));
    }) as unknown as { stop(): void };
  }

  stopScheduler(): void {
    this.cron?.stop();
    this.cron = null;
  }
}

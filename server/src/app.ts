import { matchScore } from "./core/search.ts";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { LoginLimiter, clientIp, endSession, passwordMatches, requireSession, sessionExpiry, startSession, type AuthOptions } from "./auth.ts";
import { sendAlert } from "./core/alert.ts";
import { HttpError } from "./core/openrouter.ts";
import { buildOverview, buildProviders, spendFor } from "./services/analysis.ts";
import { applyBans, banHistory, discardDrafts, rollback } from "./services/bans.ts";
import { listPresets, syncPresets, updatePresetSettings } from "./services/presets.ts";
import { refresh } from "./services/refresh.ts";
import { AppError, type Runtime } from "./services/state.ts";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const num = (min: number, max: number) => z.coerce.number().min(min).max(max);

export const ViewQuerySchema = z.object({
  scenario: z.string().max(40).default("actual"),
  h: num(0, 1).optional(),
  r: num(0, 50).optional(),
  tools: bool.optional(),
  tokensPerDay: num(0, 1e12).optional(),
  days: z.coerce.number().int().min(1).max(365).optional(),
  minQuantization: z.string().max(10).optional(),
  minUptime: num(0, 1).optional(),
  zdrOnly: bool.optional(),
  hideBanned: bool.optional(),
  wPrice: num(0, 100).optional(),
  wSpeed: num(0, 100).optional(),
  wReliability: num(0, 100).optional(),
});

const PresetSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);

const PresetSettingsBody = z.object({
  model: z.string().min(3),
  slug: PresetSlug.nullable().optional(),
  autoSync: z.boolean().optional(),
  scenario: z.string().max(40).nullable().optional(),
  pinned: z.array(z.string()).max(20).optional(),
  excluded: z.array(z.string()).max(100).optional(),
});

const ok = { ok: true as const };

type Health = "ok" | "no-key" | "invalid-key" | "unreachable" | "stale";

function nextRuns(cron: string, now: Date): { next: string; intervalMs: number } | null {
  try {
    const next = Bun.cron.parse(cron, now);
    const after = next && Bun.cron.parse(cron, next);
    if (!next || !after) return null;
    return { next: next.toISOString(), intervalMs: after.getTime() - next.getTime() };
  } catch {
    return null;
  }
}

export function createApp(rt: Runtime) {
  const auth: AuthOptions = { password: rt.env.password, secret: rt.vault.sessionSecret, secure: rt.env.secureCookies };
  const limiter = new LoginLimiter();

  const app = new Hono()
    .basePath("/api")
    .onError((err, c) => {
      if (err instanceof AppError) return c.json({ error: err.code, message: err.message, details: err.details ?? null }, err.status);
      if (err instanceof HttpError) return c.json({ error: "openrouter", message: err.message, details: { status: err.status } }, 502);
      if (err instanceof z.ZodError) return c.json({ error: "invalid", message: "Invalid input", details: err.issues }, 400);
      console.error(err);
      return c.json({ error: "internal", message: err instanceof Error ? err.message : "Internal error", details: null }, 500);
    })
    .use("*", async (c, next) => {
      if (c.req.path.startsWith("/api/auth/")) return next();
      return requireSession(auth)(c, next);
    })
    .post("/auth/login", zValidator("json", z.object({ password: z.string().max(200) })), async (c) => {
      const ip = clientIp(c);
      const wait = limiter.retryAfter(ip);
      if (wait > 0) return c.json({ error: "rate-limited", message: `Too many attempts, retry in ${wait}s` }, 429);
      if (!passwordMatches(c.req.valid("json").password, auth.password)) {
        limiter.fail(ip);
        return c.json({ error: "invalid-password", message: "Wrong password" }, 401);
      }
      limiter.reset(ip);
      return c.json({ authenticated: true as const, expiresAt: await startSession(c, auth) });
    })
    .post("/auth/logout", (c) => {
      endSession(c);
      return c.json(ok);
    })
    .get("/auth/session", async (c) => {
      const expiresAt = await sessionExpiry(c, auth);
      return c.json({ authenticated: expiresAt !== null, expiresAt });
    })
    .get("/status", async (c) => {
      const snap = rt.snapshot();
      const settings = rt.settings();
      const lastRun = rt.store.recentRuns(1)[0] ?? null;
      const keySource = await rt.keySource();
      const schedule = nextRuns(settings.refreshCron, rt.now());
      const age = snap ? rt.now().getTime() - Date.parse(snap.takenAt) : 0;
      const health: Health = !keySource
        ? "no-key"
        : rt.lastError && (rt.lastError.status === 401 || rt.lastError.status === 403)
          ? "invalid-key"
          : rt.lastError
            ? "unreachable"
            : schedule && age > 2 * schedule.intervalMs
              ? "stale"
              : "ok";
      return c.json({
        health,
        nextRunAt: schedule?.next ?? null,
        key: {
          source: keySource,
          label: snap?.key.label ?? rt.store.getValue<{ label: string | null }>("key_info")?.label ?? null,
          expiresAt: snap?.key.expiresAt ?? rt.store.getValue<{ expiresAt: string | null }>("key_info")?.expiresAt ?? null,
        },
        workspace: snap?.workspace ?? null,
        workspaces: snap?.workspaces ?? (snap ? [{ id: snap.workspace.id, name: snap.workspace.name }] : []),
        mode: settings.mode,
        refreshCron: settings.refreshCron,
        takenAt: snap?.takenAt ?? null,
        models: snap?.models.length ?? 0,
        skipped: snap?.skipped ?? [],
        ignoredProviders: snap?.guardrail.ignored_providers ?? [],
        busy: rt.isBusy,
        lastRun,
        lastError: rt.lastError,
      });
    })
    .put("/key", zValidator("json", z.object({ key: z.string().min(10).max(500) })), async (c) => {
      const key = c.req.valid("json").key.trim();
      const info = await rt
        .clientFor(key)
        .getKey()
        .catch((err) => {
          if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
            throw new AppError(422, "invalid-key", "OpenRouter rejected this key");
          }
          throw err;
        });
      if (info.is_management_key === false) throw new AppError(422, "not-management-key", "This is not a management key");
      await rt.setKey(key);
      const keyInfo = { label: info.label ?? null, expiresAt: info.expires_at ?? null, workspaceId: info.workspace_id };
      rt.store.setValue("key_info", keyInfo);
      return c.json({ ok: true as const, ...keyInfo });
    })
    .delete("/key", (c) => {
      rt.deleteKey();
      rt.store.setValue("key_info", null);
      return c.json(ok);
    })
    .get("/settings", (c) => c.json(rt.settings()))
    .put("/settings", zValidator("json", z.record(z.string(), z.unknown())), (c) => {
      const before = rt.settings().workspaceId;
      const next = rt.updateSettings(c.req.valid("json"));
      if (next.workspaceId !== before) rt.store.setValue("policies_imported", false);
      return c.json(next);
    })
    .post("/settings/reset", (c) => c.json(rt.resetSettings()))
    .post("/refresh", zValidator("json", z.object({ full: z.boolean().default(false) })), async (c) => {
      const full = c.req.valid("json").full;
      return c.json(await rt.exclusive(() => refresh(rt, full)));
    })
    .get("/catalog", zValidator("query", z.object({ q: z.string().max(100).default(""), limit: z.coerce.number().int().min(1).max(200).default(50) })), (c) => {
      const { q, limit } = c.req.valid("query");
      const usage = new Map(rt.requireSnapshot().models.map((m) => [m.slug, m.usageUsd]));
      const tracked = new Set(usage.keys());
      const watch = new Set(rt.settings().watchlist.map((w) => w.slug));
      return c.json(
        rt
          .requireSnapshot()
          .catalog.filter((m) => !m.id.startsWith("~"))
          .map((m) => ({ m, score: matchScore(q, m.id, m.name) }))
          .filter((x): x is { m: (typeof x)["m"]; score: number } => x.score !== null)
          .map(({ m, score }) => ({ ...m, tracked: tracked.has(m.id), watched: watch.has(m.id), usageUsd: usage.get(m.id) ?? 0, score }))
          .sort((a, b) => b.usageUsd - a.usageUsd || b.score - a.score || a.id.length - b.id.length)
          .slice(0, limit)
          .map(({ score: _, ...m }) => m),
      );
    })
    .get("/overview", zValidator("query", ViewQuerySchema), (c) =>
      c.json(
        buildOverview({
          snapshot: rt.requireSnapshot(),
          settings: rt.settings(),
          q: c.req.valid("query"),
          bans: rt.banInputs(),
          presets: rt.store.presetSettings(),
        }),
      ),
    )
    .get("/history", zValidator("query", z.object({ model: z.string().min(3), days: z.coerce.number().int().min(1).max(30).default(7) })), (c) => {
      const { model, days } = c.req.valid("query");
      const since = new Date(rt.now().getTime() - days * 86_400_000).toISOString();
      return c.json(rt.store.history(model, since));
    })
    .get("/providers", zValidator("query", ViewQuerySchema), (c) =>
      c.json(
        buildProviders({
          snapshot: rt.requireSnapshot(),
          settings: rt.settings(),
          q: c.req.valid("query"),
          bans: rt.banInputs(),
          presets: rt.store.presetSettings(),
        }),
      ),
    )
    .put(
      "/providers/:slug/policy",
      zValidator("param", z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/) })),
      zValidator("json", z.object({ policy: z.enum(["ban", "allow"]).nullable() })),
      (c) => {
        const { slug } = c.req.valid("param");
        const { policy } = c.req.valid("json");
        rt.store.setPolicy(slug, policy, rt.now().toISOString());
        return c.json({ provider: slug, policy });
      },
    )
    .post(
      "/bans/apply",
      zValidator("json", z.object({ force: z.boolean().default(false), dryRun: z.boolean().default(false), view: ViewQuerySchema.optional() })),
      async (c) => {
        const { force, dryRun, view } = c.req.valid("json");
        const result = await rt.exclusive(() => applyBans(rt, { force, dryRun }));
        const ctx = {
          snapshot: rt.requireSnapshot(),
          settings: rt.settings(),
          q: view ?? { scenario: "actual" },
          bans: rt.banInputs(),
          presets: rt.store.presetSettings(),
        };
        return c.json({
          ...result,
          cost: { before: spendFor(ctx, new Set(result.before)), after: spendFor(ctx, new Set(result.after)), days: view?.days ?? ctx.settings.scenarios.days },
        });
      },
    )
    .post("/bans/discard", (c) => c.json(discardDrafts(rt)))
    .get("/bans/history", zValidator("query", z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) })), (c) =>
      c.json(banHistory(rt, c.req.valid("query").limit)),
    )
    .post("/bans/rollback", zValidator("json", z.object({ runId: z.number().int().positive().optional() })), async (c) => {
      const { runId } = c.req.valid("json");
      return c.json(await rt.exclusive(() => rollback(rt, runId)));
    })
    .get("/presets", zValidator("query", ViewQuerySchema.extend({ fresh: bool.optional() })), async (c) => {
      const { fresh, ...q } = c.req.valid("query");
      return c.json(await listPresets(rt, q, fresh ?? false));
    })
    .put("/presets/settings", zValidator("json", PresetSettingsBody), (c) => {
      const { model, ...patch } = c.req.valid("json");
      return c.json(updatePresetSettings(rt, model, patch));
    })
    .post("/presets/sync", zValidator("json", z.object({ models: z.array(z.string().min(3)).min(1).max(50), scenario: z.string().max(40).optional(), view: ViewQuerySchema.optional(), dryRun: z.boolean().default(false) })), async (c) => {
      const { models, scenario, view, dryRun } = c.req.valid("json");
      return c.json(await rt.exclusive(() => syncPresets(rt, models, view ?? { scenario: scenario ?? rt.settings().presets.defaultScenario }, dryRun)));
    })
    .post("/alerts/test", async (c) => {
      const alerts = rt.settings().alerts;
      if (!alerts.webhook && !(alerts.telegramBotToken && alerts.telegramChatId)) {
        throw new AppError(422, "no-alert-target", "No webhook or Telegram configured");
      }
      await sendAlert(alerts, "rerouter: test alert");
      return c.json(ok);
    });

  return app;
}

export type AppType = ReturnType<typeof createApp>;

import { computed, ref } from "vue";
import { client, unwrap, type PresetSettingsPatch, type PresetView, type SyncResult } from "@/lib/api";
import { act, dryRun, presets, reloadAfterWrite } from "@/stores/data";
import { confirmAction } from "@/stores/confirm";
import { notify } from "@/stores/toast";

export const PRESET_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SYNC_BATCH = 50;
const MAX_PICKED = 20;

export const syncBusy = ref(false);

const list = computed(() => presets.value ?? []);

export const pendingSync = computed(() =>
  list.value.filter((p) => !p.remote?.edits.length && (p.status === "not-created" || p.status === "out-of-date" || (p.status === "up-to-date" && !p.syncedAt))),
);

export const needsDecision = computed(() =>
  list.value.filter((p) => p.status === "foreign" || p.status === "unknown" || (p.status !== "empty" && p.remote?.edits.length && (p.status !== "up-to-date" || !p.syncedAt))),
);

export const presetSummary = computed(() => {
  const n = (status: PresetView["status"]) => list.value.filter((p) => p.status === status).length;
  const parts = [
    [n("up-to-date"), "up to date"],
    [n("out-of-date"), "out of date"],
    [n("not-created"), "not created"],
    [n("foreign"), "need a decision"],
    [n("empty"), "blocked"],
  ] as const;
  const text = parts.filter(([c]) => c > 0).map(([c, l]) => `${c} ${l}`);
  return text.length ? `Presets: ${text.join(" · ")}` : "";
});

export async function patchPreset(model: string, body: Omit<PresetSettingsPatch, "model">): Promise<boolean> {
  const res = await act(() => unwrap(client.presets.settings.$put({ json: { model, ...body } })));
  if (res) await reloadAfterWrite();
  return res !== null;
}

export function togglePick(preset: PresetView, tag: string, reason: string | null): void {
  const current = preset.ranked.filter((e) => !e.held).map((e) => e.tag);
  const on = current.includes(tag);
  if (!on && reason) {
    notify("Not eligible for a preset", reason, "info");
    return;
  }
  if (!on && current.length >= MAX_PICKED) {
    notify("Preset is full", `A preset holds at most ${MAX_PICKED} endpoints`, "info");
    return;
  }
  void patchPreset(preset.model, { picked: on ? current.filter((t) => t !== tag) : [...current, tag] });
}

export function resetPick(model: string): Promise<boolean> {
  return patchPreset(model, { picked: null });
}

export async function renamePreset(preset: PresetView, slug: string): Promise<boolean> {
  if (!PRESET_SLUG_RE.test(slug)) return false;
  if (slug === preset.slug) return true;
  if (preset.syncedAt) {
    const ok = await confirmAction(
      `Rename to @preset/${slug}?`,
      `@preset/${preset.slug} stays on OpenRouter but is no longer updated from here. Clients must switch to the new id after you sync it.`,
      "Rename",
    );
    if (!ok) return false;
  }
  return patchPreset(preset.model, { slug });
}

export function syncLabel(preset: PresetView): string {
  if (dryRun.value) return "Preview";
  if (preset.status === "not-created") return "Create preset";
  if (preset.status === "out-of-date") return "Update preset";
  if (preset.status === "foreign") return "Overwrite preset";
  if (preset.status === "unknown") return "Sync preset";
  if (!preset.syncedAt) return "Pin preset";
  return "Re-sync";
}

export async function syncOne(preset: PresetView, showJson: () => void): Promise<void> {
  if (dryRun.value) {
    showJson();
    notify("Preview only", `Dry-run: this config would be written to @preset/${preset.slug}. Nothing was sent.`, "info");
    return;
  }
  const edits = preset.remote?.edits ?? [];
  const removes = edits.length > 0 ? ` Syncing writes a new version with only model and provider routing, so these settings may be lost: ${edits.join(", ")}.` : "";
  const foreign = preset.status === "foreign";
  const unchecked = preset.status === "unknown";
  if (unchecked) {
    const ok = await confirmAction(
      `Write @preset/${preset.slug} without checking?`,
      "OpenRouter did not return the current preset, so edits made there or another model using this slug cannot be detected. Syncing replaces whatever is there.",
      "Write anyway",
    );
    if (!ok) return;
  } else if (foreign || edits.length > 0) {
    const other = preset.remote?.model && preset.remote.model !== preset.model;
    const ok = await confirmAction(
      foreign ? `Overwrite @preset/${preset.slug}?` : `Replace edits on @preset/${preset.slug}?`,
      foreign
        ? `${other ? `This preset on OpenRouter routes ${preset.remote!.model}. Clients using it will switch to ${preset.model}.` : "This preset on OpenRouter was not created from here and has a different provider list. Clients using it will switch to the generated list."}${removes} Rename this preset instead to keep both.`
        : `The preset on OpenRouter was edited there.${removes}`,
      foreign ? "Overwrite" : "Replace",
    );
    if (!ok) return;
  }
  syncBusy.value = true;
  const created = preset.status === "not-created";
  const accept: ("unknown" | "foreign" | "edits")[] = unchecked ? ["unknown"] : [...(foreign ? (["foreign"] as const) : []), ...(edits.length > 0 ? (["edits"] as const) : [])];
  const res = await act(() => unwrap(client.presets.sync.$post({ json: { models: [preset.model], dryRun: false, accept, slugs: { [preset.model]: preset.slug } } })));
  syncBusy.value = false;
  const r = res?.[0];
  if (!r) return;
  if (r.status === "failed") notify("Write failed", r.error ?? r.slug, "err");
  else if (r.status === "skipped") notify("Nothing to sync", r.error ?? `@preset/${r.slug}`, "info");
  else notify(created ? "Preset created" : "Preset updated", `@preset/${r.slug}${r.held?.length ? ` · kept ${r.held.length} dropped provider${r.held.length === 1 ? "" : "s"} while the cache is warm` : ""}`);
  await reloadAfterWrite();
}

export async function syncAll(): Promise<void> {
  const targets = pendingSync.value;
  if (targets.length === 0) {
    notify(
      "Nothing to sync",
      needsDecision.value.length > 0 ? `Every other preset matches. Needs a decision on its model: ${needsDecision.value.map((p) => p.slug).join(", ")}.` : "Every preset already matches the saved ranking.",
      "info",
    );
    return;
  }
  if (dryRun.value) {
    notify("Preview only", `Dry-run: ${targets.length} preset(s) would be written: ${targets.map((p) => p.slug).join(", ")}`, "info");
    return;
  }
  const names = targets.map((p) => `@preset/${p.slug}`).join("\n");
  const ok = await confirmAction(`Write ${targets.length} preset(s) to OpenRouter?`, `Clients using these ids switch to the new provider lists immediately:\n${names}`, "Write presets");
  if (!ok) return;
  syncBusy.value = true;
  const res: SyncResult[] = [];
  let stopped = false;
  for (let i = 0; i < targets.length; i += SYNC_BATCH) {
    const batch = targets.slice(i, i + SYNC_BATCH);
    const part = await act(() =>
      unwrap(client.presets.sync.$post({ json: { models: batch.map((p) => p.model), dryRun: false, slugs: Object.fromEntries(batch.map((p) => [p.model, p.slug])) } })),
    );
    if (!part) {
      stopped = true;
      break;
    }
    res.push(...part);
  }
  syncBusy.value = false;
  if (stopped) {
    notify("Sync stopped", `${res.filter((r) => r.status === "synced").length} confirmed written · ${targets.length - res.length} unconfirmed (the failed batch may be partly written). Run Sync all again to continue.`, "err");
    await reloadAfterWrite();
    return;
  }
  const failed = res.filter((r) => r.status === "failed");
  if (failed.length > 0) notify(`${failed.length} preset(s) failed`, failed.map((r) => `${r.slug}: ${r.error ?? "unknown error"}`).join(" · "), "err");
  else notify("Presets synced", `${res.filter((r) => r.status === "synced").length} written · ${res.filter((r) => r.status === "skipped").length} skipped${needsDecision.value.length ? ` · ${needsDecision.value.length} need a decision on their model` : ""}`);
  await reloadAfterWrite();
}

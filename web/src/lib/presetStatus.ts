import type { BadgeKind } from "@/components/app/StatusBadge.vue";
import type { PresetView } from "@/lib/api";

export type PresetStatusInfo = { kind: BadgeKind; text: string; tip: string; copyable: boolean; create: boolean };

export const PRESET_STATUS: Record<PresetView["status"], PresetStatusInfo> = {
  "up-to-date": { kind: "ok", text: "Up to date", tip: "The preset on OpenRouter matches the saved ranking.", copyable: true, create: false },
  "out-of-date": { kind: "warn", text: "Out of date", tip: "The preset on OpenRouter differs from the saved ranking.", copyable: true, create: true },
  "not-created": { kind: "mute", text: "Not created", tip: "Not on OpenRouter yet — create it before using the id.", copyable: false, create: true },
  foreign: { kind: "bad", text: "Slug taken", tip: "The preset on OpenRouter under this slug is not managed from here or now routes another model. Rename this preset or overwrite it.", copyable: false, create: true },
  unknown: { kind: "mute", text: "Unchecked", tip: "OpenRouter could not be reached to check this preset.", copyable: true, create: false },
  empty: { kind: "bad", text: "Cannot build", tip: "No endpoint passes the saved quality rules, so this preset cannot be created.", copyable: false, create: false },
};

export function presetStatus(preset: Pick<PresetView, "status" | "syncedAt" | "model" | "remote">): PresetStatusInfo {
  const info = PRESET_STATUS[preset.status];
  if (preset.status === "foreign" && preset.remote?.model === preset.model) {
    return { ...info, kind: "warn", text: "Unmanaged", tip: "A preset for this model already exists on OpenRouter with a different provider list, but it was not synced from here. Overwrite it to manage it, or rename this preset." };
  }
  if ((preset.status === "up-to-date" || preset.status === "out-of-date") && !preset.syncedAt) {
    return { ...info, tip: "This preset exists on OpenRouter but was never synced from here, so its id is not pinned yet. Sync it once to keep the id stable.", copyable: false, create: true };
  }
  if (preset.status === "unknown" && !preset.syncedAt) {
    return { ...info, tip: "OpenRouter could not be reached and this preset was never synced from here, so the id may not exist yet.", copyable: false };
  }
  return info;
}

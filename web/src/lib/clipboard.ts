import { notify } from "@/stores/toast";

export async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notify("Copied to clipboard", text);
  } catch {
    notify("Copy failed", "The browser blocked clipboard access.", "err");
  }
}

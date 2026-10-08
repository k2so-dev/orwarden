import { notify } from "@/stores/toast";

function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

export async function copy(text: string): Promise<void> {
  let done = false;
  if (navigator.clipboard && window.isSecureContext) {
    done = await navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  }
  if (!done) done = legacyCopy(text);
  if (done) notify("Copied to clipboard", text);
  else notify("Copy failed", `The browser blocked clipboard access. Select the id and copy it manually: ${text}`, "err");
}

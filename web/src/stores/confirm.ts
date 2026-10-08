import { shallowRef } from "vue";

export type ConfirmRequest = { title: string; text: string; action: string; danger: boolean; resolve: (ok: boolean) => void };

export const confirmRequest = shallowRef<ConfirmRequest | null>(null);

export function confirmAction(title: string, text: string, action: string, danger = false): Promise<boolean> {
  confirmRequest.value?.resolve(false);
  return new Promise((resolve) => {
    confirmRequest.value = { title, text, action, danger, resolve };
  });
}

export function settleConfirm(ok: boolean): void {
  const r = confirmRequest.value;
  confirmRequest.value = null;
  r?.resolve(ok);
}

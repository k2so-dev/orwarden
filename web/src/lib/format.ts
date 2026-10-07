const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const abs = Math.abs(value);
  if (abs === 0) return "$0";
  if (abs < 0.01) return `${value < 0 ? "-" : ""}$${abs.toPrecision(2)}`;
  return usd.format(value);
}

export function signedMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (Math.abs(value) < 0.005) return "±$0";
  return `${value > 0 ? "+" : "−"}${money(Math.abs(value))}`;
}

export function pct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function signedPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const v = Math.round(value * 100);
  if (v === 0) return "±0%";
  return `${v > 0 ? "+" : "−"}${Math.abs(v)}%`;
}

export function price(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value === 0) return "0";
  if (value >= 10) return value.toFixed(1);
  if (value >= 1) return value.toFixed(2);
  return Number(value.toPrecision(3)).toString();
}

export function uptime(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export function compact(value: number | null | undefined, unit = ""): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value)}${unit}`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function inFuture(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

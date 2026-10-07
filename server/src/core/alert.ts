import type { Config } from "../settings.ts";

const TELEGRAM_LIMIT = 4000;

export async function sendAlert(alerts: Config["alerts"], text: string, doFetch: typeof fetch = fetch): Promise<void> {
  const jobs: Promise<Response>[] = [];
  if (alerts.telegramBotToken && alerts.telegramChatId) {
    jobs.push(
      doFetch(`https://api.telegram.org/bot${alerts.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: alerts.telegramChatId,
          text: text.length > TELEGRAM_LIMIT ? `${text.slice(0, TELEGRAM_LIMIT)}\n...` : text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(15_000),
      }),
    );
  }
  if (alerts.webhook) {
    jobs.push(
      doFetch(alerts.webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(15_000),
      }),
    );
  }
  const results = await Promise.allSettled(jobs);
  for (const r of results) {
    if (r.status === "rejected") console.error(`alert failed: ${r.reason}`);
    else if (!r.value.ok) console.error(`alert failed: HTTP ${r.value.status}`);
  }
}

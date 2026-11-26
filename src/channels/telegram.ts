import type { EventStore } from "../events/store.ts";
import { parseApprovalDecision } from "../policies/approval.ts";

interface TelegramChat {
  id: number;
  type: string;
}

interface Update {
  update_id: number;
  message?: { chat: TelegramChat; text?: string };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { chat: TelegramChat };
    data?: string;
  };
}

export class TelegramError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super(`Telegram returned HTTP ${status}.`);
  }

  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

export function createTelegramClient(
  token: string,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  async function call<T>(method: string, input: object, signal: AbortSignal) {
    let response: Response;
    try {
      response = await request(
        `https://api.telegram.org/bot${token}/${method}`,
        {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
    } catch {
      signal.throwIfAborted();
      throw new Error("Telegram could not be reached.");
    }
    const body = (await response.json()) as {
      ok: boolean;
      result: T;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    if (!response.ok || !body.ok) {
      throw new TelegramError(
        body.error_code ?? response.status,
        body.parameters?.retry_after,
      );
    }
    return body.result;
  }

  return {
    getUpdates(offset: number | undefined, signal: AbortSignal) {
      return call<Update[]>(
        "getUpdates",
        { offset, timeout: 25, allowed_updates: ["message", "callback_query"] },
        AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
      );
    },
    async answerCallback(id: string, signal: AbortSignal) {
      await call(
        "answerCallbackQuery",
        { callback_query_id: id },
        AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
      );
    },
    async send(
      chatId: string,
      message: string,
      signal: AbortSignal,
      approvalId?: string,
    ) {
      const chat_id = Number(chatId);
      const text =
        message.length <= 4_000
          ? message
          : Array.from(message).slice(0, 2_000).join("") + "…";
      const reply_markup = approvalId
        ? {
            inline_keyboard: [
              [
                { text: "Approve", callback_data: `/approve ${approvalId}` },
                { text: "Deny", callback_data: `/deny ${approvalId}` },
              ],
            ],
          }
        : undefined;
      await call(
        "sendMessage",
        {
          chat_id,
          text,
          reply_markup,
          link_preview_options: { is_disabled: true },
        },
        AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      );
    },
  };
}

export type TelegramClient = ReturnType<typeof createTelegramClient>;

export async function pollTelegram(
  telegram: TelegramClient,
  store: EventStore,
  allowed: ReadonlySet<string>,
  signal: AbortSignal,
) {
  let offset: number | undefined;
  const allows = (chatId: string) => allowed.size === 0 || allowed.has(chatId);
  while (!signal.aborted) {
    try {
      const updates = await telegram.getUpdates(offset, signal);
      for (const update of updates) {
        const callback = update.callback_query;
        const message = update.message?.text?.trim();
        const chatId = String(update.message?.chat.id);
        if (callback) {
          const chat = callback.message?.chat;
          const decision = parseApprovalDecision(callback.data ?? "");
          if (
            chat?.type === "private" &&
            chat.id === callback.from.id &&
            allows(String(chat.id)) &&
            decision
          ) {
            await store.enqueue(`telegram:${update.update_id}`, {
              kind: "approval_decision",
              chatId: String(chat.id),
              ...decision,
            });
          }
          // The decision is durable before clearing the Telegram loading indicator.
          await telegram.answerCallback(callback.id, signal).catch(() => {});
        } else if (
          update.message?.chat.type === "private" &&
          message &&
          allows(chatId)
        ) {
          // The next getUpdates call confirms this update only after PostgreSQL has it.
          await store.enqueue(`telegram:${update.update_id}`, {
            kind: "chat",
            chatId,
            message,
          });
        }
        offset = update.update_id + 1;
      }
    } catch (error) {
      if (signal.aborted) break;
      console.warn(
        "Telegram polling will retry:",
        error instanceof Error ? error.message : "Unknown error",
      );
      const seconds =
        error instanceof TelegramError ? (error.retryAfter ?? 3) : 3;
      await Bun.sleep(Math.max(1, Math.min(seconds, 60)) * 1000);
    }
  }
}

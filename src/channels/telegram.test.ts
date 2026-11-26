import { expect, test } from "bun:test";
import { createTelegramClient, pollTelegram } from "./telegram.ts";

test.each(["approve", "deny"] as const)(
  "tapping %s records the decision and clears both buttons from that prompt",
  async (decision) => {
    const approvalId = "11111111-1111-4111-8111-111111111111";
    const shutdown = new AbortController();
    const calls: unknown[] = [];
    const telegram = createTelegramClient("test", async (url, init) => {
      const method = url.split("/").at(-1);
      const body = JSON.parse(String(init.body));
      calls.push([method, body]);
      if (method === "getUpdates") {
        if (body.offset !== undefined) {
          shutdown.abort();
          return Response.json({ ok: true, result: [] });
        }
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 11,
              callback_query: {
                id: "callback",
                from: { id: 123 },
                message: { chat: { id: 123, type: "private" }, message_id: 42 },
                data: `/${decision} ${approvalId}`,
              },
            },
          ],
        });
      }
      return Response.json({ ok: true, result: true });
    });

    await pollTelegram(
      telegram,
      {
        async enqueue(key, event) {
          calls.push(["enqueue", key, event]);
          return approvalId;
        },
      },
      new Set(["123"]),
      shutdown.signal,
    );

    const allowed_updates = ["message", "callback_query"];
    expect(calls).toEqual([
      ["getUpdates", { timeout: 25, allowed_updates }],
      [
        "enqueue",
        "telegram:11",
        { kind: "approval_decision", chatId: "123", approvalId, decision },
      ],
      ["answerCallbackQuery", { callback_query_id: "callback" }],
      [
        "editMessageReplyMarkup",
        { chat_id: 123, message_id: 42, reply_markup: { inline_keyboard: [] } },
      ],
      ["getUpdates", { offset: 12, timeout: 25, allowed_updates }],
    ]);
  },
);

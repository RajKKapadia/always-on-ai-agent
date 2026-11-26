import { timingSafeEqual } from "node:crypto";
import type { Agent } from "./agent.ts";
import type { EventStore } from "./events/store.ts";
import { invalidWeatherWebhook, webhookAction } from "./events/webhook.ts";

const maxMessageLength = 2_000;

export interface WebhookOptions {
  store: EventStore;
  secret: string;
  chatId: string;
}

export function startServer(
  agent: Agent,
  port: number,
  webhook?: WebhookOptions,
  hostname = "127.0.0.1",
) {
  return Bun.serve({
    hostname,
    port,
    idleTimeout: 60,
    maxRequestBodySize: 16 * 1024,
    routes: {
      "/health": {
        GET: () => Response.json({ status: "ok" }),
      },
      "/chat": {
        POST: createChatHandler(agent),
      },
      "/webhooks/:source": {
        POST: (request) =>
          webhook
            ? handleWebhook(request, request.params.source, webhook)
            : Response.json(
                { error: "Webhook intake is disabled." },
                { status: 404 },
              ),
      },
    },
    fetch() {
      return Response.json({ error: "Route not found." }, { status: 404 });
    },
  });
}

async function handleWebhook(
  request: Request,
  source: string,
  { store, secret, chatId }: WebhookOptions,
) {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!/^[a-zA-Z0-9_-]{1,50}$/.test(source)) {
    return Response.json({ error: "Invalid webhook source." }, { status: 400 });
  }

  let data: unknown;
  try {
    data = await request.json();
  } catch {
    return Response.json({ error: "Send a valid JSON body." }, { status: 400 });
  }
  const bodyType =
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    typeof data.type === "string"
      ? data.type
      : "event";
  const eventType = request.headers.get("x-event-type") ?? bodyType;
  const key = request.headers.get("idempotency-key") ?? crypto.randomUUID();
  if (
    !key.trim() ||
    key.length > 200 ||
    !eventType.trim() ||
    eventType.length > 100
  ) {
    return Response.json(
      { error: "Invalid event type or idempotency key." },
      { status: 400 },
    );
  }
  const event = {
    kind: "webhook",
    chatId,
    source,
    type: eventType,
    data,
  } as const;
  if (!webhookAction(event)) {
    return Response.json({ error: invalidWeatherWebhook }, { status: 400 });
  }

  try {
    const id = await store.enqueue(`webhook:${source}:${key}`, event);
    return Response.json({ id }, { status: 202 });
  } catch {
    return Response.json(
      {
        error:
          "The event could not be stored. Retry with the same idempotency key.",
      },
      { status: 503 },
    );
  }
}

export function createQueuedChat(store: EventStore): Agent {
  return async (message, signal) => {
    const id = await store.enqueue(`http:${crypto.randomUUID()}`, {
      kind: "chat",
      chatId: null,
      message,
    });
    while (true) {
      signal.throwIfAborted();
      const result = await store.getReply(id);
      if (result?.failed) throw new Error("The queued chat request failed.");
      if (result) return result.reply;
      await Bun.sleep(200);
    }
  };
}

export function createChatHandler(agent: Agent) {
  return async (request: Request) => {
    const hostname = new URL(request.url).hostname;
    if (hostname !== "127.0.0.1" && hostname !== "localhost") {
      return Response.json(
        { error: "This API is available on localhost." },
        { status: 403 },
      );
    }

    const contentType = request.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      return Response.json(
        { error: "Use Content-Type: application/json." },
        { status: 415 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "Send a valid JSON body." },
        { status: 400 },
      );
    }

    const input =
      typeof body === "object" && body !== null && "message" in body
        ? body.message
        : undefined;
    const message = typeof input === "string" ? input.trim() : "";
    if (!message || message.length > maxMessageLength) {
      return Response.json(
        { error: `Send a message of 1–${maxMessageLength} characters.` },
        { status: 400 },
      );
    }

    const deadline = AbortSignal.timeout(45_000);
    const signal = AbortSignal.any([request.signal, deadline]);
    try {
      const reply = await agent(message, signal);
      return Response.json({ reply });
    } catch (error) {
      if (deadline.aborted) {
        return Response.json(
          { error: "The agent timed out." },
          { status: 504 },
        );
      }
      if (!signal.aborted) console.error("Agent request failed:", error);
      return Response.json(
        { error: "The agent could not complete the request." },
        { status: 502 },
      );
    }
  };
}

import { SQL } from "bun";
import { createTelegramClient, pollTelegram } from "./src/channels/telegram.ts";
import { createMemory } from "./src/events/memory.ts";
import { createEventStore } from "./src/events/store.ts";
import {
  createEventWorker,
  createTelegramDispatcher,
  runWorker,
} from "./src/events/worker.ts";
import { createQueuedChat, startServer } from "./src/http.ts";
import { createOpenAIModel } from "./src/models/openai.ts";
import { isTimeZone } from "./src/tools/schedule.ts";
import { createWeatherClient } from "./src/tools/weather.ts";

const env = Bun.env;
const apiKey = env.OPENAI_API_KEY?.trim();
const weatherKey = env.OPENWEATHER_API_KEY?.trim();
if (!apiKey || !weatherKey) {
  console.error(
    "Set OPENAI_API_KEY and OPENWEATHER_API_KEY in .env before starting the agent.",
  );
  process.exit(1);
}

const port = Number(env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("PORT must be an integer between 1 and 65535.");
  process.exit(1);
}

const timeZone = env.AGENT_TIMEZONE?.trim() || "Asia/Kolkata";
if (!isTimeZone(timeZone)) {
  console.error("AGENT_TIMEZONE must be a valid IANA timezone.");
  process.exit(1);
}

const telegramLimits = {
  perChat: Number(env.TELEGRAM_CHAT_DAILY_AI_LIMIT ?? "30"),
  total: Number(env.TELEGRAM_DAILY_AI_LIMIT ?? "1000"),
};
if (
  Object.values(telegramLimits).some(
    (limit) => !Number.isSafeInteger(limit) || limit < 1,
  )
) {
  console.error("Telegram daily AI limits must be positive integers.");
  process.exit(1);
}

const telegramToken = env.TELEGRAM_BOT_TOKEN?.trim();
const webhookSecret = env.WEBHOOK_SECRET?.trim();
const webhookChatId = env.WEBHOOK_TELEGRAM_CHAT_ID?.trim();
const allowedChatIds = new Set(
  env.TELEGRAM_ALLOWED_CHAT_IDS?.split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);
const isChatId = (id: string) =>
  /^-?[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id));
if ([...allowedChatIds].some((id) => !isChatId(id))) {
  console.error(
    "TELEGRAM_ALLOWED_CHAT_IDS must contain numeric Telegram chat IDs.",
  );
  process.exit(1);
}
if (
  (webhookSecret || webhookChatId) &&
  (!telegramToken ||
    !webhookSecret ||
    !webhookChatId ||
    !isChatId(webhookChatId) ||
    Number(webhookChatId) < 1 ||
    (allowedChatIds.size > 0 && !allowedChatIds.has(webhookChatId)))
) {
  console.error(
    "Webhook delivery requires TELEGRAM_BOT_TOKEN, WEBHOOK_SECRET and a private WEBHOOK_TELEGRAM_CHAT_ID permitted by the chat allowlist.",
  );
  process.exit(1);
}

const model = env.OPENAI_MODEL?.trim() || "gpt-5.4-mini";
const db = new SQL({
  url:
    env.DATABASE_URL?.trim() || "postgres://agent:agent@127.0.0.1:5432/agent",
  connectionTimeout: 5,
});
const store = createEventStore(db);
try {
  await store.init();
} catch (error) {
  console.error(
    "Could not initialize PostgreSQL:",
    error instanceof Error ? error.message : "Unknown error",
  );
  await db.close();
  process.exit(1);
}

const qdrantUrl = env.QDRANT_URL?.trim() ?? "http://127.0.0.1:6333";
const memory = qdrantUrl ? createMemory(qdrantUrl, apiKey, store) : undefined;
const getWeather = createWeatherClient(weatherKey);
const work = createEventWorker({
  store,
  memory,
  model: createOpenAIModel({ apiKey, model }),
  getWeather,
  timeZone,
  telegramLimits,
});
const webhook =
  webhookSecret && webhookChatId
    ? { store, secret: webhookSecret, chatId: webhookChatId }
    : undefined;
const server = startServer(
  createQueuedChat(store),
  port,
  webhook,
  env.BIND_HOST?.trim() || "127.0.0.1",
);
console.log(`Agent listening at ${server.url} (${model}, ${timeZone})`);

const shutdown = new AbortController();
const workers = [runWorker("Inbox", work, shutdown.signal)];
if (memory) {
  workers.push(runWorker("Memory index", memory.indexOne, shutdown.signal));
}
if (telegramToken) {
  const telegram = createTelegramClient(telegramToken);
  workers.push(
    telegram.setCommands(shutdown.signal).catch((error: unknown) => {
      if (!shutdown.signal.aborted)
        console.warn("Could not register the Telegram command menu:", error);
    }),
    pollTelegram(telegram, store, allowedChatIds, shutdown.signal),
    runWorker(
      "Telegram outbox",
      createTelegramDispatcher(store, telegram),
      shutdown.signal,
    ),
  );
} else {
  console.log("Telegram is disabled until TELEGRAM_BOT_TOKEN is set.");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown.abort());
}
shutdown.signal.addEventListener("abort", () => void server.stop(true), {
  once: true,
});
await Promise.all(workers);
await db.close();

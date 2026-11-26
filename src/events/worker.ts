import { createAgent } from "../agent.ts";
import type { AgentContext, AgentModel } from "../agent.ts";
import { TelegramError } from "../channels/telegram.ts";
import type { TelegramClient } from "../channels/telegram.ts";
import {
  approvalPrompt,
  formatDeliveryTime,
  formatPlace,
  parseApprovalDecision,
} from "../policies/approval.ts";
import type {
  ApprovalDecision,
  ProtectedAction,
} from "../policies/approval.ts";
import {
  createRememberTool,
  parsePersonalMemory,
} from "../tools/personal-memory.ts";
import type { PersonalMemory } from "../tools/personal-memory.ts";
import { scheduleWeatherTool } from "../tools/schedule.ts";
import { createWeatherTool } from "../tools/weather.ts";
import type { createWeatherClient, Place } from "../tools/weather.ts";
import type { Memory } from "./memory.ts";
import { deliveryAttemptLimit, eventAttemptLimit } from "./store.ts";
import type { EventCompletion, EventStore, InboxJob } from "./store.ts";
import { invalidWeatherWebhook, webhookAction } from "./webhook.ts";

const failed = {
  reply: "I couldn't complete that request. Please try again.",
  failed: true,
};

export function createEventWorker(config: {
  store: EventStore;
  memory: Memory;
  model: AgentModel;
  getWeather: ReturnType<typeof createWeatherClient>;
  timeZone: string;
}) {
  const { store, memory, model, getWeather, timeZone } = config;

  function propose(job: InboxJob, action: ProtectedAction): EventCompletion {
    return {
      reply: approvalPrompt(action, job.id, job.event.chatId !== null),
      proposal: action,
    };
  }

  async function weatherReply(place: Place, signal: AbortSignal) {
    const weather = await getWeather(place, signal);
    if ("error" in weather && weather.retryable) throw new Error(weather.error);
    if ("error" in weather)
      return `Weather for ${formatPlace(place)}: ${weather.error}`;
    const details = [
      weather.conditions,
      weather.humidityPercent === null
        ? null
        : `humidity ${weather.humidityPercent}%`,
      weather.windKph === null ? null : `wind ${weather.windKph} km/h`,
    ]
      .filter(Boolean)
      .join(", ");
    return `${weather.location}: ${weather.temperatureC} °C${details ? `, ${details}` : ""}.\nSource: OpenWeatherMap`;
  }

  async function decide(
    job: InboxJob,
    decision: ApprovalDecision,
    signal: AbortSignal,
  ): Promise<EventCompletion> {
    const action = await store.decideApproval(job, decision);
    if (!action)
      return {
        reply: "This request is unavailable, expired, or already decided.",
      };
    if (decision.decision === "deny")
      return { reply: "Denied. Request closed." };

    switch (action.kind) {
      case "weather":
        return {
          reply: await weatherReply(action.place, signal),
          turnMessage: action.webhookSource
            ? undefined
            : `Current weather for ${formatPlace(action.place)}`,
        };
      case "schedule_weather": {
        const chatId = job.event.chatId;
        if (chatId === null)
          return { reply: "Scheduled weather requires a Telegram chat." };
        return {
          reply: `Scheduled. I’ll send current weather for ${formatPlace(action.place)} on ${formatDeliveryTime(action.at, action.timeZone)}.`,
          schedule: {
            at: action.at,
            timeZone: action.timeZone,
            event: {
              kind: "scheduled_weather",
              chatId,
              place: action.place,
              approvalId: decision.approvalId,
            },
          },
          turnMessage: `Schedule weather for ${formatPlace(action.place)}`,
        };
      }
      case "relay_webhook":
        return {
          reply: `Event: ${action.type} (${action.source})\n${JSON.stringify(action.data, null, 2)}`,
        };
    }
  }

  async function handleChat(
    job: InboxJob,
    message: string,
    signal: AbortSignal,
  ): Promise<EventCompletion> {
    const decision = parseApprovalDecision(message);
    if (decision) return decide(job, decision, signal);
    if (/^\/(?:approve|deny)\b/i.test(message)) {
      return { reply: "Use /approve or /deny followed by the request ID." };
    }

    const chatId = job.event.chatId;
    if (chatId !== null && /^\/memories$/i.test(message)) {
      const personal = await store.personalMemories(chatId);
      return {
        reply: personal.length
          ? personal.map(({ key, value }) => `${key}: ${value}`).join("\n")
          : "You have no saved preferences. Try /remember weather city = Mumbai, India.",
      };
    }

    if (chatId !== null && /^\/remember\b/i.test(message)) {
      const fields = /^\/remember\s+([^=]+)=(.+)$/i.exec(message);
      const entry = parsePersonalMemory(fields?.[1], fields?.[2]);
      return entry
        ? { reply: `Saved ${entry.key}: ${entry.value}.`, memory: entry }
        : {
            reply:
              "Use /remember label = value, for example /remember weather city = Mumbai, India.",
          };
    }

    let proposal: ProtectedAction | undefined;
    let entry: PersonalMemory | undefined;
    const stageAction = (action: ProtectedAction) => {
      if (proposal || entry) return false;
      proposal = action;
      return true;
    };
    const tools = [
      createWeatherTool((place) => stageAction({ kind: "weather", place })),
    ];
    let context: AgentContext | undefined;
    if (chatId !== null) {
      const [recent, personal] = await Promise.all([
        store.recentTurns(chatId),
        store.personalMemories(chatId),
      ]);
      const related = await memory.related(message, chatId, recent, signal);
      context = { recent, related, personal };
      tools.push(scheduleWeatherTool(timeZone, stageAction));
      if (/^(?:please\s+)?remember\s+(?:that|my|this)\b/i.test(message)) {
        tools.push(
          createRememberTool((candidate) => {
            if (proposal || entry) return false;
            entry = candidate;
            return true;
          }),
        );
      }
    }
    const reply = await createAgent(model, tools)(message, signal, context);
    if (proposal) return propose(job, proposal);
    if (entry)
      return { reply: `Saved ${entry.key}: ${entry.value}.`, memory: entry };
    return { reply, turnMessage: message };
  }

  async function processEvent(
    job: InboxJob,
    signal: AbortSignal,
  ): Promise<EventCompletion> {
    const event = job.event;
    switch (event.kind) {
      case "chat":
        return handleChat(job, event.message, signal);
      case "approval_decision":
        return decide(job, event, signal);
      case "webhook": {
        const action = webhookAction(event);
        return action
          ? propose(job, action)
          : { reply: invalidWeatherWebhook, failed: true };
      }
      case "scheduled_weather": {
        // Legacy timers were created before this policy existed. Ask before fetching their weather.
        if (!event.approvalId)
          return propose(job, { kind: "weather", place: event.place });
        const action = await store.approvedSchedule(
          event.approvalId,
          event.chatId,
        );
        if (!action)
          return { reply: "This scheduled update has no valid approval." };
        return { reply: await weatherReply(action.place, signal) };
      }
    }
  }

  return async (parent: AbortSignal) => {
    const job = await store.claimEvent();
    if (!job) return false;
    if (job.attempts > eventAttemptLimit) {
      await store.finishEvent(job, failed);
      return true;
    }

    const signal = AbortSignal.any([parent, AbortSignal.timeout(45_000)]);
    let completion: EventCompletion;
    try {
      completion = await processEvent(job, signal);
      signal.throwIfAborted();
    } catch (error) {
      if (!parent.aborted)
        console.warn(
          `Inbox event ${job.id} failed:`,
          error instanceof Error ? error.message : "Unknown error",
        );
      if (job.attempts >= eventAttemptLimit)
        await store.finishEvent(job, failed);
      else
        await store.retryEvent(
          job,
          parent.aborted ? 0 : Math.min(3 ** job.attempts, 60),
        );
      return true;
    }
    await store.finishEvent(job, completion);
    return true;
  };
}

export function createTelegramDispatcher(
  store: EventStore,
  telegram: TelegramClient,
) {
  return async (signal: AbortSignal) => {
    const item = await store.claimDelivery();
    if (!item) return false;
    if (item.attempts > deliveryAttemptLimit) {
      await store.finishDelivery(item, true);
      return true;
    }

    try {
      await telegram.send(
        item.chat_id,
        item.message,
        signal,
        item.approval_id ?? undefined,
      );
    } catch (error) {
      const retryable = !(error instanceof TelegramError) || error.retryable;
      if (!signal.aborted)
        console.warn(
          `Telegram delivery ${item.id} failed:`,
          error instanceof Error ? error.message : "Unknown error",
        );
      if (!retryable || item.attempts >= deliveryAttemptLimit)
        await store.finishDelivery(item, true);
      else {
        const requestedDelay =
          error instanceof TelegramError ? error.retryAfter : undefined;
        const delay = requestedDelay ?? Math.min(3 ** item.attempts, 300);
        await store.retryDelivery(item, signal.aborted ? 0 : delay);
      }
      return true;
    }
    await store.finishDelivery(item, false);
    return true;
  };
}

export async function runWorker(
  name: string,
  step: (signal: AbortSignal) => Promise<boolean>,
  signal: AbortSignal,
) {
  while (!signal.aborted) {
    try {
      if (!(await step(signal))) await Bun.sleep(350);
    } catch (error) {
      if (!signal.aborted)
        console.error(
          `${name} worker will retry:`,
          error instanceof Error ? error.message : "Unknown error",
        );
      await Bun.sleep(1_000);
    }
  }
}

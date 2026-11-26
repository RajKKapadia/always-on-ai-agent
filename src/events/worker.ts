import { createAgent } from "../agent.ts";
import type { AgentContext, AgentModel, AgentTool } from "../agent.ts";
import { TelegramError } from "../channels/telegram.ts";
import type { TelegramClient } from "../channels/telegram.ts";
import {
  telegramHelp,
  telegramWelcome,
} from "../channels/telegram-commands.ts";
import {
  approvalPrompt,
  formatDeliveryTime,
  formatPlace,
  parseApprovalDecision,
  scheduleDescription,
} from "../policies/approval.ts";
import type {
  ApprovalDecision,
  ProtectedAction,
  ScheduledAction,
} from "../policies/approval.ts";
import {
  createRememberTool,
  parsePersonalMemory,
} from "../tools/personal-memory.ts";
import type { PersonalMemory } from "../tools/personal-memory.ts";
import {
  editScheduleTool,
  isTimeZone,
  scheduleReminderTool,
  scheduleWeatherTool,
} from "../tools/schedule.ts";
import { createWeatherTool } from "../tools/weather.ts";
import type { createWeatherClient, Place } from "../tools/weather.ts";
import type { Memory } from "./memory.ts";
import {
  deliveryAttemptLimit,
  eventAttemptLimit,
  schedulesPageSize,
} from "./store.ts";
import type {
  EventCompletion,
  EventStore,
  InboxJob,
  PendingSchedule,
} from "./store.ts";
import { invalidWeatherWebhook, webhookAction } from "./webhook.ts";

const failed = {
  reply: "I couldn't complete that request. Please try again.",
  failed: true,
};

const scheduleIdPattern =
  /^[\da-f]{8}(?:-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})?$/i;

function scheduleDetails(
  row: PendingSchedule,
  defaultZone: string,
): ScheduledAction {
  const timing = {
    at: row.at.toISOString(),
    timeZone: row.time_zone ?? defaultZone,
  };
  return row.event.kind === "scheduled_weather"
    ? { ...timing, kind: "schedule_weather", place: row.event.place }
    : { ...timing, kind: "schedule_reminder", text: row.event.text };
}

export function createEventWorker(config: {
  store: EventStore;
  memory?: Memory;
  model: AgentModel;
  getWeather: ReturnType<typeof createWeatherClient>;
  timeZone: string;
  telegramLimits: { perChat: number; total: number };
}) {
  const { store, memory, model, getWeather, timeZone, telegramLimits } = config;

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
      case "schedule_weather":
      case "schedule_reminder": {
        const chatId = job.event.chatId;
        if (chatId === null)
          return { reply: "Scheduled deliveries require a Telegram chat." };
        const timing = { chatId, timeZone: action.timeZone };
        const description = scheduleDescription(action);
        return {
          reply: `${action.replace ? "Schedule updated." : "Scheduled."}\n${description}\n${formatDeliveryTime(action.at, action.timeZone)}\nUse /schedules to manage it.`,
          schedule: {
            operation: "save",
            at: action.at,
            replace: action.replace,
            event:
              action.kind === "schedule_weather"
                ? {
                    ...timing,
                    kind: "scheduled_weather",
                    place: action.place,
                    approvalId: decision.approvalId,
                  }
                : { ...timing, kind: "scheduled_reminder", text: action.text },
          },
          turnMessage:
            action.kind === "schedule_weather"
              ? `Schedule weather for ${formatPlace(action.place)}`
              : undefined,
        };
      }
      case "relay_webhook":
        return {
          reply: `Event: ${action.type} (${action.source})\n${JSON.stringify(action.data, null, 2)}`,
        };
    }
  }

  async function modelReply(
    job: InboxJob,
    chatId: string | null,
    message: string,
    signal: AbortSignal,
    options?: { reminder: true } | { edit: PendingSchedule },
  ): Promise<EventCompletion> {
    if (chatId !== null) {
      const usage = await store.reserveTelegramModelRequest(
        job.id,
        chatId,
        telegramLimits.perChat,
        telegramLimits.total,
      );
      if (usage === "chat_limit")
        return {
          reply:
            "You’ve reached your daily limit for AI requests. It resets at midnight UTC. You can still list and cancel schedules.",
        };
      if (usage === "daily_limit")
        return {
          reply:
            "The bot has reached its daily limit for AI requests. It resets at midnight UTC. You can still list and cancel schedules.",
        };
    }

    let proposal: ProtectedAction | undefined;
    let entry: PersonalMemory | undefined;
    const stageAction = (action: ProtectedAction) => {
      if (proposal || entry) return false;
      proposal = action;
      return true;
    };
    let tools: AgentTool[];
    let context: AgentContext | undefined;
    if (options && "edit" in options) {
      const { edit } = options;
      tools = [
        editScheduleTool(
          {
            ...scheduleDetails(edit, timeZone),
            id: edit.id,
            revision: edit.revision,
          },
          stageAction,
        ),
      ];
    } else {
      tools = options
        ? []
        : [
            createWeatherTool((place) =>
              stageAction({ kind: "weather", place }),
            ),
          ];
      if (chatId !== null) {
        const [recent, personal] = await Promise.all([
          options ? [] : store.recentTurns(chatId),
          store.personalMemories(chatId),
        ]);
        const related = options
          ? []
          : ((await memory?.related(message, chatId, recent, signal)) ?? []);
        context = { recent, related, personal };
        const savedZone = personal.find(({ key }) => key === "timezone")?.value;
        const zone = savedZone && isTimeZone(savedZone) ? savedZone : timeZone;
        tools.push(scheduleReminderTool(zone, stageAction));
        if (!options) tools.push(scheduleWeatherTool(zone, stageAction));
        if (
          !options &&
          /^(?:please\s+)?remember\s+(?:that|my|this)\b/i.test(message)
        ) {
          tools.push(
            createRememberTool((candidate) => {
              if (proposal || entry) return false;
              entry = candidate;
              return true;
            }),
          );
        }
      }
    }
    const reply = await createAgent(model, tools)(message, signal, context);
    if (proposal) return propose(job, proposal);
    if (entry)
      return { reply: `Saved ${entry.key}: ${entry.value}.`, memory: entry };
    return { reply, turnMessage: options ? undefined : message };
  }

  async function handleScheduleCommand(
    job: InboxJob,
    chatId: string,
    command: string,
    args: string,
    signal: AbortSignal,
  ): Promise<EventCompletion> {
    if (command === "schedules" || command === "list_schedules") {
      if (args && !/^[1-9]\d{0,6}$/.test(args))
        return {
          reply: "Use /schedules or /schedules followed by a page number.",
        };
      const page = args ? Number(args) : 1;
      const rows = await store.pendingSchedules(chatId, page);
      if (rows.length === 0)
        return {
          reply:
            page === 1
              ? "You have no pending schedules."
              : "There are no schedules on that page. Use /schedules to start again.",
        };
      const lines = rows.slice(0, schedulesPageSize).map((row) => {
        const action = scheduleDetails(row, timeZone);
        const description = scheduleDescription(action).replace(/\s+/g, " ");
        const label =
          description.length > 120
            ? `${description.slice(0, 119)}…`
            : description;
        return `${label}\n${formatDeliveryTime(action.at, action.timeZone)}\nID ${row.id}`;
      });
      const next =
        rows.length > schedulesPageSize
          ? `\n\nNext page /schedules ${page + 1}`
          : "";
      return {
        reply: `${lines.join("\n\n")}\n\nUse /edit_schedule ID followed by the change, or /delete_schedule ID. You can use the full ID or its first 8 characters.${next}`,
      };
    }

    const [, id = "", change = ""] =
      /^(\S+)(?:\s+([\s\S]+))?$/.exec(args) ?? [];
    const edit = command === "edit_schedule";
    if (!scheduleIdPattern.test(id) || edit !== Boolean(change)) {
      return {
        reply: edit
          ? "Use /edit_schedule ID followed by what should change. For example, /edit_schedule a1b2c3d4 tomorrow at 7 pm. Find the ID with /schedules."
          : "Use /delete_schedule ID. Find the ID with /schedules.",
      };
    }
    const [schedule, other] = await store.pendingSchedules(
      chatId,
      1,
      id.toLowerCase(),
    );
    if (other)
      return {
        reply:
          "That short ID matches two or more schedules. Use the full ID from /schedules.",
      };
    if (!schedule)
      return {
        reply:
          "That schedule is unavailable. Use /schedules to see your pending deliveries.",
      };
    if (edit)
      return modelReply(
        job,
        chatId,
        `Change this schedule: ${change}`,
        signal,
        { edit: schedule },
      );
    return {
      reply: "Schedule canceled.",
      schedule: { operation: "delete", id: schedule.id },
    };
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
    const command = /^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(
      message,
    );
    if (chatId === null || !command)
      return modelReply(job, chatId, message, signal);
    const name = command[1]?.toLowerCase();
    const args = command[2]?.trim() ?? "";
    switch (name) {
      case "start":
        return { reply: telegramWelcome };
      case "help":
        return { reply: telegramHelp };
      case "remind":
        return args
          ? modelReply(job, chatId, `Create a reminder: ${args}`, signal, {
              reminder: true,
            })
          : { reply: "Try /remind call Dad tomorrow at 6 pm." };
      case "schedules":
      case "list_schedules":
      case "edit_schedule":
      case "delete_schedule":
      case "cancel_schedule":
        return handleScheduleCommand(job, chatId, name, args, signal);
      case "timezone": {
        if (!args) {
          const personal = await store.personalMemories(chatId);
          const saved = personal.find(({ key }) => key === "timezone")?.value;
          return {
            reply:
              saved && isTimeZone(saved)
                ? `Your scheduling timezone is ${saved}.`
                : `Your scheduling timezone defaults to ${timeZone}. Set your own with /timezone Europe/London.`,
          };
        }
        return isTimeZone(args)
          ? {
              reply: `Timezone saved. New schedules will use ${args}.`,
              memory: { key: "timezone", value: args },
            }
          : {
              reply:
                "Use an IANA timezone, for example /timezone Europe/London or /timezone Asia/Kolkata.",
            };
      }
      case "memories": {
        const personal = await store.personalMemories(chatId);
        return {
          reply: personal.length
            ? personal.map(({ key, value }) => `${key}: ${value}`).join("\n")
            : "You have no saved preferences. Try /remember weather city = Mumbai, India.",
        };
      }
      case "remember": {
        const fields = /^([^=]+)=(.+)$/.exec(args);
        const entry = parsePersonalMemory(fields?.[1], fields?.[2]);
        return entry
          ? { reply: `Saved ${entry.key}: ${entry.value}.`, memory: entry }
          : {
              reply:
                "Use /remember label = value, for example /remember weather city = Mumbai, India.",
            };
      }
      case "forget": {
        const entry = parsePersonalMemory(args, "unused");
        return entry
          ? {
              reply: `Removed saved preference “${entry.key}”.`,
              forget: { key: entry.key },
            }
          : {
              reply:
                "Use /forget followed by a label, for example /forget weather city.",
            };
      }
      case "clear_preferences":
        return args
          ? {
              reply:
                "Use /clear_preferences to remove all your saved preferences.",
            }
          : { reply: "Saved preferences cleared.", forget: {} };
      default:
        return {
          reply:
            "I don’t recognize that command. Send /help for the available commands.",
        };
    }
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
      case "scheduled_reminder":
        return { reply: `Reminder: ${event.text}` };
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

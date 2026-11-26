import type { AgentTool } from "../agent.ts";
import {
  formatDeliveryTime,
  scheduleDescription,
} from "../policies/approval.ts";
import type {
  ScheduleContent,
  ScheduledAction,
  ScheduleReference,
} from "../policies/approval.ts";
import { parsePlace, placeProperties } from "./weather.ts";

const timePattern =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

type ScheduleProposal = (schedule: ScheduledAction) => boolean;
type ScheduleToEdit = ScheduledAction & ScheduleReference;

export function isTimeZone(value: string) {
  if (/^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function parseDelivery(deliverAt: unknown, timeZone: string, now: Date) {
  if (typeof deliverAt !== "string") return;
  const match = timePattern.exec(deliverAt);
  const at = new Date(deliverAt);
  if (!match || !Number.isFinite(at.getTime()) || at <= now) return;

  const localTime = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(at)
    .replace(" ", "T");
  if (localTime === match[1]) return at.toISOString();
}

export function scheduleWeatherTool(
  defaultZone: string,
  stage: (
    schedule: Extract<ScheduledAction, { kind: "schedule_weather" }>,
  ) => boolean,
  now = new Date(),
) {
  return scheduleTool(
    "schedule_weather",
    defaultZone,
    (schedule) => schedule.kind === "schedule_weather" && stage(schedule),
    now,
  );
}

export function scheduleReminderTool(
  defaultZone: string,
  stage: ScheduleProposal,
) {
  return scheduleTool("schedule_reminder", defaultZone, stage, new Date());
}

export function editScheduleTool(
  existing: ScheduleToEdit,
  stage: ScheduleProposal,
) {
  return scheduleTool(
    existing.kind,
    existing.timeZone,
    stage,
    new Date(),
    existing,
  );
}

function scheduleTool(
  kind: ScheduleContent["kind"],
  defaultZone: string,
  stage: ScheduleProposal,
  now: Date,
  existing?: ScheduleToEdit,
): AgentTool {
  const weather = kind === "schedule_weather";
  const properties = {
    ...(weather
      ? {
          ...placeProperties,
          city: existing
            ? {
                type: ["string", "null"],
                description: "New city, or null to keep the location.",
              }
            : placeProperties.city,
        }
      : {
          text: {
            type: existing ? ["string", "null"] : "string",
            description:
              "The reminder text to send, up to 500 characters. Preserve the user's wording.",
          },
        }),
    deliverAt: {
      type: existing ? ["string", "null"] : "string",
      description:
        "Future date and time in RFC 3339 with the correct UTC offset. For edits, null keeps the current time.",
    },
    timeZone: {
      type: ["string", "null"],
      description:
        "IANA timezone, such as Europe/London, or null to use the provided default.",
    },
  };

  return {
    definition: {
      name: existing ? "edit_schedule" : kind,
      description: [
        existing
          ? `Propose changes to this schedule only: ${JSON.stringify({ description: scheduleDescription(existing), at: existing.at, timeZone: existing.timeZone })}. Use null for unchanged fields. Keep the existing timezone unless explicitly changed. A timezone change needs a new deliverAt.`
          : weather
            ? "Propose one Telegram delivery of current weather. Use the saved weather city when no city is specified."
            : "Propose one Telegram reminder with the time and text requested by the user.",
        `The current time is ${formatDeliveryTime(now.toISOString(), defaultZone)}. Use ${defaultZone} unless the user specifies a different timezone.`,
        "Use only for a request in the current message. For a time without a date use the next occurrence. Ask for missing details or clarification if the time is ambiguous. This prepares one proposal for approval.",
      ].join(" "),
      parameters: {
        type: "object",
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      },
    },
    async execute(args) {
      if (!args || typeof args !== "object")
        return { error: "Provide the schedule details." };

      const zone =
        "timeZone" in args && args.timeZone !== null
          ? args.timeZone
          : defaultZone;
      if (typeof zone !== "string" || !isTimeZone(zone))
        return { error: "Use a valid IANA timezone, such as Europe/London." };
      const deliverAt = "deliverAt" in args ? args.deliverAt : undefined;
      const at =
        deliverAt === null && existing && zone === existing.timeZone
          ? existing.at
          : parseDelivery(deliverAt, zone, now);
      if (!at || new Date(at) <= now) {
        return {
          error:
            "Provide a future time whose UTC offset matches the selected timezone.",
        };
      }

      let content: ScheduleContent;
      if (weather) {
        const place =
          existing?.kind === "schedule_weather" &&
          "city" in args &&
          args.city === null
            ? existing.place
            : parsePlace(args);
        if (!place) return { error: "Provide a valid city." };
        content = { kind: "schedule_weather", place };
      } else {
        const value = "text" in args ? args.text : undefined;
        const reminder =
          value === null && existing?.kind === "schedule_reminder"
            ? existing.text
            : typeof value === "string"
              ? value.trim()
              : "";
        if (!reminder || reminder.length > 500)
          return { error: "Provide reminder text of up to 500 characters." };
        content = { kind: "schedule_reminder", text: reminder };
      }
      if (
        existing &&
        at === existing.at &&
        zone === existing.timeZone &&
        scheduleDescription(content) === scheduleDescription(existing)
      ) {
        return { error: "Specify a change to the schedule." };
      }

      const replace = existing
        ? { id: existing.id, revision: existing.revision }
        : undefined;
      if (!stage({ ...content, at, timeZone: zone, replace }))
        return { error: "Only one action can be proposed per message." };
      return { approvalRequired: true, deliverAt: at, timeZone: zone };
    },
  };
}

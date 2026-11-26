import type { AgentTool } from "../agent.ts";
import type { ProtectedAction } from "../policies/approval.ts";
import { parsePlace, placeProperties } from "./weather.ts";

const timePattern =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function scheduleWeatherTool(
  defaultZone: string,
  stage: (
    schedule: Extract<ProtectedAction, { kind: "schedule_weather" }>,
  ) => boolean,
  now = new Date(),
): AgentTool {
  const localNow = new Intl.DateTimeFormat("en-GB", {
    timeZone: defaultZone,
    dateStyle: "full",
    timeStyle: "long",
    hourCycle: "h23",
  }).format(now);

  return {
    definition: {
      name: "schedule_weather",
      description: [
        "Request permission to schedule one Telegram delivery of live weather for a specific city. Use only when the current user explicitly requests a future delivery.",
        `Current time is ${localNow} in ${defaultZone}. Use this zone unless the user specifies a different one.`,
        "For a time without a date use the next occurrence. Use the saved weather city if one exists and the user does not name a city. Ask for missing details and clarify ambiguous times.",
        "The scheduler only prepares a proposal. The user must approve it. Recurring reminders are unsupported.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          ...placeProperties,
          deliverAt: {
            type: "string",
            description:
              "Absolute date and time as RFC 3339 with the correct UTC offset, e.g. 2026-11-25T17:00:00+05:30.",
          },
          timeZone: {
            type: "string",
            description:
              "IANA timezone used to interpret this time, e.g. Asia/Kolkata.",
          },
        },
        required: [...Object.keys(placeProperties), "deliverAt", "timeZone"],
        additionalProperties: false,
      },
    },
    async execute(args) {
      const place = parsePlace(args);
      if (
        !place ||
        !args ||
        typeof args !== "object" ||
        !("deliverAt" in args) ||
        !("timeZone" in args) ||
        typeof args.deliverAt !== "string" ||
        typeof args.timeZone !== "string"
      ) {
        return { error: "Provide a city, delivery time, and IANA timezone." };
      }

      const at = new Date(args.deliverAt);
      const match = timePattern.exec(args.deliverAt);
      if (
        !match ||
        !Number.isFinite(at.getTime()) ||
        at.getTime() <= now.getTime()
      ) {
        return {
          error: "Provide a valid future date and time with a UTC offset.",
        };
      }

      try {
        const localTime = new Intl.DateTimeFormat("sv-SE", {
          timeZone: args.timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        })
          .format(at)
          .replace(" ", "T");
        if (localTime !== match[1])
          return {
            error:
              "The UTC offset must match the local time in the selected timezone.",
          };
      } catch {
        return { error: "Use a valid IANA timezone." };
      }

      const accepted = stage({
        kind: "schedule_weather",
        at: at.toISOString(),
        timeZone: args.timeZone,
        place,
      });
      if (!accepted)
        return {
          error: "Only one action can be proposed per message.",
        };
      return {
        approvalRequired: true,
        city: place.city,
        timeZone: args.timeZone,
        deliverAt: at.toISOString(),
      };
    },
  };
}

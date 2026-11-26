import type { Place } from "../tools/weather.ts";

export type ProtectedAction =
  | { kind: "weather"; place: Place; webhookSource?: string }
  | { kind: "schedule_weather"; place: Place; at: string; timeZone: string }
  | { kind: "relay_webhook"; source: string; type: string; data: unknown };

export interface ApprovalDecision {
  approvalId: string;
  decision: "approve" | "deny";
}

export const approvalLifetimeMinutes = 15;

export function parseApprovalDecision(
  message: string,
): ApprovalDecision | undefined {
  const match =
    /^\/(approve|deny)\s+([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.exec(
      message.trim(),
    );
  if (!match?.[2]) return;
  return {
    approvalId: match[2].toLowerCase(),
    decision: match[1]?.toLowerCase() === "approve" ? "approve" : "deny",
  };
}

export function formatPlace(place: Place) {
  return [place.city, place.stateCode, place.countryCode]
    .filter(Boolean)
    .join(", ");
}

export function formatDeliveryTime(at: string, timeZone: string) {
  const when = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "full",
    timeStyle: "short",
    hourCycle: "h23",
  }).format(new Date(at));
  return `${when} (${timeZone})`;
}

export function approvalPrompt(
  action: ProtectedAction,
  id: string,
  telegram: boolean,
) {
  let question: string;
  switch (action.kind) {
    case "weather":
      question = `May I fetch current weather for ${formatPlace(action.place)} from OpenWeatherMap?`;
      if (action.webhookSource) {
        question += ` The ${action.webhookSource} webhook requested this lookup. I’ll send the result to this chat.`;
      }
      break;
    case "schedule_weather":
      question = `May I schedule a one-time weather update for ${formatPlace(action.place)} on ${formatDeliveryTime(action.at, action.timeZone)}? This will fetch current weather from OpenWeatherMap at that time and send it to this chat.`;
      break;
    case "relay_webhook": {
      const type = action.type.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ");
      question = `May I relay the payload for webhook event “${type}” from ${action.source} to this Telegram chat?`;
      break;
    }
  }
  const expires =
    action.kind === "schedule_weather"
      ? `This request expires in ${approvalLifetimeMinutes} minutes or at the scheduled time, whichever comes first.`
      : `This request expires in ${approvalLifetimeMinutes} minutes.`;
  const instructions = telegram
    ? ""
    : `\n\nSend /approve ${id} or /deny ${id} as the next chat message.`;
  return `${question}\n\n${expires}${instructions}`;
}

import type { ProtectedAction } from "../policies/approval.ts";
import { parsePlace } from "../tools/weather.ts";
import type { Event } from "./store.ts";

export const invalidWeatherWebhook =
  "weather.requested requires a city name and valid country or US state codes when supplied.";

export function webhookAction({
  source,
  type,
  data,
}: Extract<Event, { kind: "webhook" }>): ProtectedAction | null {
  if (type === "weather.requested") {
    const place = parsePlace(data);
    return place ? { kind: "weather", place, webhookSource: source } : null;
  }
  return { kind: "relay_webhook", source, type, data };
}

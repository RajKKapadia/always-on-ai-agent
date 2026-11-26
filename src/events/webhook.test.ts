import { expect, test } from "bun:test";
import { webhookAction } from "./webhook.ts";

const event = { kind: "webhook", chatId: "123", source: "test" } as const;

test("weather requests propose a lookup for the validated location", () => {
  expect(
    webhookAction({
      ...event,
      type: "weather.requested",
      data: { city: " Mumbai ", countryCode: "in" },
    }),
  ).toEqual({
    kind: "weather",
    place: { city: "Mumbai", countryCode: "IN", stateCode: null },
    webhookSource: "test",
  });
  expect(
    webhookAction({ ...event, type: "weather.requested", data: {} }),
  ).toBeNull();
});

test("other event types relay their payload even when it contains a city", () => {
  const data = { city: "Mumbai" };
  expect(webhookAction({ ...event, type: "order.created", data })).toEqual({
    kind: "relay_webhook",
    type: "order.created",
    source: "test",
    data,
  });
});

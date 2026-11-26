import { expect, test } from "bun:test";
import { SQL } from "bun";
import type { AgentModel } from "../agent.ts";
import { createTelegramClient } from "../channels/telegram.ts";
import { createEventStore } from "./store.ts";
import type { Event } from "./store.ts";
import { createEventWorker, createTelegramDispatcher } from "./worker.ts";

const databaseUrl = Bun.env.TEST_DATABASE_URL;

test.skipIf(!databaseUrl)(
  "public commands isolate schedules, apply edits once, and deliver through PostgreSQL",
  async () => {
    const db = new SQL({ url: databaseUrl, max: 1 });
    const schema = "schedule_test_" + crypto.randomUUID().replaceAll("-", "");
    const signal = new AbortController().signal;
    const store = createEventStore(db);
    const alice = "111";
    const bob = "222";
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const laterInKolkata = new Date(Date.parse(later) + 19_800_000)
      .toISOString()
      .replace("Z", "+05:30");
    const place = { city: "London", countryCode: "GB", stateCode: null };
    const calls: string[] = [];
    const model: AgentModel = async ({ message, tools }) => {
      const creating = message.startsWith("Create a reminder:");
      const name = creating ? "schedule_reminder" : "edit_schedule";
      expect(tools.map((tool) => tool.name)).toEqual([name]);
      calls.push(name);
      const args = creating
        ? { text: "Call Dad", deliverAt: future, timeZone: null }
        : message.includes("weather")
          ? { ...place, deliverAt: laterInKolkata, timeZone: null }
          : {
              text: message.includes("stale") ? "Stale text" : "Call Mum",
              deliverAt: later,
              timeZone: null,
            };
      return {
        calls: [{ id: "test-call", name, arguments: JSON.stringify(args) }],
        async resume(outputs) {
          expect(outputs[0]?.result.approvalRequired).toBe(true);
          return { text: "Pending" };
        },
      };
    };
    const weatherPlaces: string[] = [];
    const work = createEventWorker({
      store,
      model,
      timeZone: "Asia/Kolkata",
      telegramLimits: { perChat: 4, total: 5 },
      getWeather: async (location) => {
        weatherPlaces.push(location.city);
        return {
          location: location.city,
          temperatureC: 20,
          observedAt: null,
          conditions: null,
          humidityPercent: null,
          windKph: null,
          source: "OpenWeatherMap",
        };
      },
    });

    async function process(event: Event) {
      const id = await store.enqueue(crypto.randomUUID(), event);
      expect(await work(signal)).toBe(true);
      const result = await store.getReply(id);
      expect(result?.failed).toBe(false);
      return { id, reply: result?.reply };
    }

    function chat(chatId: string, message: string) {
      return process({ kind: "chat", chatId, message });
    }

    function approve(chatId: string, approvalId: string) {
      return process({
        kind: "approval_decision",
        chatId,
        approvalId,
        decision: "approve",
      });
    }

    try {
      await db`CREATE SCHEMA ${db(schema)}`;
      await db`SET search_path TO ${db(schema)}`;
      await store.init();
      await store.init();

      expect((await chat(alice, "/start newcomer")).reply).toContain(
        "/timezone",
      );
      expect((await chat(bob, "/help")).reply).toContain("/edit_schedule");
      expect((await chat(alice, "/timezone UTC")).reply).toContain(
        "Timezone saved",
      );
      expect((await chat(bob, "/timezone")).reply).toContain("Asia/Kolkata");
      expect(
        (await chat(bob, "/remember weather city = Berlin, DE")).reply,
      ).toContain("Saved");
      expect((await chat(alice, "/memories")).reply).not.toContain("Berlin");
      expect(calls).toEqual([]);

      const created = await chat(alice, "/remind Call Dad");
      expect(created.reply).toContain("(UTC)");
      expect((await chat(alice, "/schedules")).reply).toContain("no pending");
      expect((await approve(bob, created.id)).reply).toContain("unavailable");
      expect((await approve(alice, created.id)).reply).toContain("Scheduled.");
      const [initial] = await store.pendingSchedules(alice);
      if (!initial) throw new Error("Missing reminder");

      expect((await chat(alice, "/schedules")).reply).toContain("Call Dad");
      expect((await chat(bob, "/schedules")).reply).toContain("no pending");
      expect(
        (await chat(bob, `/edit_schedule ${initial.id} tomorrow`)).reply,
      ).toContain("unavailable");
      expect(
        (await chat(bob, `/delete_schedule ${initial.id}`)).reply,
      ).toContain("unavailable");

      const newest = await chat(
        alice,
        `/edit_schedule ${initial.id.slice(0, 8)} change the text`,
      );
      const stale = await chat(
        alice,
        `/edit_schedule ${initial.id} stale edit`,
      );
      expect((await approve(alice, newest.id)).reply).toContain(
        "Schedule updated.",
      );
      expect((await approve(alice, stale.id)).reply).toContain(
        "changed or started delivering",
      );
      const [edited] = await store.pendingSchedules(alice);
      expect(edited).toMatchObject({
        id: initial.id,
        revision: 1,
        event: { text: "Call Mum" },
      });
      expect(edited?.at.toISOString()).toBe(later);

      const legacy = {
        kind: "scheduled_weather",
        chatId: alice,
        place: { ...place, city: "Leeds" },
      };
      const [old] = await db<{ id: string }[]>`
      INSERT INTO inbox (event_key, event, available_at)
      VALUES ('old-weather', ${db.json(legacy)}, ${future}::timestamptz) RETURNING id
    `;
      if (!old) throw new Error("Missing legacy schedule");
      expect((await chat(alice, "/schedules")).reply).toContain(
        "Weather for Leeds",
      );
      const weatherEdit = await chat(
        alice,
        `/edit_schedule ${old.id} change weather to London`,
      );
      expect((await approve(alice, weatherEdit.id)).reply).toContain(
        "Schedule updated.",
      );
      expect((await chat(alice, "/remind Take a walk")).reply).toContain(
        "your daily limit",
      );
      expect((await chat(alice, `/delete_schedule ${initial.id}`)).reply).toBe(
        "Schedule canceled.",
      );
      expect((await chat(alice, "/schedules")).reply).not.toContain("Call Mum");

      await db`UPDATE inbox SET available_at = now() - interval '1 second' WHERE id = ${old.id}`;
      expect(await work(signal)).toBe(true);
      expect((await store.getReply(old.id))?.reply).toContain("London: 20 °C");
      expect(weatherPlaces).toEqual(["London"]);
      expect((await chat(alice, "/schedules")).reply).toContain("no pending");
      expect((await chat(alice, "/clear_preferences")).reply).toContain(
        "cleared",
      );
      expect((await chat(bob, "/memories")).reply).toContain("Berlin");

      await chat(bob, "/timezone UTC");
      const bobReminder = await chat(bob, "/remind Call Dad");
      await approve(bob, bobReminder.id);
      const [bobSchedule] = await store.pendingSchedules(bob);
      if (!bobSchedule) throw new Error("Missing Bob's reminder");
      await db`UPDATE inbox SET available_at = now() - interval '1 second' WHERE id = ${bobSchedule.id}`;
      expect(await work(signal)).toBe(true);
      expect((await store.getReply(bobSchedule.id))?.reply).toBe(
        "Reminder: Call Dad",
      );
      expect((await chat(bob, "/remind One more")).reply).toContain(
        "bot has reached its daily limit",
      );
      expect(calls).toEqual([
        "schedule_reminder",
        "edit_schedule",
        "edit_schedule",
        "edit_schedule",
        "schedule_reminder",
      ]);
      const deliveries: { chat_id: number; text: string }[] = [];
      const telegram = createTelegramClient("test", async (url, request) => {
        expect(url.endsWith("/sendMessage")).toBe(true);
        deliveries.push(JSON.parse(String(request.body)));
        return Response.json({ ok: true, result: true });
      });
      const dispatch = createTelegramDispatcher(store, telegram);
      while (await dispatch(signal)) {
        // Drain the transactional outbox using a simulated Telegram connection.
      }
      expect(
        deliveries.filter(({ text }) => text.startsWith("London: 20 °C")),
      ).toEqual([expect.objectContaining({ chat_id: Number(alice) })]);
      expect(
        deliveries.filter(({ text }) => text === "Reminder: Call Dad"),
      ).toEqual([expect.objectContaining({ chat_id: Number(bob) })]);
      expect(deliveries.some(({ text }) => text === "Reminder: Call Mum")).toBe(
        false,
      );
    } finally {
      try {
        await db`DROP SCHEMA IF EXISTS ${db(schema)} CASCADE`;
      } finally {
        await db.close();
      }
    }
  },
);

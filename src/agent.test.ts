import { expect, test } from "bun:test";
import { createAgent } from "./agent.ts";
import type { ModelTurn } from "./agent.ts";
import { createChatHandler } from "./http.ts";
import { createOpenAIModel } from "./models/openai.ts";
import { createWeatherClient, createWeatherTool } from "./tools/weather.ts";
import type { Place } from "./tools/weather.ts";

test("the weather tool sends a proposal to the model without fetching weather", async () => {
  const message = "What is the current weather in Mumbai, India?";
  const call = {
    type: "function_call",
    call_id: "call_weather",
    name: "get_current_weather",
    arguments: JSON.stringify({
      city: "Mumbai",
      countryCode: "IN",
      stateCode: null,
    }),
  };
  const reasoning = {
    id: "rs_example",
    type: "reasoning",
    encrypted_content: "test-content",
    summary: [],
  };
  const model = createOpenAIModel(
    { apiKey: "test-key", model: "test-model" },
    async (url, init) => {
      expect(url).toBe("https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init.body));
      expect(body.store).toBe(false);
      expect(body.tools[0]).toMatchObject({
        type: "function",
        strict: true,
        name: call.name,
      });
      const userItem = { role: "user", content: message };
      if (body.input.length === 1) {
        expect(body.input).toEqual([userItem]);
        return Response.json({
          status: "completed",
          output: [reasoning, call],
        });
      }

      expect(body.input.slice(0, 3)).toEqual([userItem, reasoning, call]);
      const result = body.input[3];
      expect(result).toMatchObject({
        type: "function_call_output",
        call_id: call.call_id,
      });
      expect(JSON.parse(result.output)).toEqual({
        approvalRequired: true,
        place: { city: "Mumbai", countryCode: "IN", stateCode: null },
      });
      return Response.json({
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "May I look up the weather in Mumbai?",
              },
            ],
          },
        ],
      });
    },
  );

  let proposed: Place | undefined;
  const weather = createWeatherTool((place) => {
    proposed = place;
    return true;
  });

  const chat = createChatHandler(createAgent(model, [weather]));
  const reply = await chat(
    new Request("http://localhost/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    }),
  );
  expect(reply.status).toBe(200);
  expect(await reply.json()).toEqual({
    reply: "May I look up the weather in Mumbai?",
  });
  expect(proposed).toEqual({
    city: "Mumbai",
    countryCode: "IN",
    stateCode: null,
  });
});

test("OpenWeatherMap returns current conditions for the requested place", async () => {
  const getWeather = createWeatherClient("weather-key", async (url) => {
    expect(url.hostname).toBe("api.openweathermap.org");
    expect(url.searchParams.get("appid")).toBe("weather-key");
    if (url.pathname === "/geo/1.0/direct") {
      expect(url.searchParams.get("q")).toBe("Mumbai,IN");
      return Response.json([
        {
          name: "Mumbai",
          state: "Maharashtra",
          country: "IN",
          lat: 19.07,
          lon: 72.88,
        },
      ]);
    }
    expect(url.pathname).toBe("/data/2.5/weather");
    expect(url.searchParams.get("lat")).toBe("19.07");
    expect(url.searchParams.get("lon")).toBe("72.88");
    expect(url.searchParams.get("units")).toBe("metric");
    return Response.json({
      dt: Date.parse("2026-11-25T07:30:00Z") / 1000,
      main: { temp: 30, humidity: 65 },
      weather: [{ description: "partly cloudy" }],
      wind: { speed: 2.78 },
    });
  });

  expect(
    await getWeather(
      { city: "Mumbai", countryCode: "IN", stateCode: null },
      new AbortController().signal,
    ),
  ).toEqual({
    location: "Mumbai, Maharashtra, IN",
    observedAt: "2026-11-25T07:30:00.000Z",
    temperatureC: 30,
    humidityPercent: 65,
    conditions: "partly cloudy",
    windKph: 10,
    source: "OpenWeatherMap",
  });
});

test("the agent stops after three tool calls even if the model keeps asking", async () => {
  let modelTurns = 0;
  let proposals = 0;
  const weather = createWeatherTool(() => {
    proposals += 1;
    return true;
  });
  function nextTurn(): ModelTurn {
    modelTurns += 1;
    return {
      calls: [
        {
          id: `call_${modelTurns}`,
          name: weather.definition.name,
          arguments: '{"city":"Unknown"}',
        },
      ],
      async resume(outputs) {
        expect(outputs[0]?.result.approvalRequired).toBe(true);
        return nextTurn();
      },
    };
  }
  const agent = createAgent(async () => nextTurn(), [weather]);
  expect(
    await agent("Check the weather", new AbortController().signal),
  ).toContain("tool-call limit");
  expect(modelTurns).toBe(4);
  expect(proposals).toBe(3);
});

test("the scheduler validates future times and the timezone's UTC offset", async () => {
  const { scheduleWeatherTool } = await import("./tools/schedule.ts");
  const now = new Date("2026-11-25T10:00:00Z");
  const accepted: string[] = [];
  const scheduler = scheduleWeatherTool(
    "Asia/Kolkata",
    (schedule) => {
      accepted.push(schedule.at);
      return true;
    },
    now,
  );
  const args = { city: "Mumbai", countryCode: "IN", timeZone: "Asia/Kolkata" };
  const signal = new AbortController().signal;
  expect(
    await scheduler.execute(
      { ...args, deliverAt: "2026-11-25T15:00:00+05:30" },
      signal,
    ),
  ).toHaveProperty("error");
  expect(
    await scheduler.execute(
      { ...args, deliverAt: "2026-11-25T17:00:00+06:30" },
      signal,
    ),
  ).toHaveProperty("error");
  expect(
    await scheduler.execute(
      { ...args, deliverAt: "2026-11-25T17:00:00+05:30" },
      signal,
    ),
  ).toMatchObject({
    approvalRequired: true,
    deliverAt: "2026-11-25T11:30:00.000Z",
  });
  expect(accepted).toEqual(["2026-11-25T11:30:00.000Z"]);
});

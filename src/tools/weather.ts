import type { AgentTool } from "../agent.ts";

export interface Place {
  city: string;
  countryCode: string | null;
  stateCode: string | null;
}

export const placeProperties = {
  city: {
    type: "string",
    description: "City name without a country or state suffix.",
  },
  countryCode: {
    type: ["string", "null"],
    description: "Two-letter ISO country code if known, otherwise null.",
  },
  stateCode: {
    type: ["string", "null"],
    description: "Two-letter US state code if known, otherwise null.",
  },
};

export function parsePlace(args: unknown): Place | null {
  if (
    !args ||
    typeof args !== "object" ||
    !("city" in args) ||
    typeof args.city !== "string"
  )
    return null;
  const city = args.city.trim();
  const countryCode = "countryCode" in args ? (args.countryCode ?? null) : null;
  const stateCode = "stateCode" in args ? (args.stateCode ?? null) : null;
  if (
    city.length < 2 ||
    city.length > 120 ||
    city.includes(",") ||
    /\p{C}/u.test(city)
  )
    return null;
  if (
    countryCode !== null &&
    (typeof countryCode !== "string" || !/^[a-z]{2}$/i.test(countryCode))
  )
    return null;
  if (
    stateCode !== null &&
    (typeof stateCode !== "string" ||
      !/^[a-z]{2}$/i.test(stateCode) ||
      countryCode?.toUpperCase() !== "US")
  )
    return null;
  return {
    city,
    countryCode: countryCode?.toUpperCase() ?? null,
    stateCode: stateCode?.toUpperCase() ?? null,
  };
}

interface GeocodingResult {
  name: string;
  state?: string;
  country: string;
  lat: number;
  lon: number;
}

interface CurrentWeather {
  dt?: number;
  main?: { temp?: number; humidity?: number };
  wind?: { speed?: number };
  weather?: { description?: string }[];
}

type WeatherResult =
  | { error: string; retryable: boolean }
  | {
      location: string;
      observedAt: string | null;
      temperatureC: number;
      humidityPercent: number | null;
      windKph: number | null;
      conditions: string | null;
      source: "OpenWeatherMap";
    };

export function createWeatherClient(
  apiKey: string,
  request: (url: URL, init: RequestInit) => Promise<Response> = fetch,
) {
  return async (place: Place, signal: AbortSignal): Promise<WeatherResult> => {
    const weatherSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
    const geocoding = new URL("https://api.openweathermap.org/geo/1.0/direct");
    geocoding.search = new URLSearchParams({
      q: [place.city, place.stateCode, place.countryCode]
        .filter(Boolean)
        .join(","),
      limit: "1",
      appid: apiKey,
    }).toString();
    try {
      const locations = await request(geocoding, { signal: weatherSignal });
      if (!locations.ok) {
        await locations.body?.cancel();
        return weatherError(locations.status);
      }
      const [location] = (await locations.json()) as GeocodingResult[];
      if (!location)
        return {
          error: "City not found. Check the city and country.",
          retryable: false,
        };
      if (
        !location.name ||
        !Number.isFinite(location.lat) ||
        !Number.isFinite(location.lon)
      ) {
        return {
          error: "The OpenWeatherMap location lookup returned incomplete data.",
          retryable: true,
        };
      }

      const current = new URL(
        "https://api.openweathermap.org/data/2.5/weather",
      );
      current.search = new URLSearchParams({
        lat: String(location.lat),
        lon: String(location.lon),
        units: "metric",
        appid: apiKey,
      }).toString();
      const response = await request(current, { signal: weatherSignal });
      if (!response.ok) {
        await response.body?.cancel();
        return weatherError(response.status);
      }
      const data = (await response.json()) as CurrentWeather;
      const temp = data.main?.temp;
      if (typeof temp !== "number" || !Number.isFinite(temp)) {
        return {
          error: "Current weather is unavailable for this location.",
          retryable: true,
        };
      }

      return {
        location: [location.name, location.state, location.country]
          .filter(Boolean)
          .join(", "),
        observedAt: data.dt ? new Date(data.dt * 1000).toISOString() : null,
        temperatureC: temp,
        humidityPercent: data.main?.humidity ?? null,
        windKph:
          typeof data.wind?.speed === "number"
            ? Math.round(data.wind.speed * 36) / 10
            : null,
        conditions: data.weather?.[0]?.description ?? null,
        source: "OpenWeatherMap",
      };
    } catch {
      signal.throwIfAborted();
      return {
        error: "The OpenWeatherMap lookup failed. Try again shortly.",
        retryable: true,
      };
    }
  };
}

export function createWeatherTool(stage: (place: Place) => boolean): AgentTool {
  return {
    definition: {
      name: "get_current_weather",
      description:
        "Request permission to fetch current conditions for a known city. Use the saved weather city if the user did not name a city. Ask for the city if it is otherwise unknown. This tool prepares the confirmation and does not fetch weather.",
      parameters: {
        type: "object",
        properties: placeProperties,
        required: Object.keys(placeProperties),
        additionalProperties: false,
      },
    },
    async execute(args) {
      const place = parsePlace(args);
      if (!place)
        return {
          error:
            "Provide a city name and valid country or US state codes, when known.",
        };
      if (!stage(place))
        return { error: "Only one action can be proposed per message." };
      return { approvalRequired: true, place };
    },
  };
}

function weatherError(status: number): WeatherResult {
  return {
    error:
      status === 401 || status === 403
        ? "OpenWeatherMap is unavailable because its API key was rejected."
        : "The OpenWeatherMap service could not return current conditions.",
    retryable: status === 429 || status >= 500,
  };
}

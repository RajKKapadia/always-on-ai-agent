import type { AgentTool } from "../agent.ts";

export interface PersonalMemory {
  key: string;
  value: string;
}

export function parsePersonalMemory(
  key: unknown,
  value: unknown,
): PersonalMemory | undefined {
  if (typeof key !== "string" || typeof value !== "string") return;
  const normalizedKey = key.trim().toLowerCase().replace(/\s+/g, " ");
  const normalizedValue = value.trim();
  if (
    !/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,47}$/u.test(normalizedKey) ||
    !normalizedValue ||
    normalizedValue.length > 180 ||
    /\p{C}/u.test(normalizedValue)
  )
    return;
  const stableKey = /^(?:default )?weather (?:city|location)$/.test(
    normalizedKey,
  )
    ? "weather city"
    : normalizedKey;
  return { key: stableKey, value: normalizedValue };
}

export function createRememberTool(
  stage: (memory: PersonalMemory) => boolean,
): AgentTool {
  return {
    definition: {
      name: "save_personal_memory",
      description:
        "Save one explicitly requested fact or preference from the current user's message. Use a stable label such as weather city, name, or temperature unit. Keep only information the user asked to remember.",
      parameters: {
        type: "object",
        properties: { key: { type: "string" }, value: { type: "string" } },
        required: ["key", "value"],
        additionalProperties: false,
      },
    },
    async execute(args) {
      if (
        !args ||
        typeof args !== "object" ||
        !("key" in args) ||
        !("value" in args)
      ) {
        return { error: "Provide a memory label and a value." };
      }
      const memory = parsePersonalMemory(args.key, args.value);
      if (!memory)
        return {
          error:
            "Use a short label and a single-line value of up to 180 characters.",
        };
      if (!stage(memory))
        return { error: "Only one preference can be saved per message." };
      return { saved: true, ...memory };
    },
  };
}

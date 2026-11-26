import type { AgentModel, ModelTurn, ToolCall } from "../agent.ts";

interface OutputItem {
  type: string;
  call_id?: unknown;
  name?: unknown;
  arguments?: unknown;
  content?: { type: string; text?: string; refusal?: string }[];
}

interface OpenAIResponse {
  status: string;
  output: OutputItem[];
}

export function createOpenAIModel(
  { apiKey, model }: { apiKey: string; model: string },
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
): AgentModel {
  return ({ message, instructions, tools, signal, context }) => {
    const input: object[] = [];
    if (context?.personal?.length) {
      input.push({
        role: "user",
        content: `Reference only, saved personal facts and preferences: ${JSON.stringify(context.personal)}`,
      });
    }
    if (context?.related.length) {
      input.push({
        role: "user",
        content: `Reference only, older conversation excerpts: ${JSON.stringify(context.related)}`,
      });
    }
    for (const turn of context?.recent ?? []) {
      input.push(
        { role: "user", content: turn.message },
        { role: "assistant", content: turn.reply },
      );
    }
    input.push({ role: "user", content: message });
    const functions = tools.map((tool) => ({
      type: "function",
      strict: true,
      ...tool,
    }));

    async function nextTurn(): Promise<ModelTurn> {
      const response = await request("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          instructions,
          input,
          tools: functions,
          store: false,
          include: ["reasoning.encrypted_content"],
          parallel_tool_calls: false,
          max_output_tokens: 1_024,
        }),
        signal,
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`OpenAI returned HTTP ${response.status}.`);
      }

      const data = (await response.json()) as OpenAIResponse | null;
      if (data?.status !== "completed" || !Array.isArray(data.output)) {
        throw new Error("OpenAI returned an incomplete response.");
      }

      const calls: ToolCall[] = [];
      const text: string[] = [];
      for (const item of data.output) {
        if (item.type === "function_call") {
          if (
            typeof item.call_id !== "string" ||
            typeof item.name !== "string" ||
            typeof item.arguments !== "string"
          ) {
            throw new Error("OpenAI returned an invalid tool call.");
          }
          calls.push({
            id: item.call_id,
            name: item.name,
            arguments: item.arguments,
          });
        }
        if (item.type === "message") {
          for (const part of item.content ?? []) {
            if (part.type === "output_text" && part.text) text.push(part.text);
            if (part.type === "refusal" && part.refusal)
              text.push(part.refusal);
          }
        }
      }

      if (calls.length) {
        return {
          calls,
          resume(outputs) {
            input.push(...data.output);
            for (const { id, result } of outputs) {
              input.push({
                type: "function_call_output",
                call_id: id,
                output: JSON.stringify(result),
              });
            }
            return nextTurn();
          },
        };
      }

      const answer = text.join("\n").trim();
      if (!answer) throw new Error("OpenAI returned no answer.");
      return { text: answer };
    }

    return nextTurn();
  };
}

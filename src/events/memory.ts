import type { ConversationTurn, EventStore } from "./store.ts";

const collection = "/collections/agent_memory_v1";
const embeddingModel = "text-embedding-3-small";
const dimensions = 1_536;

export function createMemory(
  url: string,
  apiKey: string,
  store: EventStore,
  requestEmbedding: (
    url: string,
    init: RequestInit,
  ) => Promise<Response> = fetch,
) {
  let collectionPrepared: Promise<void> | undefined;

  async function qdrant(
    path: string,
    method: string,
    signal: AbortSignal,
    body?: object,
  ) {
    return fetch(new URL(collection + path, url), {
      method,
      signal,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async function ensureCollection(signal: AbortSignal) {
    collectionPrepared ??= (async () => {
      const existing = await qdrant("", "GET", signal);
      await existing.body?.cancel();
      if (existing.ok) return;
      if (existing.status !== 404)
        throw new Error(`Qdrant returned HTTP ${existing.status}.`);
      const created = await qdrant("", "PUT", signal, {
        vectors: { size: dimensions, distance: "Cosine" },
      });
      await created.body?.cancel();
      if (!created.ok && created.status !== 409)
        throw new Error(`Qdrant returned HTTP ${created.status}.`);
    })().catch((error) => {
      collectionPrepared = undefined;
      throw error;
    });
    await collectionPrepared;
  }

  async function embed(input: string, signal: AbortSignal) {
    const response = await requestEmbedding(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: embeddingModel, input, dimensions }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Embedding API returned HTTP ${response.status}.`);
    }
    const { data } = (await response.json()) as {
      data: { embedding: number[] }[];
    };
    const vector = data?.[0]?.embedding;
    if (!vector || vector.length !== dimensions)
      throw new Error("Embedding API returned an invalid vector.");
    return vector;
  }

  return {
    async related(
      message: string,
      chatId: string,
      recent: ConversationTurn[],
      parent: AbortSignal,
    ) {
      if (!recent.length) return [];
      const signal = AbortSignal.any([parent, AbortSignal.timeout(5_000)]);
      try {
        await ensureCollection(signal);
        const query = await embed(message, signal);
        const response = await qdrant("/points/query", "POST", signal, {
          query,
          filter: {
            must: [{ key: "chat_id", match: { value: chatId } }],
            must_not: [{ has_id: recent.map((turn) => turn.id) }],
          },
          limit: 3,
          score_threshold: 0.35,
          with_payload: true,
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 404) collectionPrepared = undefined;
          throw new Error(`Qdrant returned HTTP ${response.status}.`);
        }
        const { result } = (await response.json()) as {
          result: { points: { payload: ConversationTurn }[] };
        };
        return result.points.map(({ payload }) => ({
          message: payload.message,
          reply: payload.reply,
        }));
      } catch {
        parent.throwIfAborted();
        return [];
      }
    },

    async indexOne(parent: AbortSignal) {
      const turn = await store.unindexedTurn();
      if (!turn) return false;
      const signal = AbortSignal.any([parent, AbortSignal.timeout(10_000)]);
      try {
        await ensureCollection(signal);
        const vector = await embed(
          `User: ${turn.message}\nAssistant: ${turn.reply}`,
          signal,
        );
        const response = await qdrant("/points?wait=true", "PUT", signal, {
          points: [{ id: turn.id, vector, payload: turn }],
        });
        await response.body?.cancel();
        if (!response.ok) {
          if (response.status === 404) collectionPrepared = undefined;
          throw new Error(`Qdrant returned HTTP ${response.status}.`);
        }
        await store.markIndexed(turn.id);
      } catch (error) {
        if (!parent.aborted)
          console.warn(
            "Memory indexing will retry:",
            error instanceof Error ? error.message : "Unknown error",
          );
        await store.retryIndex(turn.id);
      }
      return true;
    },
  };
}

export type Memory = ReturnType<typeof createMemory>;

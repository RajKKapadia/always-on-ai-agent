import type { SQL } from "bun";
import { approvalLifetimeMinutes } from "../policies/approval.ts";
import type {
  ApprovalDecision,
  ProtectedAction,
} from "../policies/approval.ts";
import type { PersonalMemory } from "../tools/personal-memory.ts";
import type { Place } from "../tools/weather.ts";

export type Event =
  | { kind: "chat"; chatId: string | null; message: string }
  | {
      kind: "scheduled_weather";
      chatId: string;
      place: Place;
      approvalId?: string;
    }
  | ({ kind: "approval_decision"; chatId: string } & ApprovalDecision)
  | {
      kind: "webhook";
      chatId: string;
      source: string;
      type: string;
      data: unknown;
    };

export interface WeatherSchedule {
  event: Extract<Event, { kind: "scheduled_weather" }>;
  at: string;
  timeZone: string;
}

export interface EventCompletion {
  reply: string;
  failed?: boolean;
  proposal?: ProtectedAction;
  schedule?: WeatherSchedule;
  memory?: PersonalMemory;
  turnMessage?: string;
}

export interface InboxJob {
  id: string;
  event: Event;
  attempts: number;
}

export interface Delivery {
  id: string;
  chat_id: string;
  message: string;
  attempts: number;
  approval_id: string | null;
}

export interface ConversationTurn {
  id: string;
  chat_id: string;
  message: string;
  reply: string;
}

export const eventAttemptLimit = 5;
export const deliveryAttemptLimit = 8;

export function createEventStore(db: SQL) {
  return {
    async init() {
      await db
        .unsafe(await Bun.file(new URL("./schema.sql", import.meta.url)).text())
        .simple();
    },
    async enqueue(key: string, event: Event) {
      const [row] = await db<{ id: string }[]>`
        INSERT INTO inbox (event_key, event) VALUES (${key}, ${db.json(event)})
        ON CONFLICT (event_key) DO UPDATE SET event_key = EXCLUDED.event_key
        RETURNING id
      `;
      if (!row) throw new Error("Could not record inbox event.");
      return row.id;
    },
    async getReply(id: string) {
      const [row] = await db<{ reply: string; failed: boolean }[]>`
        SELECT reply, failed FROM inbox WHERE id = ${id} AND finished_at IS NOT NULL
      `;
      return row;
    },
    async claimEvent() {
      const [job] = await db<InboxJob[]>`
        WITH next AS (
          SELECT id FROM inbox
          WHERE finished_at IS NULL AND available_at <= now()
            AND (lease_until IS NULL OR lease_until <= now())
          ORDER BY available_at, created_at
          LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        UPDATE inbox SET attempts = attempts + 1, lease_until = now() + interval '2 minutes'
        FROM next WHERE inbox.id = next.id
        RETURNING inbox.id, event, attempts
      `;
      return job;
    },
    async finishEvent(job: InboxJob, completion: EventCompletion) {
      const {
        reply,
        failed = false,
        proposal,
        schedule,
        memory,
        turnMessage,
      } = completion;
      await db.begin(async (tx) => {
        const [finished] = await tx`
          UPDATE inbox SET finished_at = now(), lease_until = NULL, reply = ${reply}, failed = ${failed}
          WHERE id = ${job.id} AND attempts = ${job.attempts} AND finished_at IS NULL RETURNING id
        `;
        if (!finished) return;
        if (proposal) {
          const deadline =
            proposal.kind === "schedule_weather" ? proposal.at : null;
          await tx`
            INSERT INTO action_approvals (id, chat_id, action, expires_at)
            VALUES (${job.id}, ${job.event.chatId}, ${tx.json(proposal)},
              LEAST(now() + ${approvalLifetimeMinutes} * interval '1 minute', ${deadline}::timestamptz))
          `;
        }
        if (schedule) {
          await tx`
            INSERT INTO inbox (event_key, event, available_at)
            VALUES (${`schedule:${job.id}`}, ${tx.json(schedule.event)}, ${schedule.at}::timestamptz)
          `;
        }
        if (job.event.chatId !== null) {
          await tx`
            INSERT INTO telegram_outbox (id, chat_id, message, approval_id)
            VALUES (${job.id}, ${job.event.chatId}, ${reply}, ${proposal ? job.id : null})
          `;
          if (turnMessage && !failed) {
            await tx`
              INSERT INTO conversation_turns (id, chat_id, message, reply)
              VALUES (${job.id}, ${job.event.chatId}, ${turnMessage}, ${reply})
            `;
          }
          if (memory) {
            await tx`
              INSERT INTO personal_memories (chat_id, key, value)
              VALUES (${job.event.chatId}, ${memory.key}, ${memory.value})
              ON CONFLICT (chat_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
            `;
          }
        }
      });
    },
    async decideApproval(
      job: InboxJob,
      { approvalId, decision }: ApprovalDecision,
    ) {
      // The same decision event can resume after an upstream failure. A different event cannot reuse it.
      const [row] = await db<{ action: ProtectedAction }[]>`
        UPDATE action_approvals SET decision = ${decision}, decided_by = ${job.id}, decided_at = COALESCE(decided_at, now())
        WHERE id = ${approvalId} AND chat_id IS NOT DISTINCT FROM ${job.event.chatId}::text
          AND (decided_by = ${job.id} OR (decision IS NULL AND expires_at > now()))
          AND EXISTS (SELECT 1 FROM inbox WHERE id = ${job.id} AND attempts = ${job.attempts} AND finished_at IS NULL)
        RETURNING action
      `;
      return row?.action;
    },
    async approvedSchedule(approvalId: string, chatId: string) {
      const [row] = await db<
        { action: Extract<ProtectedAction, { kind: "schedule_weather" }> }[]
      >`
        SELECT action FROM action_approvals
        WHERE id = ${approvalId} AND chat_id = ${chatId} AND decision = 'approve'
          AND action->>'kind' = 'schedule_weather'
      `;
      return row?.action;
    },
    async retryEvent(job: InboxJob, seconds: number) {
      await db`
        UPDATE inbox SET lease_until = NULL, available_at = now() + ${seconds} * interval '1 second'
        WHERE id = ${job.id} AND attempts = ${job.attempts} AND finished_at IS NULL
      `;
    },
    async claimDelivery() {
      const [item] = await db<Delivery[]>`
        WITH next AS (
          SELECT id FROM telegram_outbox
          WHERE finished_at IS NULL AND available_at <= now()
            AND (lease_until IS NULL OR lease_until <= now())
          ORDER BY available_at, created_at
          LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        UPDATE telegram_outbox SET attempts = attempts + 1, lease_until = now() + interval '1 minute'
        FROM next WHERE telegram_outbox.id = next.id
        RETURNING telegram_outbox.id, chat_id, message, attempts, approval_id
      `;
      return item;
    },
    async finishDelivery(item: Delivery, failed: boolean) {
      await db`
        UPDATE telegram_outbox SET finished_at = now(), failed = ${failed}, lease_until = NULL
        WHERE id = ${item.id} AND attempts = ${item.attempts} AND finished_at IS NULL
      `;
    },
    async retryDelivery(item: Delivery, seconds: number) {
      await db`
        UPDATE telegram_outbox SET lease_until = NULL, available_at = now() + ${seconds} * interval '1 second'
        WHERE id = ${item.id} AND attempts = ${item.attempts} AND finished_at IS NULL
      `;
    },
    async recentTurns(chatId: string) {
      const rows = await db<ConversationTurn[]>`
        SELECT id, chat_id, message, reply FROM conversation_turns
        WHERE chat_id = ${chatId} ORDER BY created_at DESC LIMIT 6
      `;
      return [...rows].reverse();
    },
    async personalMemories(chatId: string) {
      const rows = await db<PersonalMemory[]>`
        SELECT key, value FROM personal_memories
        WHERE chat_id = ${chatId}
        ORDER BY updated_at DESC, key LIMIT 20
      `;
      return [...rows];
    },
    async unindexedTurn() {
      const [turn] = await db<ConversationTurn[]>`
        SELECT id, chat_id, message, reply FROM conversation_turns
        WHERE indexed_at IS NULL AND index_after <= now() ORDER BY index_after, created_at LIMIT 1
      `;
      return turn;
    },
    async markIndexed(id: string) {
      await db`UPDATE conversation_turns SET indexed_at = now() WHERE id = ${id}`;
    },
    async retryIndex(id: string) {
      await db`UPDATE conversation_turns SET index_after = now() + interval '1 minute' WHERE id = ${id}`;
    },
  };
}

export type EventStore = ReturnType<typeof createEventStore>;

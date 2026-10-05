import type { EventType, Interrupt } from "@ag-ui/core";
import { interactionEvent, type Interaction } from "./protocol.js";
import type { CanonicalEvent, Context } from "./types.js";
export const key = (e: { type: string }) => e.type;
export const sse = <E>(event: E) => `data: ${JSON.stringify(event)}\n\n`;
export const namedSSE = <E extends { type: string }>(event: E) =>
  `event: ${event.type}\n${sse(event)}`;
export const json = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected an event object.");
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected a string.");
  return value;
}
export function parseArguments(value: string): unknown {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Tool input ended with invalid JSON arguments.");
  }
}
/** Per-consumption source lifecycle bookkeeping. */
export class Lifecycle {
  readonly id = `ep_${crypto.randomUUID()}`;
  runId = this.id;
  readonly threadId = `thread_${crypto.randomUUID()}`;
  readonly interrupts: Interrupt[] = [];
  started = false;
  ended = false;
  blocks = new Map<string, { kind: "text" | "reasoning"; messageId: string }>();
  tools = new Map<string, { name: string; messageId: string }>();
  start(id = this.id): CanonicalEvent[] {
    if (this.ended) throw new Error("Received content after the run ended.");
    if (this.started) return [];
    this.started = true;
    this.runId = id;
    return [
      {
        type: "RUN_STARTED" as EventType.RUN_STARTED,
        runId: id,
        threadId: this.threadId,
      },
    ];
  }
  block(
    id: string,
    kind: "text" | "reasoning",
    messageId = this.id,
  ): CanonicalEvent[] {
    const events = this.start();
    const existing = this.blocks.get(id);
    if (
      existing &&
      (existing.kind !== kind || existing.messageId !== messageId)
    )
      throw new Error(`Conflicting block identity: ${id}`);
    if (!existing) {
      this.blocks.set(id, { kind, messageId });
      events.push(
        kind === "text"
          ? {
              type: "TEXT_MESSAGE_START" as EventType.TEXT_MESSAGE_START,
              messageId: id,
              role: "assistant",
              metadata: { eventport: { parentMessageId: messageId } },
            }
          : {
              type: "REASONING_MESSAGE_START" as EventType.REASONING_MESSAGE_START,
              messageId: id,
              role: "reasoning",
              metadata: { eventport: { parentMessageId: messageId } },
            },
      );
    }
    return events;
  }
  delta(
    id: string,
    value: string,
    kind: "text" | "reasoning" = "text",
    messageId = this.id,
  ): CanonicalEvent[] {
    return [
      ...this.block(id, kind, messageId),
      ...(value
        ? [
            kind === "text"
              ? {
                  type: "TEXT_MESSAGE_CONTENT" as EventType.TEXT_MESSAGE_CONTENT,
                  messageId: id,
                  delta: value,
                }
              : {
                  type: "REASONING_MESSAGE_CONTENT" as EventType.REASONING_MESSAGE_CONTENT,
                  messageId: id,
                  delta: value,
                },
          ]
        : []),
    ];
  }
  endBlock(id: string): CanonicalEvent[] {
    const block = this.blocks.get(id);
    if (!block || !this.blocks.delete(id))
      throw new Error(`Unknown or already closed block: ${id}`);
    return [
      block.kind === "text"
        ? {
            type: "TEXT_MESSAGE_END" as EventType.TEXT_MESSAGE_END,
            messageId: id,
          }
        : {
            type: "REASONING_MESSAGE_END" as EventType.REASONING_MESSAGE_END,
            messageId: id,
          },
    ];
  }
  tool(id: string, name: string, messageId = this.id): CanonicalEvent[] {
    const events = this.start();
    if (this.tools.has(id))
      throw new Error(`Duplicate active tool call: ${id}`);
    this.tools.set(id, { name, messageId });
    events.push({
      type: "TOOL_CALL_START" as EventType.TOOL_CALL_START,
      toolCallId: id,
      toolCallName: name,
      parentMessageId: messageId,
    });
    return events;
  }
  toolDelta(id: string, value: string): CanonicalEvent[] {
    if (!this.tools.has(id)) throw new Error(`Tool delta without start: ${id}`);
    return value
      ? [
          {
            type: "TOOL_CALL_ARGS" as EventType.TOOL_CALL_ARGS,
            toolCallId: id,
            delta: value,
          },
        ]
      : [];
  }
  endTool(id: string): CanonicalEvent[] {
    if (!this.tools.delete(id))
      throw new Error(`Unknown or already closed tool call: ${id}`);
    return [
      { type: "TOOL_CALL_END" as EventType.TOOL_CALL_END, toolCallId: id },
    ];
  }
  closeContent(): CanonicalEvent[] {
    return [
      ...[...this.blocks.keys()].flatMap((id) => this.endBlock(id)),
      ...[...this.tools.keys()].flatMap((id) => this.endTool(id)),
    ];
  }
  interaction(value: Interaction): CanonicalEvent {
    this.interrupts.push({
      id: value.id,
      reason: value.kind,
      toolCallId: value.toolCallId,
      metadata: { eventport: value.payload },
    });
    return interactionEvent(value);
  }
  end(reason = "stop"): CanonicalEvent[] {
    if (this.ended) throw new Error("Duplicate run completion.");
    const events: CanonicalEvent[] = [
      ...this.start(),
      ...this.closeContent(),
      {
        type: "RUN_FINISHED" as EventType.RUN_FINISHED,
        runId: this.runId,
        threadId: this.threadId,
        metadata: { eventport: { finishReason: reason } },
        ...(reason === "aborted"
          ? { outcome: { type: "cancelled" as const } }
          : this.interrupts.length
            ? {
                outcome: {
                  type: "interrupt" as const,
                  interrupts: [...this.interrupts],
                },
              }
            : {}),
      },
    ];
    this.ended = true;
    return events;
  }
  finish(): CanonicalEvent[] {
    if (this.started && !this.ended)
      throw new Error("Incomplete source stream: missing terminal event.");
    return [];
  }
}
export async function unsupported(
  context: Context,
  event: unknown,
  reason = "Event has no supported mapping.",
): Promise<CanonicalEvent[]> {
  await context.unsupported(event, reason);
  return [];
}

import type { CanonicalEvent, Context } from "./types.js";
export const key = (e: { type: string }) => e.type;
export const sse = <E>(event: E) => `data: ${JSON.stringify(event)}\n\n`;
export const namedSSE = <E extends { type: string }>(event: E) => `event: ${event.type}\n${sse(event)}`;
export const json = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value);
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected an event object.");
  return value as Record<string, unknown>;
}
export function text(value: unknown): string { if (typeof value !== "string") throw new TypeError("Expected a string."); return value; }
export function parseArguments(value: string): unknown {
  if (!value.trim()) return {};
  try { return JSON.parse(value); } catch { throw new Error("Tool input ended with invalid JSON arguments."); }
}
/** Per-consumption source lifecycle bookkeeping. */
export class Lifecycle {
  readonly id = `ep_${crypto.randomUUID()}`;
  started = false;
  ended = false;
  blocks = new Map<string, { kind: "text" | "reasoning"; messageId: string }>();
  tools = new Map<string, { name: string; messageId: string }>();
  start(id = this.id): CanonicalEvent[] {
    if (this.ended) throw new Error("Received content after the run ended.");
    if (this.started) return [];
    this.started = true; return [{ type: "run.start", id }];
  }
  block(id: string, kind: "text" | "reasoning", messageId = this.id): CanonicalEvent[] {
    const events = this.start();
    const existing = this.blocks.get(id);
    if (existing && (existing.kind !== kind || existing.messageId !== messageId)) throw new Error(`Conflicting block identity: ${id}`);
    if (!existing) { this.blocks.set(id, { kind, messageId }); events.push({ type: "block.start", id, kind, messageId }); }
    return events;
  }
  delta(id: string, value: string, kind: "text" | "reasoning" = "text", messageId = this.id): CanonicalEvent[] {
    return [...this.block(id, kind, messageId), ...(value ? [{ type: "block.delta" as const, id, text: value }] : [])];
  }
  endBlock(id: string): CanonicalEvent[] {
    if (!this.blocks.delete(id)) throw new Error(`Unknown or already closed block: ${id}`);
    return [{ type: "block.end", id }];
  }
  tool(id: string, name: string, messageId = this.id): CanonicalEvent[] {
    const events = this.start();
    if (this.tools.has(id)) throw new Error(`Duplicate active tool call: ${id}`);
    this.tools.set(id, { name, messageId }); events.push({ type: "tool.start", id, name, messageId }); return events;
  }
  toolDelta(id: string, value: string): CanonicalEvent[] {
    if (!this.tools.has(id)) throw new Error(`Tool delta without start: ${id}`);
    return value ? [{ type: "tool.delta", id, text: value }] : [];
  }
  endTool(id: string): CanonicalEvent[] {
    if (!this.tools.delete(id)) throw new Error(`Unknown or already closed tool call: ${id}`);
    return [{ type: "tool.end", id }];
  }
  closeContent(): CanonicalEvent[] {
    return [...[...this.blocks.keys()].flatMap(id => this.endBlock(id)), ...[...this.tools.keys()].flatMap(id => this.endTool(id))];
  }
  end(reason = "stop"): CanonicalEvent[] {
    if (this.ended) throw new Error("Duplicate run completion.");
    const events = [...this.start(), ...this.closeContent(), { type: "run.end" as const, reason }];
    this.ended = true; return events;
  }
  finish(): CanonicalEvent[] {
    if (this.started && !this.ended) throw new Error("Incomplete source stream: missing terminal event.");
    return [];
  }
}
export async function unsupported(context: Context, event: unknown, reason = "Event has no supported mapping."): Promise<CanonicalEvent[]> {
  await context.unsupported(event, reason); return [];
}

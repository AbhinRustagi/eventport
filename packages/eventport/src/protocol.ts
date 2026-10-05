import type {
  AGUIEvent,
  EventType,
  RunFinishedEvent,
  ToolCallResultEvent,
} from "@ag-ui/core";

export interface Usage {
  input?: number;
  output?: number;
  total?: number;
  details?: unknown;
}
export interface BlockMetadata {
  id: string;
  namespace: string;
  value: Record<string, unknown>;
}
export interface Interaction {
  id: string;
  toolCallId?: string;
  kind: "approval" | "question";
  payload: unknown;
}
export const usageEvent = (value: Usage): AGUIEvent => ({
  type: "CUSTOM" as EventType.CUSTOM,
  name: "eventport.usage",
  value,
});
export const metadataEvent = (value: BlockMetadata): AGUIEvent => ({
  type: "CUSTOM" as EventType.CUSTOM,
  name: "eventport.block-metadata",
  value,
});
export const interactionEvent = (value: Interaction): AGUIEvent => ({
  type: "CUSTOM" as EventType.CUSTOM,
  name: "eventport.interaction.requested",
  value,
});
function extension(
  e: AGUIEvent,
  name: string,
): Record<string, unknown> | undefined {
  if (e.type !== "CUSTOM" || e.name !== name) return;
  if (!e.value || typeof e.value !== "object" || Array.isArray(e.value))
    throw new TypeError(`Invalid ${name} extension.`);
  return e.value;
}
export function readUsage(e: AGUIEvent): Usage | undefined {
  if (e.type === "RUN_FINISHED" && e.usage?.length) {
    return e.usage.reduce<Usage>(
      (sum, usage) => ({
        input: (sum.input ?? 0) + (usage.inputTokens ?? 0),
        output: (sum.output ?? 0) + (usage.outputTokens ?? 0),
        total:
          (sum.total ?? 0) +
          (usage.totalTokens ??
            (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
      }),
      {},
    );
  }
  const value = extension(e, "eventport.usage");
  if (!value) return;
  for (const key of ["input", "output", "total"])
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" || !Number.isFinite(value[key]))
    )
      throw new TypeError("Invalid eventport.usage extension.");
  return value;
}
export function readMetadata(e: AGUIEvent): BlockMetadata | undefined {
  const value = extension(e, "eventport.block-metadata");
  if (!value) return;
  if (
    typeof value.id !== "string" ||
    typeof value.namespace !== "string" ||
    !value.value ||
    typeof value.value !== "object" ||
    Array.isArray(value.value)
  )
    throw new TypeError("Invalid eventport.block-metadata extension.");
  return {
    id: value.id,
    namespace: value.namespace,
    value: value.value as Record<string, unknown>,
  };
}
export function readInteraction(e: AGUIEvent): Interaction | undefined {
  const value = extension(e, "eventport.interaction.requested");
  if (!value) return;
  if (
    typeof value.id !== "string" ||
    !["approval", "question"].includes(String(value.kind)) ||
    (value.toolCallId !== undefined && typeof value.toolCallId !== "string")
  )
    throw new TypeError("Invalid eventport.interaction.requested extension.");
  return {
    id: value.id,
    kind: value.kind as Interaction["kind"],
    toolCallId: value.toolCallId as string | undefined,
    payload: value.payload,
  };
}
export function finishReason(e: RunFinishedEvent): string {
  if (e.outcome?.type === "cancelled") return "aborted";
  return typeof e.metadata?.eventport?.finishReason === "string"
    ? e.metadata.eventport.finishReason
    : e.outcome?.type === "interrupt"
      ? "waiting"
      : "stop";
}
export function toolResult(
  id: string,
  output: unknown,
  isError = false,
): ToolCallResultEvent {
  return {
    type: "TOOL_CALL_RESULT" as EventType.TOOL_CALL_RESULT,
    toolCallId: id,
    messageId: `result_${id}`,
    role: "tool",
    content: typeof output === "string" ? output : JSON.stringify(output),
    metadata: { eventport: { output, isError } },
  };
}
export function resultValue(e: ToolCallResultEvent): unknown {
  const data = e.metadata?.eventport;
  return data && Object.hasOwn(data, "output") ? data.output : e.content;
}
export const resultIsError = (e: ToolCallResultEvent): boolean =>
  e.metadata?.eventport?.isError === true;

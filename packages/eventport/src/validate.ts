import type { CanonicalEvent } from "./types.js";
import { parseArguments } from "./internal.js";
import { readInteraction, readMetadata, readUsage } from "./protocol.js";

/** Validate AG-UI relationships without flattening protocol-specific fields. */
export function eventValidator(): (event: CanonicalEvent) => void {
  let started = false,
    ended = false;
  let runId: string, threadId: string;
  const blocks = new Map<string, "text" | "reasoning">();
  const tools = new Map<string, string>();
  const completedTools = new Set<string>();
  const checkApproval = (kind: string, toolCallId?: string) => {
    if (kind === "approval" && toolCallId && !completedTools.has(toolCallId))
      throw new Error("Approval references a tool without completed input.");
  };
  return (event) => {
    if (ended)
      throw new Error(`Event ${event.type} received after terminal event.`);
    if (event.type === "RUN_ERROR") {
      ended = true;
      return;
    }
    if (event.type === "RUN_STARTED") {
      if (started) throw new Error("Duplicate run start.");
      if (!event.runId || !event.threadId)
        throw new Error("Run requires threadId and runId.");
      started = true;
      runId = event.runId;
      threadId = event.threadId;
      return;
    }
    if (!started && !readUsage(event))
      throw new Error(`${event.type} received before run start.`);
    const metadata = readMetadata(event);
    if (metadata && !blocks.has(metadata.id))
      throw new Error("Block metadata without start.");
    const interaction = readInteraction(event);
    if (interaction) checkApproval(interaction.kind, interaction.toolCallId);
    switch (event.type) {
      case "TEXT_MESSAGE_START":
      case "REASONING_MESSAGE_START":
        if (!event.messageId || blocks.has(event.messageId))
          throw new Error("Invalid or duplicate block start.");
        blocks.set(
          event.messageId,
          event.type === "TEXT_MESSAGE_START" ? "text" : "reasoning",
        );
        break;
      case "TEXT_MESSAGE_CONTENT":
      case "REASONING_MESSAGE_CONTENT":
        if (
          blocks.get(event.messageId) !==
            (event.type === "TEXT_MESSAGE_CONTENT" ? "text" : "reasoning") ||
          typeof event.delta !== "string"
        )
          throw new Error("Invalid content delta or missing block start.");
        break;
      case "TEXT_MESSAGE_END":
      case "REASONING_MESSAGE_END":
        if (
          blocks.get(event.messageId) !==
            (event.type === "TEXT_MESSAGE_END" ? "text" : "reasoning") ||
          !blocks.delete(event.messageId)
        )
          throw new Error("Block end without start or mismatched kind.");
        break;
      case "TOOL_CALL_START":
        if (
          !event.toolCallId ||
          !event.toolCallName ||
          tools.has(event.toolCallId)
        )
          throw new Error("Invalid or duplicate active tool identity.");
        tools.set(event.toolCallId, "");
        completedTools.delete(event.toolCallId);
        break;
      case "TOOL_CALL_ARGS": {
        const input = tools.get(event.toolCallId);
        if (input === undefined || typeof event.delta !== "string")
          throw new Error("Invalid tool delta or missing start.");
        tools.set(event.toolCallId, input + event.delta);
        break;
      }
      case "TOOL_CALL_END": {
        const input = tools.get(event.toolCallId);
        if (input === undefined) throw new Error("Tool end without start.");
        parseArguments(input);
        tools.delete(event.toolCallId);
        completedTools.add(event.toolCallId);
        break;
      }
      case "TOOL_CALL_RESULT":
        if (!completedTools.has(event.toolCallId))
          throw new Error(
            "Tool result has no completed input in this conversion.",
          );
        break;
      case "RUN_FINISHED":
        if (event.runId !== runId || event.threadId !== threadId)
          throw new Error("Run completion identity does not match its start.");
        if (blocks.size || tools.size)
          throw new Error("Run ended with open content.");
        if (event.outcome?.type === "interrupt")
          for (const i of event.outcome.interrupts)
            checkApproval(i.reason, i.toolCallId);
        ended = true;
        break;
    }
  };
}

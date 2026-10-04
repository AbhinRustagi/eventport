import type { CanonicalEvent } from "./types.js";
import { parseArguments } from "./internal.js";

/** Validate relationships, not just the shape of individual events. */
export function eventValidator(): (event: CanonicalEvent) => void {
  let started = false,
    ended = false;
  const blocks = new Set<string>();
  const tools = new Map<string, string>();
  const completedTools = new Set<string>();
  return (event) => {
    if (ended)
      throw new Error(`Event ${event.type} received after terminal event.`);
    if (event.type === "error") {
      ended = true;
      return;
    }
    if (event.type === "run.start") {
      if (started) throw new Error("Duplicate run start.");
      started = true;
      return;
    }
    // Usage can precede content (provider-only usage chunks).
    if (!started && event.type !== "usage")
      throw new Error(`${event.type} received before run start.`);
    switch (event.type) {
      case "block.start":
        if (blocks.has(event.id)) throw new Error("Duplicate block start.");
        blocks.add(event.id);
        break;
      case "block.delta":
        if (!blocks.has(event.id) || typeof event.text !== "string")
          throw new Error("Invalid content delta or missing block start.");
        break;
      case "block.metadata":
        if (!blocks.has(event.id))
          throw new Error("Block metadata without start.");
        break;
      case "block.end":
        if (!blocks.delete(event.id))
          throw new Error("Block end without start.");
        break;
      case "tool.start":
        if (!event.id || !event.name || tools.has(event.id))
          throw new Error("Invalid or duplicate active tool identity.");
        tools.set(event.id, "");
        completedTools.delete(event.id);
        break;
      case "tool.delta": {
        const input = tools.get(event.id);
        if (input === undefined || typeof event.text !== "string")
          throw new Error("Invalid tool delta or missing start.");
        tools.set(event.id, input + event.text);
        break;
      }
      case "tool.end": {
        const input = tools.get(event.id);
        if (input === undefined) throw new Error("Tool end without start.");
        parseArguments(input);
        tools.delete(event.id);
        completedTools.add(event.id);
        break;
      }
      case "tool.result":
        if (!completedTools.has(event.id))
          throw new Error(
            "Tool result has no completed input in this conversion.",
          );
        break;
      case "interaction.requested":
        if (
          event.kind === "approval" &&
          event.toolCallId &&
          !completedTools.has(event.toolCallId)
        )
          throw new Error(
            "Approval references a tool without completed input.",
          );
        break;
      case "run.end":
        if (blocks.size || tools.size)
          throw new Error("Run ended with open content.");
        ended = true;
        break;
    }
  };
}

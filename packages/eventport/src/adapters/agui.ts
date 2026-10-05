import type { Adapter } from "../types.js";
import { readUsage } from "../protocol.js";
import type { Usage } from "../protocol.js";
import { key, sse, unsupported } from "../internal.js";
import type { AGUIEvent, Interrupt } from "@ag-ui/core";
export type {
  AGUIEvent,
  Interrupt,
  RunFinishedEvent,
  ToolCallResultEvent,
} from "@ag-ui/core";
export type AGUIInterrupt = Interrupt;

export interface AGUIOptions {
  threadId: string;
  runId: string;
}
/** AG-UI is already the internal protocol; preserve its native fields. */
export function agUI(options: AGUIOptions): Adapter<AGUIEvent> {
  if (!options.threadId || !options.runId)
    throw new TypeError("agUI requires nonempty threadId and runId.");
  return {
    name: "ag-ui",
    key,
    wire: { frame: sse },
    decoder(context) {
      let started = false,
        ended = false;
      return {
        async push(e) {
          if (!Object.hasOwn(eventTypes, e.type))
            return unsupported(context, e);
          if (e.type === "RUN_STARTED") started = true;
          if (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR") ended = true;
          return [e];
        },
        finish() {
          if (started && !ended)
            throw new Error(
              "Incomplete source stream: missing terminal event.",
            );
          return [];
        },
      };
    },
    encoder() {
      let usage: Usage | undefined;
      return {
        push(e) {
          usage = readUsage(e) ?? usage;
          if (e.type === "RUN_FINISHED" && usage && !e.usage)
            return [
              {
                ...e,
                ...options,
                usage: [
                  {
                    inputTokens: usage.input,
                    outputTokens: usage.output,
                    totalTokens:
                      usage.total ?? (usage.input ?? 0) + (usage.output ?? 0),
                  },
                ],
              },
            ];
          return [
            e.type === "RUN_STARTED" || e.type === "RUN_FINISHED"
              ? { ...e, ...options }
              : e,
          ];
        },
        finish: () => [],
      };
    },
  };
}
// Kept as strings so importing the adapter never loads the SDK at runtime.
const eventTypes = {
  RUN_STARTED: true,
  RUN_FINISHED: true,
  RUN_ERROR: true,
  STEP_STARTED: true,
  STEP_FINISHED: true,
  TEXT_MESSAGE_START: true,
  TEXT_MESSAGE_CONTENT: true,
  TEXT_MESSAGE_END: true,
  TEXT_MESSAGE_CHUNK: true,
  REASONING_START: true,
  REASONING_END: true,
  REASONING_MESSAGE_START: true,
  REASONING_MESSAGE_CONTENT: true,
  REASONING_MESSAGE_END: true,
  REASONING_MESSAGE_CHUNK: true,
  REASONING_ENCRYPTED_VALUE: true,
  TOOL_CALL_START: true,
  TOOL_CALL_ARGS: true,
  TOOL_CALL_END: true,
  TOOL_CALL_CHUNK: true,
  TOOL_CALL_RESULT: true,
  STATE_SNAPSHOT: true,
  STATE_DELTA: true,
  MESSAGES_SNAPSHOT: true,
  ACTIVITY_SNAPSHOT: true,
  ACTIVITY_DELTA: true,
  SUBAGENT_STARTED: true,
  SUBAGENT_FINISHED: true,
  SUBAGENT_ERROR: true,
  CUSTOM: true,
  RAW: true,
} satisfies Record<`${AGUIEvent["type"]}`, true>;

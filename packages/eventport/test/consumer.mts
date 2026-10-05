import { eventport } from "eventport";
import { responses, type ResponsesEvent } from "eventport/openai";
import { agUI } from "eventport/agui";
import { langGraph } from "eventport/langgraph";
const source: ResponsesEvent[] = [];
const converted = eventport
  .convert(source)
  .from(responses(), {
    middleware: {
      "response.output_text.delta": (event) => {
        const delta: string = event.delta;
        // @ts-expect-error Source middleware is narrowed to this event.
        event.response;
        return { ...event, delta };
      },
      // @ts-expect-error Wrong protocol's event key.
      TEXT_MESSAGE_CONTENT: (e) => e,
    },
  })
  .to(agUI({ threadId: "t", runId: "r" }), {
    middleware: {
      TEXT_MESSAGE_CONTENT: (e) => ({ ...e, delta: e.delta.toUpperCase() }),
    },
  });
for await (const e of converted)
  if (e.type === "TEXT_MESSAGE_CONTENT") {
    const delta: string = e.delta;
  }
// @ts-expect-error AG-UI config is required.
agUI();
// @ts-expect-error LangGraph is input-only.
eventport.convert(source).from(responses()).to(langGraph());
eventport.convert(source).from(responses(), {
  middleware: {
    // @ts-expect-error Void-returning middleware must be rejected.
    "response.output_text.delta": () => {},
  },
});
// New native SDK event variants are accepted and diagnosed at runtime.
const native: AsyncIterable<{ type: string; [key: string]: unknown }> =
  (async function* () {
    yield { type: "future" };
  })();
eventport
  .convert(native)
  .from(responses())
  .to(agUI({ threadId: "t", runId: "r" }));

import { chatCompletions, type ChatCompletionChunk } from "eventport/openai";
import { anthropic, type AnthropicEvent } from "eventport/anthropic";
import { aiSDK, type AISDKEvent } from "eventport/vercel";
const cc: ChatCompletionChunk[] = await eventport
  .convert(source)
  .from(responses())
  .to(chatCompletions())
  .collect();
const claude: AnthropicEvent[] = await eventport
  .convert(source)
  .from(responses())
  .to(anthropic())
  .collect();
const ui: AISDKEvent[] = await eventport
  .convert(source)
  .from(responses())
  .to(aiSDK())
  .collect();
eventport
  .convert(source)
  .from(responses(), {
    middleware: {
      "response.audio.delta": (event) => {
        const delta: string = event.delta;
        return event;
      },
    },
  })
  .to(aiSDK());
// @ts-expect-error Upstream chunk requires created and model.
const invalid: ChatCompletionChunk = {
  id: "x",
  object: "chat.completion.chunk",
  choices: [],
};

// Override keys and inputs come from the source; results come from the target.
eventport
  .convert([])
  .from(responses())
  .to(aiSDK(), {
    overrides: {
      "response.output_text.delta": (event) =>
        event.delta
          ? { type: "text-delta", id: "text", delta: event.delta }
          : eventport.DEFAULT,
      // @ts-expect-error This is a destination event name, not a Responses event key.
      "text-delta": () => null,
    },
  });
eventport
  .convert([])
  .from(responses())
  .to(aiSDK(), {
    overrides: {
      // @ts-expect-error Responses events cannot be returned as AI SDK destination events.
      "response.output_text.delta": (event) => event,
    },
  });
eventport
  .convert([])
  .from(responses())
  .to(aiSDK(), {
    overrides: {
      // @ts-expect-error Overrides cannot return void.
      "response.output_text.delta": () => {},
    },
  });

const reusable = eventport
  .from(responses())
  .middleware({
    "response.output_text.delta": (e) => ({
      ...e,
      delta: e.delta.toUpperCase(),
    }),
  })
  .to(aiSDK())
  .middleware({ "text-delta": (e) => ({ ...e, delta: e.delta }) })
  .overrides({
    "response.output_text.delta": (e) =>
      e.delta ? { type: "data-custom", data: e.delta } : eventport.DEFAULT,
  });
const fluentOutput: AISDKEvent[] = await reusable.convert(source).collect();
reusable.overrides({
  // @ts-expect-error Overrides use source keys, not target keys.
  "text-delta": () => null,
});
reusable.overrides({
  // @ts-expect-error Must return target events.
  "response.output_text.delta": (e) => e,
});
reusable.middleware({
  // @ts-expect-error Middleware after to() uses target keys.
  "response.output_text.delta": (e) => e,
});
// @ts-expect-error Overrides require a destination adapter.
eventport.from(responses()).overrides({});
// @ts-expect-error Responses input must contain native event objects.
reusable.convert([42]);

// The shared adapter protocol is the bundled upstream AG-UI event union.
import type { AGUIEvent, CanonicalEvent } from "eventport";
type Assert<T extends true> = T;
type SharedProtocol = Assert<
  AGUIEvent extends CanonicalEvent
    ? CanonicalEvent extends AGUIEvent
      ? true
      : false
    : false
>;

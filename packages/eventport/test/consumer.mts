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
eventport
  .convert(source)
  .from(responses(), {
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

import { eventport } from "eventport";
import { responses } from "eventport/openai";
import { agUI } from "eventport/agui";
import { samples } from "./samples.mjs";

const events = await eventport
  .from(responses())
  .middleware({
    "response.output_text.delta": (event) => ({
      ...event,
      delta: event.delta.toUpperCase(),
    }),
  })
  .to(agUI({ threadId: "example-thread", runId: "example-run" }))
  .convert(samples.responses)
  .collect();

console.log(JSON.stringify(events, null, 2));

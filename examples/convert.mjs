import { eventport } from '../dist/index.js';
import { responses } from '../dist/adapters/openi.js';
import { agUI } from '../dist/adapters/agui.js';
import { samples } from '../playground/samples.mjs';

const events = await eventport
  .convert(samples.responses)
  .from(responses(), {
    middleware: {
      'response.output_text.delta': event => ({ ...event, delta: event.delta.toUpperCase() }),
    },
  })
  .to(agUI({ threadId: 'example-thread', runId: 'example-run' }))
  .collect();

console.log(JSON.stringify(events, null, 2));

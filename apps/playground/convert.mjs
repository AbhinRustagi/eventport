import { eventport } from 'eventport';
import { responses } from 'eventport/openi';
import { agUI } from 'eventport/agui';
import { samples } from './samples.mjs';

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

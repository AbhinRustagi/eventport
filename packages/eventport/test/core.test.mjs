import assert from "node:assert/strict";
import { test } from "node:test";
import { eventport, UnsupportedEventError } from "eventport";
import { responses } from "eventport/openai";
import { aiSDK } from "eventport/vercel";
import { samples } from "./fixtures/streams.mjs";
import { text } from "./helpers.mjs";
const convert = (input = samples.responses, options, hooks) =>
  eventport.convert(input, options).from(responses(), hooks).to(aiSDK());

test("async middleware can expand and drop events; observers see transformed output", async () => {
  const observed = [];
  const output = await convert(undefined, undefined, {
    middleware: {
      "response.output_text.delta": async (e) =>
        e.delta === "Eventport."
          ? null
          : [
              { ...e, delta: "A" },
              { ...e, delta: "B" },
            ],
    },
    observe: (e) => observed.push(e),
  }).collect();
  assert.equal(text(output), "AB");
  assert.deepEqual(
    observed
      .filter((e) => e.type === "response.output_text.delta")
      .map((e) => e.delta),
    ["A", "B"],
  );
});
test("destination middleware and observer receive native target events", async () => {
  const seen = [];
  const output = await eventport
    .convert(samples.responses)
    .from(responses())
    .to(aiSDK(), {
      middleware: {
        "text-delta": (e) => ({ ...e, delta: e.delta.toUpperCase() }),
      },
      observe: (e) => seen.push(e),
    })
    .collect();
  assert.equal(text(output), "HELLO FROM EVENTPORT.");
  assert.deepEqual(seen, output);
});
test("unknown events fail with a structured diagnostic or can be explicitly dropped", async () => {
  const unknown = { type: "future.event" };
  await assert.rejects(
    () => convert([unknown]).collect(),
    (e) =>
      e instanceof UnsupportedEventError &&
      e.diagnostic.stage === "decode" &&
      e.diagnostic.event === unknown,
  );
  const seen = [];
  const output = await convert([unknown, ...samples.responses])
    .onUnsupported(async (d) => {
      seen.push(d);
      return "drop";
    })
    .collect();
  assert.equal(text(output), "Hello from Eventport.");
  assert.equal(seen.length, 1);
});
test("truncated provider input fails instead of synthesizing a successful finish", async () => {
  await assert.rejects(
    () => convert(samples.responses.slice(0, 4)).collect(),
    /Incomplete source stream/,
  );
});
test("void middleware and failed observers terminate conversion", async () => {
  await assert.rejects(
    () =>
      convert(undefined, undefined, {
        middleware: { "response.output_text.delta": () => {} },
      }).collect(),
    /undefined/,
  );
  const failure = new Error("observer failed");
  await assert.rejects(
    () =>
      convert(undefined, undefined, {
        observe: () => {
          throw failure;
        },
      }).collect(),
    (e) => e === failure,
  );
});
test("conversion is lazy and single use", async () => {
  let reads = 0;
  const input = {
    *[Symbol.iterator]() {
      for (const event of samples.responses) {
        reads++;
        yield event;
      }
    },
  };
  const output = convert(input);
  assert.equal(reads, 0);
  await output.collect();
  assert.equal(reads, samples.responses.length);
  await assert.rejects(() => output.collect(), /single-use/);
});
test("abort before consumption never reads input", async () => {
  let reads = 0;
  const controller = new AbortController();
  controller.abort();
  const input = {
    *[Symbol.iterator]() {
      reads++;
      yield* samples.responses;
    },
  };
  await assert.rejects(() =>
    convert(input, { signal: controller.signal }).collect(),
  );
  assert.equal(reads, 0);
});
test(
  "abort interrupts an outstanding input read",
  { timeout: 2000 },
  async () => {
    let started;
    const reading = new Promise((resolve) => (started = resolve));
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const input = {
      async *[Symbol.asyncIterator]() {
        started();
        await new Promise(() => {});
      },
    };
    const pending = convert(input, { signal: controller.signal }).collect();
    await reading;
    controller.abort(reason);
    await assert.rejects(
      () => pending,
      (e) => e === reason,
    );
  },
);
test("cancelling output cancels the readable input", async () => {
  let cancelled = false;
  const input = new ReadableStream({
    pull(c) {
      c.enqueue(samples.responses[0]);
    },
    cancel() {
      cancelled = true;
    },
  });
  const reader = convert(input).toReadableStream().getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(cancelled, true);
  assert.equal(input.locked, false);
});
test("breaking async iteration closes the input generator", async () => {
  let closed = false;
  const input = (async function* () {
    try {
      yield* samples.responses;
    } finally {
      closed = true;
    }
  })();
  for await (const event of convert(input)) {
    assert.equal(event.type, "start");
    break;
  }
  assert.equal(closed, true);
});
test("streaming response propagates conversion errors to body consumption", async () => {
  const response = convert([{ type: "future.event" }]).toResponse();
  await assert.rejects(() => response.text(), UnsupportedEventError);
});

test("overrides replace source output, preserve state, and pass through target hooks", async () => {
  const seen = [];
  const result = await eventport
    .convert(samples.responses)
    .from(responses(), {
      middleware: {
        "response.output_text.delta": (e) => ({
          ...e,
          delta: e.delta.toUpperCase(),
        }),
      },
    })
    .to(aiSDK(), {
      overrides: {
        "response.output_text.delta": async (e) => [
          { type: "data-custom", data: e.delta },
        ],
      },
      middleware: {
        "data-custom": (e) => ({ ...e, data: `mapped:${e.data}` }),
      },
      observe: (e) => seen.push(e),
    })
    .collect();
  assert.equal(text(result), "");
  assert.deepEqual(
    result.filter((e) => e.type === "data-custom").map((e) => e.data),
    ["mapped:HELLO FROM ", "mapped:EVENTPORT."],
  );
  assert.ok(result.some((e) => e.type === "text-end"));
  assert.ok(result.some((e) => e.type === "finish"));
  assert.deepEqual(seen, result);
});
test("overrides support default fallback and null suppression", async () => {
  const result = await eventport
    .convert(samples.responses)
    .from(responses())
    .to(aiSDK(), {
      overrides: {
        "response.output_text.delta": (e) =>
          e.delta === "Eventport." ? eventport.DEFAULT : null,
      },
    })
    .collect();
  assert.equal(text(result), "Eventport.");
});
test("overrides handle unsupported source events without changing the global policy", async () => {
  const result = await eventport
    .convert([{ type: "app.custom" }, ...samples.responses])
    .from(responses())
    .to(aiSDK(), {
      overrides: {
        "app.custom": () => ({ type: "data-custom", data: "handled" }),
      },
    })
    .collect();
  assert.equal(result[0].type, "data-custom");
  await assert.rejects(
    eventport
      .convert([{ type: "app.custom" }])
      .from(responses())
      .to(aiSDK(), {
        overrides: { "app.custom": () => eventport.DEFAULT },
      })
      .collect(),
    UnsupportedEventError,
  );
});
test("void and throwing overrides fail; pending overrides are abortable", async () => {
  for (const handler of [
    () => undefined,
    () => {
      throw new Error("override failed");
    },
  ]) {
    await assert.rejects(
      eventport
        .convert(samples.responses)
        .from(responses())
        .to(aiSDK(), {
          overrides: { "response.created": handler },
        })
        .collect(),
    );
  }
  const controller = new AbortController();
  const result = eventport
    .convert(samples.responses, { signal: controller.signal })
    .from(responses())
    .to(aiSDK(), {
      overrides: {
        "response.created": () => {
          controller.abort(new Error("cancel override"));
          return new Promise(() => {});
        },
      },
    })
    .collect();
  await assert.rejects(result, /cancel override/);
});

test("fluent converters are reusable and derived configurations are isolated", async () => {
  const base = eventport.from(responses()).to(aiSDK());
  const changed = base.middleware({
    "text-delta": (e) => ({ ...e, delta: e.delta.toUpperCase() }),
  });
  const overridden = base.overrides({
    "response.output_text.delta": (e) => ({
      type: "data-custom",
      data: e.delta,
    }),
  });
  const [a, b, c, d] = await Promise.all([
    base.convert(samples.responses).collect(),
    changed.convert(samples.responses).collect(),
    overridden.convert(samples.responses).collect(),
    base.convert(samples.responses).collect(),
  ]);
  assert.equal(text(a), "Hello from Eventport.");
  assert.equal(text(b), "HELLO FROM EVENTPORT.");
  assert.equal(text(c), "");
  assert.equal(text(d), text(a));
});
test("fluent source and destination middleware surround overrides in order", async () => {
  const calls = [];
  const source = eventport.from(responses());
  const converter = source
    .middleware({
      "response.output_text.delta": (e) => ({
        ...e,
        delta: e.delta.toUpperCase(),
      }),
    })
    .observe((e) => {
      if (e.type === "response.output_text.delta")
        calls.push(`source:${e.delta}`);
    })
    .to(aiSDK())
    .overrides({
      "response.output_text.delta": (e) => ({
        type: "data-custom",
        data: e.delta,
      }),
    })
    .middleware({ "data-custom": (e) => ({ ...e, data: `target:${e.data}` }) })
    .observe((e) => {
      if (e.type === "data-custom") calls.push(e.data);
    });
  await converter.convert(samples.responses).collect();
  assert.deepEqual(calls, [
    "source:HELLO FROM ",
    "target:HELLO FROM ",
    "source:EVENTPORT.",
    "target:EVENTPORT.",
  ]);
  assert.equal(
    text(await source.to(aiSDK()).convert(samples.responses).collect()),
    "Hello from Eventport.",
  );
});
test("fluent override fallback, suppression and policy do not mutate their base", async () => {
  const base = eventport.from(responses()).to(aiSDK());
  const modified = base.overrides({
    "response.output_text.delta": (e) =>
      e.delta === "Eventport." ? eventport.DEFAULT : null,
  });
  assert.equal(
    text(await modified.convert(samples.responses).collect()),
    "Eventport.",
  );
  const input = [{ type: "unknown" }, ...samples.responses];
  assert.equal(
    text(await base.onUnsupported("drop").convert(input).collect()),
    "Hello from Eventport.",
  );
  await assert.rejects(base.convert(input).collect(), UnsupportedEventError);
});
test("overrides cannot bypass malformed lifecycle state", async () => {
  await assert.rejects(
    eventport
      .from(aiSDK())
      .to(aiSDK())
      .overrides({ "text-delta": () => null })
      .convert([{ type: "text-delta", id: "missing", delta: "bad" }])
      .collect(),
    /without start/,
  );
});

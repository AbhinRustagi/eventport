"use client";

import { useMemo, useRef, useState } from "react";
import { AssistantRuntimeProvider, useAuiState } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/ai-sdk";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { Button } from "@/components/ui/button";
import { protocols } from "@/lib/protocols.mjs";

type Protocol = keyof typeof protocols;
type Trace = {
  stage: "source" | "output" | "unsupported";
  protocol: Protocol;
  event: Record<string, unknown>;
};
const routes: Record<Protocol, string> = {
  responses: "OpenAI → Responses → Vercel UI stream",
  "chat-completions": "OpenAI → Chat Completions → Vercel UI stream",
  anthropic: "Anthropic → Messages → Vercel UI stream",
  agui: "OpenAI Responses → AG-UI → Vercel UI stream",
  "ai-sdk": "OpenAI via AI SDK → Vercel UI stream",
  langgraph: "LangGraph deployment → Vercel UI stream",
};

function Workspace({
  protocol,
  setProtocol,
  traces,
  onReset,
}: {
  protocol: Protocol;
  setProtocol: (p: Protocol) => void;
  traces: Trace[];
  onReset: () => void;
}) {
  const running = useAuiState((s) => s.thread.isRunning);
  const [stage, setStage] = useState<Trace["stage"]>("source");
  const config = protocols[protocol];
  const visible = traces.filter((t) => t.stage === stage);
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground lg:h-dvh">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold">
            Eventport{" "}
            <span className="font-normal text-muted-foreground">
              / playground
            </span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live model streams, converted for assistant-ui.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor="protocol" className="text-sm">
            Source adapter
          </label>
          <select
            id="protocol"
            className="h-9 rounded-md border bg-background px-3 text-sm disabled:opacity-50"
            value={protocol}
            disabled={running}
            onChange={(e) => setProtocol(e.target.value as Protocol)}
          >
            {Object.entries(protocols).map(([key, p]) => (
              <option key={key} value={key}>
                {p.label}
              </option>
            ))}
          </select>
          <Button variant="outline" disabled={running} onClick={onReset}>
            New chat
          </Button>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_360px]">
        <main
          aria-label="Conversation"
          className="flex h-[75dvh] min-h-0 flex-col lg:h-auto"
        >
          <div className="border-b px-6 py-3 text-xs text-muted-foreground">
            {routes[protocol]}
          </div>
          <div className="min-h-0 flex-1">
            <Thread />
          </div>
        </main>
        <aside
          aria-label="Event inspector"
          className="flex min-h-0 flex-col border-t lg:border-t-0 lg:border-l"
        >
          <div className="border-b p-4">
            <h2 className="text-sm font-semibold">Event inspector</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Latest request · last {traces.length} events (up to 500)
            </p>
          </div>
          <details className="border-b p-4">
            <summary className="cursor-pointer text-sm">
              Conversion code
            </summary>
            <pre className="mt-3 overflow-x-auto text-xs leading-6">
              <code>{`import { eventport } from "eventport";\nimport { aiSDK } from "eventport/vercel";\n${protocol === "ai-sdk" ? "" : `import { ${config.factory.split("(")[0]} }\n  from "eventport/${config.path}";\n`}\neventport.convert(upstream)\n  .from(${config.factory})\n  .to(aiSDK());`}</code>
            </pre>
            {protocol === "agui" && (
              <p className="mt-3 text-xs text-muted-foreground">
                The server first converts the live OpenAI Responses stream to
                AG-UI.
              </p>
            )}
          </details>
          <div className="flex gap-1 border-b p-2" aria-label="Event stage">
            {(["source", "output", "unsupported"] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={stage === value ? "secondary" : "ghost"}
                aria-pressed={stage === value}
                onClick={() => setStage(value)}
              >
                {value === "output"
                  ? "Converted"
                  : value === "unsupported"
                    ? "Unsupported"
                    : "Source"}
              </Button>
            ))}
          </div>
          <div
            className="max-h-[60dvh] flex-1 overflow-auto p-3 lg:max-h-none"
            aria-label={`${stage} events`}
          >
            {!visible.length ? (
              <p className="p-4 text-sm text-muted-foreground">
                {stage === "unsupported"
                  ? "Events the selected conversion cannot represent will appear here."
                  : "Send a message to inspect the stream."}
              </p>
            ) : (
              visible.map((trace, index) => (
                <details key={index} className="border-b py-2">
                  <summary className="cursor-pointer break-all text-xs">
                    <span className="mr-2 text-muted-foreground">
                      {index + 1}
                    </span>
                    {String(
                      trace.event.type ??
                        trace.event.event ??
                        trace.event.object ??
                        trace.event.reason,
                    )}
                  </summary>
                  <pre className="mt-2 overflow-auto rounded bg-muted p-2 text-xs">
                    {JSON.stringify(trace.event, null, 2)}
                  </pre>
                </details>
              ))
            )}
          </div>
          <p className="border-t p-4 text-xs text-muted-foreground">
            API keys stay on the server. Text conversations are kept in this
            tab; reloading clears them.
          </p>
        </aside>
      </div>
    </div>
  );
}
export function Playground() {
  const [protocol, setProtocol] = useState<Protocol>("responses");
  const [session, setSession] = useState(0);
  return (
    <ChatSession
      key={session}
      protocol={protocol}
      setProtocol={setProtocol}
      onReset={() => setSession((n) => n + 1)}
    />
  );
}
function ChatSession(props: {
  protocol: Protocol;
  setProtocol: (p: Protocol) => void;
  onReset: () => void;
}) {
  const selected = useRef(props.protocol);
  selected.current = props.protocol;
  const [traces, setTraces] = useState<Trace[]>([]);
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/api/chat",
        body: () => ({ protocol: selected.current }),
        fetch: async (input, init) => {
          setTraces([]);
          const response = await fetch(input, init);
          if (!response.ok) {
            const body = await response
              .json()
              .catch(() => ({ error: "Request failed." }));
            throw new Error(body.error ?? "Request failed.");
          }
          return response;
        },
      }),
    [],
  );
  const runtime = useChatRuntime({
    transport,
    adapters: { attachments: undefined },
    onData: (part) => {
      if (part.type === "data-eventport-trace")
        setTraces((previous) => [...previous, part.data as Trace].slice(-500));
    },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Workspace {...props} traces={traces} />
    </AssistantRuntimeProvider>
  );
}

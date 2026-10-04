"use client";

import { useRef, useState } from "react";
import { AssistantRuntimeProvider, useAuiState } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/ai-sdk";
import { PanelLeftIcon } from "lucide-react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { ThreadList } from "@/components/assistant-ui/elements/thread-list.aui";
import { Button } from "@/components/ui/button";

import { protocols } from "@/lib/protocols.mjs";

type Protocol = keyof typeof protocols;

function ProtocolSelect({
  value,
  onChange,
}: {
  value: Protocol;
  onChange: (value: Protocol) => void;
}) {
  const running = useAuiState((s) => s.thread.isRunning);
  return (
    <div className="ml-auto flex items-center gap-2">
      <label htmlFor="protocol" className="text-sm text-muted-foreground">
        Protocol
      </label>
      <select
        id="protocol"
        value={value}
        disabled={running}
        onChange={(event) => onChange(event.target.value as Protocol)}
        className="h-8 max-w-48 rounded-md border bg-background px-2 text-sm disabled:opacity-50"
      >
        {Object.entries(protocols).map(([key, protocol]) => (
          <option key={key} value={key}>
            {protocol.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Assistant({
  initialProtocol = "responses",
}: {
  initialProtocol?: Protocol;
}) {
  const [protocol, setProtocol] = useState<Protocol>(initialProtocol);
  const selected = useRef(protocol);
  selected.current = protocol;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [transport] = useState(
    () =>
      new AssistantChatTransport({
        api: "/api/chat",
        body: () => ({ protocol: selected.current }),
        fetch: async (input, init) => {
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
  );
  const runtime = useChatRuntime({
    transport,
    adapters: { attachments: undefined },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-dvh bg-background">
        <aside
          aria-label="Conversations"
          id="conversations"
          className={`${sidebarOpen ? "flex" : "hidden"} w-60 shrink-0 flex-col border-r bg-muted/30 p-3 md:flex`}
        >
          <div className="px-3 py-4 text-sm font-semibold">Assistant</div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ThreadList />
          </div>
        </aside>
        <main aria-label="Chat" className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center border-b px-3">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Toggle conversations"
              aria-controls="conversations"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              <PanelLeftIcon className="size-4" />
            </Button>
            <span className="ml-2 text-sm font-medium md:hidden">
              Assistant
            </span>
            <ProtocolSelect value={protocol} onChange={setProtocol} />
          </header>
          <div className="min-h-0 flex-1">
            <Thread />
          </div>
        </main>
      </div>
    </AssistantRuntimeProvider>
  );
}

"use client";

import { useState } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/ai-sdk";
import { PanelLeftIcon } from "lucide-react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { ThreadList } from "@/components/assistant-ui/elements/thread-list.aui";
import { Button } from "@/components/ui/button";

export function Assistant() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [transport] = useState(
    () =>
      new AssistantChatTransport({
        api: "/api/chat",
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
          <header className="flex h-12 shrink-0 items-center border-b px-3 md:hidden">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle conversations"
              aria-controls="conversations"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              <PanelLeftIcon className="size-4" />
            </Button>
            <span className="ml-2 text-sm font-medium">Assistant</span>
          </header>
          <div className="min-h-0 flex-1">
            <Thread />
          </div>
        </main>
      </div>
    </AssistantRuntimeProvider>
  );
}

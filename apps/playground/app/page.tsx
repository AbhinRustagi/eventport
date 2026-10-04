import { Assistant } from "@/components/assistant";
import { protocols } from "@/lib/protocols.mjs";

export const dynamic = "force-dynamic";

export default function Page() {
  const configured = process.env.EVENTPORT_ADAPTER || "responses";
  const initialProtocol = Object.hasOwn(protocols, configured)
    ? (configured as keyof typeof protocols)
    : "responses";
  return <Assistant initialProtocol={initialProtocol} />;
}

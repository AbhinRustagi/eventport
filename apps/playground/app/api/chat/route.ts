import {
  RequestError,
  parseChat,
  openSource,
  convertedResponse,
} from "@/lib/chat.mjs";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== request.headers.get("host"))
        throw new Error("Origin mismatch");
    } catch {
      return Response.json(
        { error: "Cross-origin requests are not allowed." },
        { status: 403 },
      );
    }
  }
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new RequestError("Expected a JSON request.");
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 128_000) {
        await reader.cancel();
        throw new RequestError("Conversation is too large.", 413);
      }
      chunks.push(value);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new RequestError("Expected a JSON request.");
    }
    const input = parseChat(body);
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(120_000),
    ]);
    const source = await openSource({ ...input, signal });
    return convertedResponse({ ...input, ...source, signal });
  } catch (error) {
    if (error instanceof RequestError)
      return Response.json({ error: error.message }, { status: error.status });
    return Response.json(
      {
        error:
          "Unable to start the model stream. Check the server API key, model, and endpoint configuration.",
      },
      { status: 502 },
    );
  }
}

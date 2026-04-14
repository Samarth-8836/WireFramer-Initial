// Server-Sent Events helper for Next.js route handlers.
//
// Standardized event vocabulary used by every streaming API route in the
// system. The client-side SSE consumer (added in Sprint 3) dispatches by
// event.type so the contract here doubles as the wire format documentation.

export type SSEEventType =
  | "chunk"            // Text delta for chat — { text: string }
  | "document"         // Document created/updated — { type, content, version, ... }
  | "phase"            // Phase transition — { from, to, status }
  | "progress"         // Operation progress — { operationId, status, detail? }
  | "test_results"     // Test execution results — { totalTests, passed, failed, ... }
  | "drift"            // Drift detection result — { classification, type, reason }
  | "meta"             // One-off informational payload (config dump, role, ...)
  | "error"            // Error — { error: string, fatal?: boolean }
  | "complete";        // Stream finished — { ...optional summary }

export interface SSEEvent<T = unknown> {
  type: SSEEventType;
  data: T;
}

// Wraps a ReadableStream controller so route handlers can write typed events
// without dealing with TextEncoder + manual SSE framing each time.
export class SSEWriter {
  private encoder = new TextEncoder();
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private closed = false;

  // Build the underlying ReadableStream. Call exactly once; the returned
  // stream is what you pass to `new Response(stream, ...)` (or use
  // createSSEResponse() below for the headers too).
  createStream(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.closed = true;
        this.controller = null;
      },
    });
  }

  send<T>(event: SSEEvent<T>): void {
    if (this.closed || !this.controller) return;
    // SSE wire format: `event: TYPE\ndata: JSON\n\n`
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    try {
      this.controller.enqueue(this.encoder.encode(payload));
    } catch {
      // Controller already closed by the consumer; quietly stop accepting.
      this.closed = true;
      this.controller = null;
    }
  }

  // Convenience helpers — most routes only need these.
  sendChunk(text: string): void {
    this.send({ type: "chunk", data: { text } });
  }

  sendProgress(info: {
    operationId: string;
    status: string;
    detail?: string;
  }): void {
    this.send({ type: "progress", data: info });
  }

  sendDocument(doc: {
    type: string;
    content: string;
    version: number;
    [k: string]: unknown;
  }): void {
    this.send({ type: "document", data: doc });
  }

  sendError(error: string, fatal = false): void {
    this.send({ type: "error", data: { error, fatal } });
  }

  sendMeta<T>(data: T): void {
    this.send({ type: "meta", data });
  }

  sendComplete<T>(data?: T): void {
    this.send({ type: "complete", data: data ?? {} });
    this.close();
  }

  close(): void {
    if (this.closed || !this.controller) return;
    try {
      this.controller.close();
    } catch {
      // already closed
    }
    this.controller = null;
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

// Wrap an SSEWriter into a fully-formed SSE Response. Call this once and
// return it from the route handler.
export function createSSEResponse(writer: SSEWriter): Response {
  const stream = writer.createStream();
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

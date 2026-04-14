import type { SSEWriter } from "@core/operation-executor";

import type { Phase2Handlers } from "./session-manager";

// Placeholder Phase 2 handlers used by the Sprint 5 bootstrap so the
// SessionManager graph is complete. Every method emits a fatal SSE error
// explaining that Phase 2 is not yet implemented. Sprint 6 replaces this
// module with a real Phase2HandlersImpl wiring the auto-generation chain.

export class Phase2HandlersStub implements Phase2Handlers {
  async handleMessage(
    _sessionId: string,
    _message: string,
    _screenRef: string | null,
    sse: SSEWriter,
  ): Promise<void> {
    sse.sendError(
      "Phase 2 is not yet implemented — the auto-generation chain lands in Sprint 6.",
      true,
    );
    sse.close();
  }

  async completePhase(_sessionId: string, sse: SSEWriter): Promise<void> {
    sse.sendError("Phase 2 completion is not yet implemented.", true);
    sse.close();
  }
}

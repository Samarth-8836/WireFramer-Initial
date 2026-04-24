# UX Builder — Replication Instructions

A guide to rebuilding this project from scratch as a set of small, independent modules. Each module below can be developed, tested, and replaced in isolation. The contracts between modules are narrow and explicit.

## 0. What the product does (30 seconds)

A web app that turns one sentence ("I want to build a recipe sharing app") into a full product definition plus interactive wireframes plus automated tests — through a conversational, staged flow.

- **Phase 1 — Define.** Chat with the user, produce a **Project Contract** (goal, personas, entities, boundaries).
- **Phase 2 — Generate.** In four user-approved stages, produce:
  - **Design** — Workflow Map + Screen Inventory
  - **Wireframe** — static HTML prototype in an iframe
  - **Test Suite** — human-readable test cases
  - **Automated Tests** — executable test bundle

Every stage is gated by the user clicking **Approve**, so no single wait exceeds ~2 minutes.

## 1. Architecture at a glance

```
                                 ┌──────────────┐
                                 │    Browser   │
                                 │  (Next.js)   │
                                 └──────┬───────┘
                                        │ SSE stream (see §5.2)
                                        ▼
                                 ┌──────────────┐
                                 │  API Routes  │  (thin glue)
                                 └──────┬───────┘
                                        │
                     ┌──────────────────┴───────────────────┐
                     ▼                                      ▼
             ┌───────────────┐                      ┌───────────────┐
             │Session Manager│                      │   Storage     │
             │   (stages,    │◄─────────────────────┤  (sessions,   │
             │   routing)    │                      │  docs, chat)  │
             └───────┬───────┘                      └───────────────┘
                     │
         ┌───────────┼───────────┐
         ▼           ▼           ▼
    ┌────────┐ ┌─────────┐ ┌─────────┐
    │ Ops    │ │ Context │ │  DAG    │
    │ (2.1,  │ │ Builder │ │Executor │
    │  2.2..)│ └────┬────┘ └─────────┘
    └───┬────┘      │
        ▼           ▼
    ┌───────────────────────┐
    │  Operation Executor   │  (retries, token tracking, parsing)
    └───────────┬───────────┘
                ▼
          ┌─────────┐             ┌──────────┐
          │  LLM    │             │ Parsers  │
          │Provider │             │ (yaml,   │
          │(OpenRtr)│             │  json,   │
          └─────────┘             │  xml…)   │
                                  └──────────┘
                     ┌────────────────────────┐
                     │  Prompt Registry       │  (slug → string)
                     └────────────────────────┘
                     ┌────────────────────────┐
                     │  Streaming (SSEWriter) │
                     └────────────────────────┘
```

**Dependency direction** is strictly downward in that diagram. Every module knows nothing about modules above it. This is what makes them independent.

## 2. Tech stack & environment

- **Runtime:** Node 20+ (required by Next 16 + fetch streams)
- **Framework:** Next.js 16.2+ (app router), React 19, TypeScript 5, Tailwind 4
- **State:** Zustand (client), file-based storage (server — JSON files)
- **Markdown rendering:** react-markdown + remark-gfm
- **YAML parsing:** `yaml` package
- **Tests:** Vitest 4
- **LLM:** OpenRouter API, accessed directly via `fetch()` — **no SDK** by design

Env vars (loaded from `app/.env.local`):
```
OPENROUTER_API_KEY=sk-or-v1-...
LLM_MODEL_FAST=inclusionai/ling-2.6-1t:free
LLM_MODEL_REASONING=inclusionai/ling-2.6-1t:free
# Optional:
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

---

## 3. Module Catalog

The codebase is 13 modules. Each gets a ~one-page spec below: **purpose, dependencies, public API, example request/response**.

| # | Module | Purpose | Depends on |
|---|---|---|---|
| 1 | LLM Provider | Stream text from an LLM via native `fetch()` | — |
| 2 | Parsers | Raw LLM text → structured data | — |
| 3 | Prompt Registry | Slug → prompt string | — |
| 4 | Streaming (SSEWriter) | Wrap `ReadableStream` into SSE wire format | — |
| 5 | Storage | CRUD for sessions, documents, artifacts, messages | — |
| 6 | Operation Executor | Retries + parsing + tokens on top of LLM Provider | 1, 2, 4 |
| 7 | Context Builder | Assemble LLM context from Storage + Prompt Registry | 3, 5 |
| 8 | Operations | Business-logic ops (1.0–2.10), one function each | 3, 5, 6, 7 |
| 9 | Dependency Graph | Generic DAG executor with concurrency + conditions | — |
| 10 | Phase 2 Stage Machine | 4-stage state machine for gated Phase 2 | 5 |
| 11 | Session Manager | Routing + chat locking + phase transitions | 5, 8, 9, 10 |
| 12 | API Routes | HTTP → Session Manager; SSE streaming | 4, 5, 11 |
| 13 | UI (Zustand + React) | Chat / documents / phase indicator / stage approvals | 4 (wire format) |

---

### Module 1 — LLM Provider

**Purpose.** Given `(apiKey, model, systemPrompt, messages)`, stream text deltas. That's it. The whole rest of the system goes through this one function.

**Dependencies.** None (just `fetch()`).

**Files.**
- `core/llm/openrouter-client.ts` — the streaming implementation
- `core/llm/providers.ts` — env-driven resolver: `resolveModel(role) → {modelId}` + `getApiKey()`

**Public API.**

```typescript
type RoleName = "fast" | "reasoning";

interface ResolvedModel {
  role: RoleName;
  provider: "openrouter";
  modelId: string;    // e.g. "inclusionai/ling-2.6-1t:free"
}

function resolveModel(role: RoleName): ResolvedModel;
function getApiKey(): string | undefined;
function getBaseUrl(): string;

interface OpenRouterStreamOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: { role: "user" | "assistant" | "system"; content: string }[];
  signal?: AbortSignal;
  onChunk?: (delta: string) => void;
  baseUrl?: string;
}

interface OpenRouterStreamResult {
  fullText: string;
  inputTokens: number;
  outputTokens: number;
  errorMessage: string | null;
}

async function streamOpenRouter(
  opts: OpenRouterStreamOptions
): Promise<OpenRouterStreamResult>;
```

**Wire (what the module sends to OpenRouter):**

```
POST https://openrouter.ai/api/v1/chat/completions
Authorization: Bearer sk-or-v1-...
Content-Type: application/json
HTTP-Referer: https://your.app
X-Title: UX Builder

{
  "model": "inclusionai/ling-2.6-1t:free",
  "messages": [
    { "role": "system", "content": "You are a ..." },
    { "role": "user", "content": "I want to build a recipe app" }
  ],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

**What comes back** (SSE frames):

```
data: {"id":"r1","choices":[{"delta":{"content":"Hello"}}]}
data: {"id":"r1","choices":[{"delta":{"content":" world"}}]}
data: {"id":"r1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":42,"completion_tokens":8,"total_tokens":50}}
data: [DONE]
```

Plus occasional keep-alive comments like `: OPENROUTER PROCESSING` (which the parser ignores).

**Example usage:**

```typescript
const chunks: string[] = [];
const result = await streamOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: "inclusionai/ling-2.6-1t:free",
  systemPrompt: "You are a terse assistant.",
  messages: [{ role: "user", content: "Say hi" }],
  onChunk: (d) => chunks.push(d),
});
// result.fullText === "Hi!"
// chunks === ["Hi", "!"]
// result.inputTokens === 15, outputTokens === 2
// result.errorMessage === null (or a string like "OpenRouter HTTP 401: ...")
```

**Gotchas / things we actually hit:**
- SSE frames can be split across `reader.read()` boundaries. Buffer the text and split on `\n`, keeping the trailing partial line in the buffer.
- Always set `stream_options.include_usage: true` — without it, you don't get token counts.
- Parse malformed JSON lines silently (just skip them). Don't fail the whole stream over one bad line.
- HTTP errors carry useful info in the body — read `res.text()` on non-OK responses and include the first ~500 chars in the error.

---

### Module 2 — Parsers

**Purpose.** Pure functions from raw LLM text to structured data, each returning a uniform `ParseResult<T>`. Every AI call pairs with exactly one parser.

**Dependencies.** None (pure data transformation).

**Files.**
- `core/operation-executor/parsers.ts`

**Public API.**

```typescript
type ParseResult<T> =
  | { success: true;  data: T;      rawText: string }
  | { success: false; error: string; rawText: string };

function parseYAML(raw: string): ParseResult<unknown>;
function parseJSON(raw: string): ParseResult<unknown>;
function parsePlainText(raw: string): ParseResult<{ text: string }>;
function parseMarkdownSections(
  raw: string,
  expectedSections: string[]
): ParseResult<{ sections: Record<string, string>; fullMarkdown: string }>;

// Tag-extraction parsers — pull YAML from inside <generation_context> or
// <change_context> blocks and return both the visible prefix and the
// structured context.
function extractGenerationContext(raw: string): ParseResult<{
  visibleResponse: string;
  generationContext: unknown | null;
  generationContextRaw: string | null;
  isClarifyingQuestion: boolean;
}>;
function extractChangeContext(raw: string): ParseResult<{
  visibleResponse: string;
  changeContext: { scope: string; description: string } | null;
  isClarifyingQuestion: boolean;
}>;

// STATUS: PASS|FAIL + ISSUES / WARNINGS / SUGGESTIONS sections.
function parseValidationResult(raw: string): ParseResult<{
  status: "PASS" | "FAIL";
  issues: string[];
  warnings: string[];
  suggestions: string[];
}>;

// classification: COMPATIBLE|FLAG|DRIFT, type, reason.
function parseDriftResult(raw: string): ParseResult<{
  classification: "COMPATIBLE" | "FLAG" | "DRIFT";
  type: string;
  reason: string;
}>;

// diagnosis + root_cause + affected_artifact + proposed_fix + confidence.
function parseDiagnosisResult(raw: string): ParseResult<{
  diagnosis: "WIREFRAME_BUG" | "TEST_BUG" | "WORKFLOW_FLAW";
  rootCause: string;
  affectedArtifact: string;
  proposedFix: string;
  confidence: "high" | "medium" | "low";
}>;
```

**Helper every parser uses:**

```typescript
// Strips ```yaml / ```json / ``` fences around content. Handles:
//   - whole-string fenced blocks
//   - preamble/postamble ("Here's the YAML:\n```yaml\n...\n```\nLet me know")
//   - bare backticks (no language tag)
function stripCodeFences(text: string): string;
```

**Example — `parseValidationResult`:**

Input:
```
Here's my assessment:

STATUS: FAIL

ISSUES:
- No admin persona defined
- Goal mentions payments but Boundaries says "No payments"

SUGGESTIONS:
- Either add a payments feature or remove the mention from the goal
```

Output:
```json
{
  "success": true,
  "data": {
    "status": "FAIL",
    "issues": [
      "No admin persona defined",
      "Goal mentions payments but Boundaries says \"No payments\""
    ],
    "warnings": [],
    "suggestions": ["Either add a payments feature or remove the mention from the goal"]
  },
  "rawText": "..."
}
```

**Gotchas:**
- LLMs love to wrap structured output in code fences even when asked not to. `stripCodeFences` handles it.
- LLMs also love to add "Sure, here's:" preamble. Don't anchor regexes to the start of the string.
- Headers (`STATUS:`, `ISSUES:`, etc.) match case-insensitively and with `^...$/m` anchors.

---

### Module 3 — Prompt Registry

**Purpose.** Look up prompt strings by slug. Prompts are code-like config; they live in source but get loaded by slug so ops don't import prompt files directly.

**Dependencies.** None.

**Files.**
- `core/prompts/prompt-registry.ts` — the `PromptRegistry` class
- `core/prompts/phase1-prompts.ts` — 4 Phase 1 prompts + `registerPhase1Prompts(registry)`
- `core/prompts/phase2-autogen-prompts.ts` — 22 Phase 2 prompts + `registerPhase2Prompts(registry)`
- `core/prompts/README.md` — catalog of every prompt with purpose + parser

**Public API.**

```typescript
interface IPromptRegistry {
  register(slug: string, content: string): void;
  get(slug: string): string;      // throws if missing
}

class PromptRegistry implements IPromptRegistry { /* trivial impl */ }

// Slug constants prevent typos:
const PHASE1_PROMPT_SLUGS = {
  sessionTitle:        "phase1-session-title",
  phase1Conversational:"phase1-conversational",
  projectContractGenerator: "project-contract-generator",
  phase1Validation:    "phase1-validation",
} as const;

const PHASE2_PROMPT_SLUGS = { /* 22 slugs */ } as const;

function registerPhase1Prompts(registry: IPromptRegistry): void;
function registerPhase2Prompts(registry: IPromptRegistry): void;
```

**Example:**

```typescript
const registry = new PromptRegistry();
registerPhase1Prompts(registry);
registerPhase2Prompts(registry);

const prompt = registry.get("phase1-conversational");
// prompt is a ~3000-char string telling the model to produce a visible
// response + a <generation_context> YAML block.
```

Prompts are **plain strings**, not templated. Variable data goes in the user message, not the system prompt. This keeps prompts static and cacheable.

---

### Module 4 — Streaming (SSEWriter)

**Purpose.** A thin wrapper around `ReadableStream` that emits typed SSE events. One instance per HTTP request.

**Dependencies.** None.

**Files.**
- `core/operation-executor/streaming.ts`

**Public API.**

```typescript
type SSEEventType =
  | "chunk"        // text delta for chat
  | "document"     // a document was created or updated
  | "phase"        // phase transition — { phaseId, status, detail? }
  | "stage"        // Phase 2 sub-stage — { stageName, status: "running"|"review"|"complete" }
  | "progress"     // op progress — { operationId, status, detail? }
  | "test_results" // test execution or validation results
  | "drift"        // drift classification — { classification, type, reason }
  | "meta"         // one-off informational payload (session_info, etc.)
  | "error"        // { error: string, fatal?: boolean }
  | "complete";    // stream finished

class SSEWriter {
  createStream(): ReadableStream<Uint8Array>;
  send<T>(event: { type: SSEEventType; data: T }): void;
  sendChunk(text: string): void;
  sendDocument(doc: { type: string; content: string; version: number }): void;
  sendStage(info: {
    stageName: "design" | "wireframe" | "test_suite" | "automated_tests";
    status: "running" | "review" | "complete";
    detail?: string;
  }): void;
  sendProgress(info: { operationId: string; status: string; detail?: string }): void;
  sendError(message: string, fatal?: boolean): void;
  sendMeta<T>(data: T): void;
  sendComplete<T>(data?: T): void;   // sends `complete` event THEN closes the stream
  close(): void;
}

function createSSEResponse(writer: SSEWriter): Response;
```

**Wire format.** Each `send()` emits one `event: TYPE\ndata: JSON\n\n` frame.

**Example:**

```typescript
export async function POST(req: Request) {
  const writer = new SSEWriter();
  const response = createSSEResponse(writer);

  void (async () => {
    writer.sendMeta({ event: "session_created" });
    writer.sendChunk("Hello, ");
    writer.sendChunk("world.");
    writer.sendDocument({ type: "project_contract", content: "# ...", version: 1 });
    writer.sendComplete();   // stream closed after this
  })();

  return response;
}
```

**Client reads it** via `fetch()` with a streaming body reader. Parse each frame as `event: TYPE\ndata: JSON`.

**Gotcha we hit:** `sendComplete()` closes the underlying controller. **Anything written after it is silently dropped.** If you want to send multiple meta events, emit them BEFORE `sendComplete`.

---

### Module 5 — Storage

**Purpose.** CRUD for all domain entities. The single source of truth on disk. Two interchangeable implementations: `FileStorage` (production) and `MemoryStorage` (tests).

**Dependencies.** None.

**Files.**
- `core/storage/interface.ts` — `IStorage` contract + related types
- `core/storage/file-storage.ts` — JSON-file-per-collection implementation
- `core/storage/memory-storage.ts` — in-memory map-based implementation
- `core/wireframe/wireframe-manager.ts` — filesystem helper for wireframe HTML files (separate because they're not JSON)

**Public API (IStorage — partial; full list has 30+ methods):**

```typescript
interface Session {
  id: string;                  // UUID
  title: string;
  currentPhaseId: "phase-1" | "phase-2";
  createdAt: string;           // ISO timestamp
  updatedAt: string;
  status: "active" | "suspended";
  phase2Stage?: Phase2Stage | null;  // Phase 2 sub-stage tracking
}

interface Document {
  id: string;
  sessionId: string;
  phaseId: "phase-1" | "phase-2";
  type: "project_contract" | "workflow_map" | "test_suite" | "screen_inventory";
  content: string;             // rendered markdown
  structuredData: string;      // raw YAML or JSON — the source of truth
  version: number;             // auto-incremented on write
  status: "active" | "inactive";
  createdAt: string;
  lastModifiedAt: string;
}

interface ChatMessage {
  id: string;
  sessionId: string;
  phaseId: "phase-1" | "phase-2";
  role: "user" | "assistant" | "system";
  type: "chat" | "system_notification" | "drift_warning" | "validation_result" | "test_results" | "diagnosis_result" | "operation_failure";
  content: string;
  metadata: {
    screenReference: string | null;
    generationContext: string | null;  // JSON string of the structured data
    operationId: string | null;
    stale: boolean;
  };
  createdAt: string;
}

interface IStorage {
  // Sessions
  createSession(s: Session): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  updateSession(id: string, u: Partial<Session>): Promise<Session>;
  listSessions(): Promise<Session[]>;
  deleteSession(id: string): Promise<void>;

  // Documents — writes auto-bump version; old versions go status:"inactive"
  createDocument(d: Document): Promise<Document>;
  getActiveDocument(sessionId: string, type: DocumentType): Promise<Document | null>;
  getDocumentsBySession(sessionId: string): Promise<Document[]>;
  deactivateDocuments(sessionId: string, type: DocumentType): Promise<void>;

  // Chat
  addMessage(m: ChatMessage): Promise<ChatMessage>;
  getMessagesByPhase(sessionId: string, phaseId: PhaseId): Promise<ChatMessage[]>;

  // ...plus: phase state, operation progress, checkpoints, artifacts,
  // conversation summaries, pending messages, test results, cascade snapshots
}
```

**FileStorage layout on disk** (`./data/`):

```
data/
├── sessions.json                     # all Session records
├── phase-states.json
├── documents.json
├── chat-messages.json
├── operation-progress.json
├── checkpoints.json
├── conversation-summaries.json
├── pending-messages.json
├── test-results.json
├── cascade-snapshots.json
├── artifacts.json
└── sessions/
    └── <sessionId>/
        └── wireframe/
            ├── index.html
            ├── data.js
            ├── test-harness.html
            ├── tests.js
            └── <screen-id>.html        # one per screen
```

**Write discipline:** atomic writes (`tmp + rename`). Never partial-write a JSON file.

**Example:**

```typescript
const storage = new FileStorage("./data");

const session = await storage.createSession({
  id: uuid(),
  title: "Recipe App",
  currentPhaseId: "phase-1",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: "active",
});

await storage.addMessage({
  id: uuid(),
  sessionId: session.id,
  phaseId: "phase-1",
  role: "user",
  type: "chat",
  content: "I want a recipe sharing app",
  metadata: { screenReference: null, generationContext: null, operationId: "op-1-1", stale: false },
  createdAt: new Date().toISOString(),
});

const msgs = await storage.getMessagesByPhase(session.id, "phase-1");
// msgs.length === 1
```

**Gotchas:**
- `createDocument` **auto-increments** `version` based on the latest active doc for the `(sessionId, type)` pair. Pass `version: 0` as a placeholder; storage fills it in.
- Only one `status: "active"` doc per `(sessionId, type)` at a time. A new create deactivates the previous active.

---

### Module 6 — Operation Executor

**Purpose.** Given an `OperationDefinition`, call the LLM Provider, run the parser, retry on parse failure (with a retry hint injected), and record token usage. The single place in the system that calls the LLM.

**Dependencies.** LLM Provider (1), Parsers (2 — via the parser on each definition), Streaming (4 — optional `onStreamChunk`).

**Files.**
- `core/operation-executor/executor.ts`
- `core/operation-executor/retry.ts` — builds the retry message list
- `core/operation-executor/token-tracker.ts` — per-session totals
- `core/operation-executor/two-ai-pattern.ts` — helper for ops that produce both a chat response AND a document

**Public API.**

```typescript
interface OperationDefinition<T = unknown> {
  operationId: OperationId;               // "op-1-1", "op-2-3a", etc.
  systemPrompt: string;                   // from the Prompt Registry
  messages: { role: "user"|"assistant"|"system"; content: string }[];
  expectedOutputFormat: "markdown" | "yaml" | "json" | "plain_text" | "structured";
  outputParser: (raw: string) => ParseResult<T>;  // from the Parsers module
  maxRetries: number;                     // typically 1
  retryPrompt: string | null;             // hint used when the parser fails
  timeoutMs: number;                      // default 60000
  role?: "fast" | "reasoning";            // routes to LLM_MODEL_FAST or LLM_MODEL_REASONING
  onStreamChunk?: (chunk: string) => void;
}

interface OperationResult<T = unknown> {
  operationId: OperationId;
  status: "success" | "failed";
  output: { success: true; data: T; rawText: string } | null;
  error: string | null;
  tokenUsage: { input: number; output: number };
  cost: number;
  durationMs: number;
}

class OperationExecutor {
  constructor(options?: { tokenTracker?: TokenTracker });
  execute<T>(def: OperationDefinition<T>, options?: { sessionId?: string; signal?: AbortSignal }): Promise<OperationResult<T>>;
  getTokenTracker(): TokenTracker;
}
```

**Example:**

```typescript
const executor = new OperationExecutor();

const result = await executor.execute({
  operationId: "op-1-3",
  systemPrompt: registry.get("phase1-validation"),
  messages: [
    { role: "user", content: "Validate this contract:\n\n# Project Contract\n\n..." },
  ],
  expectedOutputFormat: "structured",
  outputParser: parseValidationResult,
  maxRetries: 1,
  retryPrompt: "Respond in format: STATUS: PASS|FAIL, then ISSUES: and SUGGESTIONS: sections.",
  timeoutMs: 30000,
  role: "reasoning",
}, { sessionId: "abc-123" });

// result ===
// {
//   operationId: "op-1-3",
//   status: "success",
//   output: { success: true, data: { status: "PASS", issues: [], warnings: [], suggestions: [] }, rawText: "STATUS: PASS\n..." },
//   error: null,
//   tokenUsage: { input: 523, output: 42 },
//   cost: 0,
//   durationMs: 1834
// }
```

**Two-AI pattern** is a thin coordinator for ops that need both a conversational reply and a structured document (Ops 1.1, 1.2, 2.7a). Call A emits a `<generation_context>` block; Call B takes that block and produces the markdown document. See `two-ai-pattern.ts`.

**Gotchas:**
- The executor's internal `streamCall` is `protected`, so unit tests can subclass and stub the LLM without hitting the network.
- `retryPrompt` is the **only** way to get a retry. If `null`, parse failures are terminal.
- Transport failures (auth, network) break the retry loop immediately — retrying auth errors wastes API calls.

---

### Module 7 — Context Builder

**Purpose.** Assemble `{systemPrompt, messages}` for a given operation by pulling chat history, documents, and chat summaries out of Storage. Ops don't touch Storage directly for context — they ask the Context Builder.

**Dependencies.** Storage (5), Prompt Registry (3), Summarizer (internal helper).

**Files.**
- `core/context-builder/context-builder.ts`
- `core/context-builder/summarizer.ts` — summarizes old chat turns to fit context limits
- `core/context-builder/phase2-context.ts` — Phase-2-specific context assembly

**Public API (subset):**

```typescript
class ContextBuilder {
  constructor(storage: IStorage, registry: IPromptRegistry, summarizer: Summarizer);

  // Op 1.1 — first message, no history
  buildPhase1FirstMessage(userMessage: string): Promise<{
    systemPrompt: string;
    messages: { role: "user"|"assistant"|"system"; content: string }[];
  }>;

  // Op 1.2 — iteration, includes chat history (summarized if long)
  buildPhase1Iteration(sessionId: string, userMessage: string): Promise<BuiltContext>;

  // Op 1.3 — validates the current active Project Contract
  buildPhase1Validation(sessionId: string): Promise<BuiltContext>;

  // Call B of the Two-AI pattern — just the structured context from Call A
  buildProjectContractGeneratorContext(genContextYaml: string): Promise<BuiltContext>;

  // Phase 2 conversational — includes contract, recent chat, pinned screen ref
  buildPhase2ConversationalContext(
    sessionId: string, userMessage: string, screenRef: string | null
  ): Promise<BuiltContext>;
}
```

**Example:**

```typescript
const built = await contextBuilder.buildPhase1Iteration(sessionId, "Add an admin persona");
// built.systemPrompt === registry.get("phase1-conversational")  (the phase-1 system prompt)
// built.messages === [
//   { role: "user", content: "I want a recipe sharing app" },
//   { role: "assistant", content: "Drafted a contract." },
//   { role: "user", content: "Add an admin persona" }
// ]
```

---

### Module 8 — Operations (business logic)

**Purpose.** One function per LLM operation. Each glues the Operation Executor to a specific prompt, parser, and storage writeback.

**Dependencies.** Operation Executor (6), Context Builder (7), Prompt Registry (3), Storage (5), Streaming (4 — for chunks).

**Files.**
- `core/operations/phase1/op-1-0-title.ts` — session title generation
- `core/operations/phase1/op-1-1-goal-expansion.ts` — first message (Two-AI)
- `core/operations/phase1/op-1-2-iteration.ts` — follow-up (Two-AI)
- `core/operations/phase1/op-1-3-validation.ts` — contract validation
- `core/operations/phase2/op-2-1-workflow-map.ts` — 2.1a / 2.1b / 2.1c
- `core/operations/phase2/op-2-2-test-suite.ts` — 2.2a / 2.2b / 2.2c
- `core/operations/phase2/op-2-3-screen-inventory.ts` — 2.3a / 2.3b / 2.3c / 2.3d
- `core/operations/phase2/op-2-4-wireframe.ts` — 2.4a / 2.4b / 2.4c / 2.4d / 2.4e
- `core/operations/phase2/op-2-5-tests.ts` — 2.5a / 2.5b / 2.5c / 2.5d / 2.5e
- `core/operations/phase2/op-2-6-drift-check.ts`
- `core/operations/phase2/op-2-7a-conversational.ts`
- `core/operations/phase2/op-2-7-targeted-updates.ts` — 2.7c / 2.7d
- `core/operations/phase2/op-2-9-diagnosis.ts`
- `core/operations/phase2/op-2-10-validation.ts`
- `core/operations/phase2/batch-utils.ts` — `executeBatch()` with semaphore concurrency

**Public API** (one per op; shapes vary; a representative example):

```typescript
async function validatePhase1(
  executor: OperationExecutor,
  contextBuilder: ContextBuilder,
  sessionId: string
): Promise<{
  status: "PASS" | "FAIL";
  issues: string[];
  warnings: string[];
  suggestions: string[];
}>;
```

**Example — Op 1.3 Phase 1 validation:**

```typescript
const result = await validatePhase1(executor, contextBuilder, sessionId);
// {
//   status: "FAIL",
//   issues: ["No admin persona", "Payments contradict boundaries"],
//   warnings: [],
//   suggestions: ["Clarify the payment strategy"]
// }
```

**Batch ops pattern** (Ops 2.1b, 2.2a, 2.4c, 2.5b):

```typescript
const results = await executeBatch(items, async (item) => {
  const def = buildDefForItem(item);
  const r = await executor.execute(def, { sessionId });
  if (r.status === "failed" || !r.output) {
    throw new Error(r.error ?? "failed");
  }
  return r.output.rawText;
}, /* maxConcurrency */ 3);

// results === { succeeded: {item, result}[], failed: {item, error}[] }

// CRITICAL: if every item failed, throw — don't pass an empty array
// downstream. The whole stage should fail so the user sees a clear error
// instead of getting garbage documents.
if (results.succeeded.length === 0 && results.failed.length > 0) {
  throw new Error(`op-X failed on all ${results.failed.length} items: ${results.failed[0].error}`);
}
```

**Gotchas:**
- Each op file must be **fully independent** of every other op. They only share the executor and the registry.
- Batch ops that "succeed" with zero results are a trap. Always assert at least one success before returning.

---

### Module 9 — Dependency Graph

**Purpose.** Generic DAG runner. Executes nodes respecting dependencies + conditions, with bounded concurrency. Knows nothing about the domain.

**Dependencies.** None.

**Files.**
- `core/session-manager/dependency-graph.ts`
- `core/session-manager/auto-generation-graph.ts` — the original (monolithic) topology for all Phase 2 ops, kept for reference / tests

**Public API.**

```typescript
interface GraphNode {
  operationId: string;
  dependencies: string[];                  // must all be complete or skipped first
  condition?: () => Promise<boolean>;      // false → this node is skipped (as if completed)
  execute: () => Promise<void>;
}

type ProgressCallback = (operationId: string, status: OperationStatus) => void;

class DependencyGraphExecutor {
  constructor(opts?: { maxConcurrency?: number; onProgress?: ProgressCallback });
  execute(nodes: GraphNode[]): Promise<Map<string, OperationStatus>>;
  getStatuses(): Map<string, OperationStatus>;
  getErrors(): Map<string, Error>;
}
```

**Example:**

```typescript
const dag = new DependencyGraphExecutor({
  maxConcurrency: 3,
  onProgress: (op, status) => console.log(`[${op}] ${status}`),
});

await dag.execute([
  { operationId: "a", dependencies: [],            execute: async () => { /* ... */ } },
  { operationId: "b", dependencies: ["a"],         execute: async () => { /* ... */ } },
  { operationId: "c", dependencies: ["a"],         execute: async () => { /* ... */ } },
  { operationId: "d", dependencies: ["b", "c"],    execute: async () => { /* ... */ } },
  { operationId: "e", dependencies: ["d"],
    condition: async () => someFlag,                execute: async () => { /* ... */ } },
]);

// a runs alone → b and c run in parallel → d waits for both → e runs if condition returns true
```

**Critical gotcha:** `runNode` **catches exceptions** from individual nodes and marks them as `failed` without re-throwing from `execute()`. This lets sibling branches keep progressing. **Callers must check `dag.getStatuses()` for failures after `execute()` returns.** Without this check, a failed stage looks successful.

```typescript
await dag.execute(nodes);

// Required follow-up:
for (const [opId, status] of dag.getStatuses()) {
  if (status === "failed") {
    const error = dag.getErrors().get(opId);
    throw new Error(`Stage failed: ${opId} — ${error?.message}`);
  }
}
```

---

### Module 10 — Phase 2 Stage Machine

**Purpose.** Track which of 4 stages a session is in, enforce valid transitions, provide helpers to persist state.

**Dependencies.** Storage (5).

**Files.**
- `core/session-manager/phase2-stage-machine.ts`

**Public API.**

```typescript
type Phase2Stage =
  | "not_started"
  | "design_running"         | "design_review"
  | "wireframe_running"      | "wireframe_review"
  | "test_suite_running"     | "test_suite_review"
  | "automated_tests_running"
  | "complete";

// Transitions:
//   not_started → design_running → design_review
//              → wireframe_running → wireframe_review
//              → test_suite_running → test_suite_review
//              → automated_tests_running → complete
//
// Only user-initiated "approve" actions transition a _review → next _running.
// Stage runners handle running → review/complete.

function canAdvanceStage(current: Phase2Stage | null): {
  ok: boolean;
  next: Phase2Stage | null;
  reason: string | null;
};

function stageAfterRunning(running: Phase2Stage): Phase2Stage;  // e.g. "design_running" → "design_review"

function setPhase2Stage(storage: IStorage, sessionId: string, stage: Phase2Stage): Promise<Session>;
function getPhase2Stage(storage: IStorage, sessionId: string): Promise<Phase2Stage>;
function isRunning(stage: Phase2Stage | null): boolean;
function isReview(stage: Phase2Stage | null): boolean;
```

**Example:**

```typescript
// User just approved "design_review":
const { ok, next } = canAdvanceStage("design_review");
// ok === true, next === "wireframe_running"

await setPhase2Stage(storage, sessionId, next!);
// Session record now has phase2Stage: "wireframe_running"
```

---

### Module 11 — Session Manager

**Purpose.** Top-level coordinator. Owns session lifecycle, the chat lock (only one operation per session at a time), and routing messages to the right handler.

**Dependencies.** Storage (5), Operations (8), Dependency Graph (9), Phase 2 Stage Machine (10). Implements `Phase1Handlers` and `Phase2Handlers` interfaces that glue it to the ops.

**Files.**
- `core/session-manager/session-manager.ts` — the `SessionManager` class + `Phase1Handlers` / `Phase2Handlers` interfaces
- `core/session-manager/phase1-handlers.ts` — concrete impl of Phase 1 handlers
- `core/session-manager/phase2-handlers.ts` — concrete impl of Phase 2 handlers (contains 4 stage runners)
- `core/session-manager/operation-router.ts` — picks op-1-1 vs op-1-2 based on session state
- `core/session-manager/phase-state-machine.ts` — validates phase transitions (active → completing → complete etc.)
- `core/session-manager/cascade-executor.ts` + `cascade-router.ts` — Phase 2 interaction cascades
- `core/session-manager/rollback.ts` — Phase 2 → Phase 1 rollback
- `core/session-manager/session-resume.ts` — mark crashed ops as failed on server restart

**Public API.**

```typescript
interface Phase1Handlers {
  generateTitle(sessionId: string, firstMessage: string): Promise<void>;
  handleFirstMessage(sessionId: string, message: string, sse: SSEWriter): Promise<void>;
  handleIteration(sessionId: string, message: string, sse: SSEWriter): Promise<void>;
  completePhase(sessionId: string, sse: SSEWriter): Promise<void>;
}

interface Phase2Handlers {
  handleMessage(sessionId: string, message: string, screenRef: string|null, sse: SSEWriter): Promise<void>;
  runAutoGeneration(sessionId: string, sse: SSEWriter): Promise<void>;  // Phase 1 PASS → runs Stage 1 only
  advanceStage(sessionId: string, sse: SSEWriter): Promise<void>;       // user approved → runs next stage
  completePhase(sessionId: string, sse: SSEWriter): Promise<void>;       // Op 2.10 validation
}

class SessionManager {
  constructor(storage: IStorage, handlers: { phase1: Phase1Handlers; phase2: Phase2Handlers });

  createSession(firstMessage: string, sse: SSEWriter): Promise<Session>;
  handleMessage(sessionId: string, message: string, screenRef: string|null, sse: SSEWriter): Promise<void>;
  completePhase(sessionId: string, sse: SSEWriter): Promise<void>;
  isBlocked(sessionId: string): boolean;
}
```

**Chat locking.** The manager keeps `Map<sessionId, boolean>`. Any `handleMessage` or `completePhase` call tries to acquire the lock; if it's held, the second caller gets `sse.sendError("Please wait for the current operation to complete.")`. The lock releases in `finally`.

**Example — end-to-end on a new session:**

```typescript
// User POSTs /api/chat with { message: "I want a recipe app" } and NO sessionId.
// The route constructs an SSEWriter and calls:
await sessionManager.createSession("I want a recipe app", sse);

// Inside createSession:
// 1. Storage.createSession
// 2. Storage.upsertPhaseState (phase-1 = active)
// 3. Storage.createCheckpoint #1
// 4. sse.sendMeta({event:"session_info", sessionId})  ← client learns the ID
// 5. Acquire lock
// 6. Fire-and-forget: handlers.phase1.generateTitle(id, msg)
//       → runs op-1-0 → updates session.title
// 7. Await: handlers.phase1.handleFirstMessage(id, msg, sse)
//       → runs op-1-1 (Two-AI pattern)
//       → persists user + assistant messages
//       → persists project_contract doc (version 1)
//       → sse.sendDocument({...})
//       → sse.sendComplete()
// 8. Release lock
```

---

### Module 12 — API Routes

**Purpose.** HTTP adapters. Each route is ~30 lines: parse body, grab SessionManager from bootstrap, stream results.

**Dependencies.** SessionManager (11), Storage (5), Streaming (4).

**Files (all under `app/api/`):**

| Route | Method | Purpose |
|---|---|---|
| `/chat` | POST | Main chat. Creates session or handles message. SSE. |
| `/phase/complete` | POST | Validates current phase. On Phase 1 PASS chains into Phase 2 Stage 1. SSE. |
| `/phase2/start` | POST | Manually start Phase 2 auto-gen. SSE. |
| `/phase2/advance` | POST | User approved a stage — run the next one. SSE. |
| `/rollback` | POST | Phase 2 → Phase 1. SSE. |
| `/tests/run` | POST | Run the generated test bundle. SSE. |
| `/tests/diagnose` | POST | Op 2.9 diagnose a failed test. JSON. |
| `/sessions` | GET / POST | List or create sessions. JSON. |
| `/sessions/[id]` | GET / DELETE | Get full snapshot or delete. JSON. |
| `/wireframe/[sessionId]/[filename]` | GET | Serve wireframe HTML/JS/CSS. Raw bytes. |
| `/export` | POST | Bundle a session as JSON for download. |
| `/health` | GET | Liveness + LLM config. JSON. |
| `/test-llm` | GET | Smoke-test the LLM provider directly. SSE. |

**Example — `POST /api/chat`:**

Request:
```json
{ "sessionId": null, "message": "I want a recipe sharing app", "screenRef": null }
```

Response — `Content-Type: text/event-stream`:
```
event: meta
data: {"event":"session_info","sessionId":"3b9f-..."}

event: chunk
data: {"text":"Drafted "}

event: chunk
data: {"text":"your contract."}

event: document
data: {"type":"project_contract","content":"# Project Contract\n\n## Goal Statement\n...","version":1}

event: complete
data: {}
```

**Bootstrap singleton** (`core/bootstrap.ts`):

```typescript
// Wires Storage + Executor + Registry + ContextBuilder + SessionManager into
// a process-wide singleton. API routes import `getBootstrap()` or
// `getSessionManager()` — never construct the wiring themselves.

interface Bootstrapped {
  storage: IStorage;
  executor: OperationExecutor;
  promptRegistry: IPromptRegistry;
  contextBuilder: ContextBuilder;
  sessionManager: SessionManager;
}

function getBootstrap(opts?: { storage?: IStorage; dataDir?: string }): Bootstrapped;
function getSessionManager(opts?: {...}): SessionManager;
function resetBootstrapForTests(): void;
```

---

### Module 13 — UI (React + Zustand)

**Purpose.** Three-zone layout (sidebar / chat / document panel). Streams via the same SSE format as the server emits.

**Dependencies.** Wire format (module 4) + the fetch API.

**Files (under `app/src/components/` and `app/src/stores/`):**

| Component | Purpose |
|---|---|
| `AppShell` | Three-zone layout + error boundary |
| `SessionSidebar` | Session list + "New Chat" button |
| `PhaseIndicator` | Phase 1 → Phase 2 + sub-stage chips |
| `ChatPanel` | Messages + streaming bubble + drift banner + approve button + input |
| `ChatInput` | Text input + send + "Done" button |
| `DocumentPanel` | Tabs for documents + Wireframe tab |
| `phase2/WireframeViewer` | Sandboxed iframe loading `/api/wireframe/<id>/index.html` |
| `phase2/TestResultsPanel` | Run tests, show pass/fail, diagnose |
| `ApproveStageButton` | "Approve → Generate Wireframe" etc. |
| `DriftWarning` | FLAG / DRIFT banner with rollback action |
| `ErrorBoundary` | Global error screen |

**Stores (`app/src/stores/`):**

| Store | State |
|---|---|
| `session-store.ts` | sessions, activeSessionId, phaseStates, phase2Stage, loadSessions, setActiveSession |
| `chat-store.ts` | messages, streamingText, isStreaming, isBlocked, error, driftWarning, addMessage, startStreaming, finalizeStream, setError, showDriftWarning |
| `document-store.ts` | documents map, activeDocumentType, setDocument, loadDocuments |

**SSE client (`app/src/lib/use-sse.ts`):**

```typescript
interface UseSSEReturn {
  sendMessage: (opts: { sessionId?: string | null; message: string; screenRef?: string | null }) => void;
  completePhase: (sessionId: string) => void;
  advancePhase2Stage: (sessionId: string) => void;
}

function useSSE(): UseSSEReturn;
```

Each method POSTs to the corresponding API route, consumes the SSE stream, and dispatches events to the appropriate store. Event→store mapping:

| SSE event | Dispatched to |
|---|---|
| `chunk` | `chatStore.appendStreamChunk(text)` |
| `document` | `docStore.setDocument(doc)` |
| `phase` | `sessionStore.updatePhaseState(phaseId, ...)` |
| `stage` | `sessionStore.setPhase2Stage(mapped)` + system message |
| `progress` | System message (if detail) |
| `drift` | `chatStore.showDriftWarning(warning)` |
| `test_results` | `chatStore.addMessage(systemMessage)` |
| `meta` with `event: "session_info"` | `sessionStore.addSession + setActiveSession` |
| `error` | `chatStore.setError(msg)` |
| `complete` | `chatStore.finalizeStream(message)` + refresh session list |

**Gotchas we hit in UI land:**
- **SSR hydration.** `page.tsx` imports `AppShell` via `next/dynamic` with `ssr: false` and marks itself `"use client"`. Without this, event handlers don't attach and the UI appears but is inert.
- **`sendComplete` closes the stream**, so `session_info` meta MUST be emitted before any `sendComplete` inside `createSession`. We emit it from inside `SessionManager.createSession` right after the storage writes.
- **Turbopack + Tailwind typography plugin crash on Windows.** Remove `@plugin "@tailwindcss/typography"` from globals.css and hand-roll the prose styles.

---

## 4. Data Contracts — what flows between modules

### 4.1 Operation → Storage: Document write

Every document write goes through `storage.createDocument(d)`. The `d` object:
```typescript
{
  id: uuid(),
  sessionId,
  phaseId: "phase-1" | "phase-2",
  type: "project_contract" | "workflow_map" | "test_suite" | "screen_inventory",
  content: "...markdown...",
  structuredData: "...YAML or raw source...",
  version: 0,  // placeholder — storage auto-increments
  status: "active",
  createdAt: iso(),
  lastModifiedAt: iso(),
}
```

### 4.2 SSE Event Vocabulary (between server & client)

Every API route that runs an LLM op emits one or more of these:

| Event | Shape | When |
|---|---|---|
| `meta` | `{event: string, sessionId?: string}` | Session lifecycle markers |
| `chunk` | `{text: string}` | Each streamed token from the LLM |
| `document` | `{type, content, version}` | A document was created/updated |
| `phase` | `{phaseId, status, detail?}` | Phase state changed (active → complete etc.) |
| `stage` | `{stageName, status: "running"\|"review"\|"complete", detail?}` | Phase 2 sub-stage transition |
| `progress` | `{operationId, status, detail?}` | Individual op progress inside a stage |
| `drift` | `{classification: "COMPATIBLE"\|"FLAG"\|"DRIFT", type, reason}` | Op 2.6 classification |
| `test_results` | `{status, issues, suggestions, ...}` | Op 1.3, 2.10, or test run results |
| `error` | `{error, fatal?}` | Something failed |
| `complete` | `{...optional summary}` | Stream done — **writer closes after this** |

### 4.3 Prompt → Parser Contract

Each prompt in the registry has exactly one parser that can handle its output. These are paired:

| Prompt slug | Parser |
|---|---|
| `phase1-conversational` | `extractGenerationContext` |
| `project-contract-generator` | `parseMarkdownSections(raw, ["Goal Statement", "Personas", "Entity Map", "Boundaries"])` |
| `phase1-validation` | `parseValidationResult` |
| `workflow-discovery` | `parseYAML` |
| `drift-check` | `parseDriftResult` |
| `test-failure-diagnosis` | `parseDiagnosisResult` |
| `phase2-conversational` | `extractChangeContext` |
| `phase2-validation` | `parseValidationResult` |
| (see `app/src/core/prompts/README.md` for the full table of 26) | |

---

## 5. End-to-end flows

### 5.1 Phase 1 first message

```
Browser            /api/chat (POST)         SessionManager           Storage                  Op 1.1 (Two-AI)                  OpenRouter
  │                     │                         │                    │                            │                              │
  │── {message}────────►│                         │                    │                            │                              │
  │                     │── createSession ───────►│                    │                            │                              │
  │                     │                         │── createSession ──►│                            │                              │
  │                     │                         │← Session ──────────│                            │                              │
  │                     │                         │── upsertPhaseState►│                            │                              │
  │                     │                         │── createCheckpoint►│                            │                              │
  │                     │                         │                    │                            │                              │
  │                     │← event: meta(session_info) ──────────────────────────────────────────────────────────────────────────────│
  │← event: meta ───────│                         │                    │                            │                              │
  │                     │                         │                    │                            │                              │
  │                     │                         │── [fire&forget] op-1-0 ────────────────────────►│                              │
  │                     │                         │                    │                            │── POST /chat/completions ───►│
  │                     │                         │                    │                            │← {"choices":[{"delta":..."}]}│
  │                     │                         │                    │← updateSession{title} ─────│                              │
  │                     │                         │                    │                            │                              │
  │                     │                         │── handleFirstMessage (op-1-1) ─────────────────►│                              │
  │                     │                         │                    │                            │── Call A ───────────────────►│
  │                     │← event: chunk... ───────────────────────────────────────────────────────── onStreamChunk ────────────────│
  │← text streams ──────│                         │                    │                            │                              │
  │                     │                         │                    │                            │── Call B ───────────────────►│
  │                     │                         │                    │← createDocument ───────────│                              │
  │                     │← event: document ──────────────────────────────────────────────────────────────────────────────────────── │
  │← doc panel updates ─│                         │                    │                            │                              │
  │                     │                         │                    │                            │                              │
  │                     │← event: complete ──────────────────────────────────────────────────────────────────────────────────────── │
  │← stream ends ───────│                         │                    │                            │                              │
```

### 5.2 Phase 2 design stage (after Phase 1 PASS)

```
User clicks "Done — Validate & Complete Phase 1"
  │
  ▼
POST /api/phase/complete { sessionId }
  │
  ▼
SessionManager.completePhase
  │  (reads phase-1 state, delegates to Phase1Handlers.completePhase)
  │
  ▼
Phase1Handlers.completePhase
  │  Op 1.3 → validatePhase1
  │  On PASS: transitionPhase(phase-1 → complete)
  │            sse.send({type:"phase", data:{phaseId:"phase-1", status:"complete"}})
  │  On FAIL: sse.send({type:"test_results", data:{status:"FAIL", issues:[...]}})
  │            sse.sendComplete()      ← closed here on FAIL
  │
  ▼  (on PASS, control returns to SessionManager.completePhase)
SessionManager sees phase-1 status === "complete" → calls phase2.runAutoGeneration
  │
  ▼
Phase2Handlers.runAutoGeneration
  │  initializePhase2  (upsert phase-2 state, set session.currentPhaseId="phase-2",
  │                     emit phase event)
  │
  ▼
runDesignStage
  │  setPhase2Stage("design_running")
  │  sse.sendStage({stageName:"design", status:"running"})
  │
  │  Build a DAG with 7 nodes:
  │    op-2-1a (workflow discovery)
  │    op-2-1b (batch detail, deps: op-2-1a)
  │    op-2-1c (workflow map formatting, deps: op-2-1b)
  │    op-2-3a (screen extraction, deps: op-2-1c)
  │    op-2-3b (nav validation, deps: op-2-3a)
  │    op-2-3c (screen correction, deps: op-2-3b, conditional)
  │    op-2-3d (screen inventory formatting, deps: op-2-3c)
  │
  │  DependencyGraphExecutor.execute(nodes)
  │    → each node runs the corresponding op function,
  │      which calls executor.execute → streams via openrouter,
  │      writes documents to storage, emits document SSE events.
  │
  │  assertDagSucceeded(dag, "Design")
  │    → throw if any node failed; caller catches and reverts state
  │
  │  assertDocumentsExist(storage, sessionId, ["workflow_map", "screen_inventory"])
  │
  │  setPhase2Stage("design_review")
  │  sse.sendStage({stageName:"design", status:"review", detail:"Review the Workflow Map..."})
  │  sse.sendComplete({event:"design_stage_complete"})
  │
  ▼
Client receives stage event → ApproveStageButton renders
User clicks Approve → POST /api/phase2/advance { sessionId }
  │
  ▼
Phase2Handlers.advanceStage
  │  canAdvanceStage("design_review") → next = "wireframe_running"
  │  runWireframeStage (Stage 2)
  │    → produces wireframe files → transitions to wireframe_review → ...
```

---

## 6. Recommended build order

When rebuilding from scratch, build modules in **this sequence**. Each one can be tested in isolation before you move on.

1. **LLM Provider (Module 1)** — write `streamOpenRouter`. Test: call it with a real API key and verify token stream + usage.
2. **Parsers (Module 2)** — all pure functions. Test: feed hand-crafted inputs through every parser.
3. **Prompt Registry (Module 3)** — trivial. Test: register + get.
4. **Storage (Module 5)** — `MemoryStorage` first, then `FileStorage`. Test: the same test suite runs against both.
5. **Streaming (Module 4)** — SSEWriter. Test: capture output bytes and parse them.
6. **Operation Executor (Module 6)** — wires 1+2+3+4. Test: stub the LLM response, verify retry-on-parse-failure, token accumulation, timeouts.
7. **Context Builder (Module 7)** — depends on 3 and 5. Test with MemoryStorage + stubbed registry.
8. **Operations (Module 8)** — implement op-1-0 first (trivial), then op-1-1 (Two-AI), then Phase 2 ops. Test each in isolation with a subclassed stub executor.
9. **Dependency Graph (Module 9)** — standalone. Test with fake `execute` functions that just push to an array.
10. **Phase 2 Stage Machine (Module 10)** — trivial. Test transitions exhaustively.
11. **Session Manager (Module 11)** — wires everything server-side. Test with recorder stubs for the handlers.
12. **API Routes (Module 12)** — thin. Each route ~30 lines. Test by calling with fetch.
13. **UI (Module 13)** — last. Three Zustand stores + the SSE hook + a handful of components.

**At each step, aim for ~100% test coverage of pure modules (1, 2, 3, 9, 10) and integration coverage of stateful ones (5, 6, 11).**

---

## 7. Key design decisions worth preserving

Things we discovered the hard way. Worth keeping when rebuilding.

### 7.1 Slug-indirection for prompts
Ops don't import prompt strings — they look them up by slug on the registry. This lets you A/B test prompts, swap them at runtime, or move them to a database without touching op code.

### 7.2 Parser-per-prompt contract
Every LLM output has a single canonical parser. Retries feed the parser's error back to the model verbatim. Don't try to be clever with union parsers.

### 7.3 Role-based model routing
Ops declare a `role` (`fast` or `reasoning`), not a specific model. `resolveModel(role)` picks the actual slug from env. Swapping providers (Groq → OpenRouter in our case) becomes a one-file change.

### 7.4 DAG executor doesn't fail fast by default
Per-node exceptions are caught and recorded. This is intentional — sibling branches should keep running. **But callers must check the status map before moving on.** Have a single `assertDagSucceeded(dag, stageName)` helper; don't forget it anywhere.

### 7.5 Batch ops throw on total failure
If every item in a batch fails, the op itself must throw (not return `[]`). Otherwise the zero-result silently corrupts downstream ops. Partial failures are still OK.

### 7.6 Stage transitions happen AFTER validation
For multi-stage flows: validate inputs FIRST, then transition state. If validation throws, state stays in the prior review. You can always retry.

### 7.7 Storage is the single source of truth between stages
Don't try to pass in-memory state between stage runners. Each stage re-reads what it needs from the persisted documents. Crash recovery becomes trivial.

### 7.8 `sendComplete` closes the stream
Treat `sendComplete` as terminal — anything you need to send must go BEFORE it. Forgetting this was the cause of the "follow-up message creates new session" bug.

### 7.9 Client streams raw LLM output, but storage gets only `visibleResponse`
The `<generation_context>` block is internal. The chat bubble should show only the prose prefix. On the server, use a `createVisibleChunkFilter` that buffers chunks and stops forwarding at the opening tag. Persist `visibleResponse` to storage so session rehydration shows the same thing.

### 7.10 No in-memory state between stages → retries are free
Because each stage reads from storage, a failed stage can be retried just by re-running the runner. The crashed state doesn't leak.

### 7.11 Phase 2 runs as four user-approved stages, not one monolith
Never let the user wait 5+ minutes on a single operation. Break long flows into approvable chunks and let them course-correct after each.

### 7.12 Prompts enforce "surgical edits" discipline
The Phase 1 iteration prompt has explicit Mode 1 / Mode 2 / Mode 3 language and "preserve everything else verbatim" instructions. Without this the LLM rewrites the entire contract on every turn.

---

## 8. Minimal worked example — "hello world" rebuild

Here's the smallest possible rebuild that hits OpenRouter end-to-end:

### 8.1 Scaffold

```bash
npx create-next-app@latest hello-ux --ts --tailwind --app --src-dir --use-npm
cd hello-ux
npm install zustand yaml react-markdown remark-gfm uuid
npm install -D vitest @types/uuid
```

### 8.2 The LLM Provider module (~150 lines of real code)

Copy the spec in §3 Module 1 above. One file: `src/core/llm/openrouter-client.ts`.

### 8.3 A smoke route

```typescript
// src/app/api/smoke/route.ts
import { streamOpenRouter } from "@/core/llm/openrouter-client";

export async function GET() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      await streamOpenRouter({
        apiKey: process.env.OPENROUTER_API_KEY!,
        model: "inclusionai/ling-2.6-1t:free",
        systemPrompt: "You are terse.",
        messages: [{ role: "user", content: "Say hi" }],
        onChunk: (d) => controller.enqueue(encoder.encode(`data: ${d}\n\n`)),
      });
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
}
```

### 8.4 Verify

```bash
echo 'OPENROUTER_API_KEY=sk-or-v1-...' > .env.local
npm run dev
# separate terminal:
curl -N http://localhost:3000/api/smoke
# should stream: data: Hi\n\ndata: !\n\ndata: [DONE]\n\n
```

**Once this works, every other module is an additive step.**

---

## 9. Full file layout at completion

```
app/
├── src/
│   ├── app/
│   │   ├── api/                              ← Module 12
│   │   │   ├── chat/route.ts
│   │   │   ├── phase/complete/route.ts
│   │   │   ├── phase2/start/route.ts
│   │   │   ├── phase2/advance/route.ts
│   │   │   ├── rollback/route.ts
│   │   │   ├── sessions/route.ts
│   │   │   ├── sessions/[id]/route.ts
│   │   │   ├── tests/run/route.ts
│   │   │   ├── tests/diagnose/route.ts
│   │   │   ├── wireframe/[sessionId]/[filename]/route.ts
│   │   │   ├── export/route.ts
│   │   │   ├── health/route.ts
│   │   │   └── test-llm/route.ts
│   │   ├── page.tsx                          ← "use client" + next/dynamic ssr:false
│   │   ├── layout.tsx
│   │   └── globals.css                       ← no @plugin typography; hand-rolled prose
│   │
│   ├── components/                           ← Module 13
│   │   ├── AppShell.tsx
│   │   ├── SessionSidebar.tsx
│   │   ├── PhaseIndicator.tsx
│   │   ├── ChatPanel.tsx
│   │   ├── ChatInput.tsx
│   │   ├── DocumentPanel.tsx
│   │   ├── ApproveStageButton.tsx
│   │   ├── DriftWarning.tsx
│   │   ├── ErrorBoundary.tsx
│   │   └── phase2/
│   │       ├── WireframeViewer.tsx
│   │       └── TestResultsPanel.tsx
│   │
│   ├── stores/                               ← Module 13
│   │   ├── session-store.ts
│   │   ├── chat-store.ts
│   │   └── document-store.ts
│   │
│   ├── lib/
│   │   ├── use-sse.ts                        ← SSE client hook (Module 13)
│   │   └── constants.ts
│   │
│   └── core/
│       ├── bootstrap.ts                      ← DI wiring
│       ├── llm/                              ← Module 1
│       │   ├── providers.ts
│       │   └── openrouter-client.ts
│       ├── operation-executor/               ← Modules 2, 4, 6
│       │   ├── parsers.ts
│       │   ├── streaming.ts
│       │   ├── executor.ts
│       │   ├── retry.ts
│       │   ├── token-tracker.ts
│       │   ├── two-ai-pattern.ts
│       │   └── visible-chunk-filter.ts
│       ├── prompts/                          ← Module 3
│       │   ├── prompt-registry.ts
│       │   ├── phase1-prompts.ts
│       │   ├── phase2-autogen-prompts.ts
│       │   └── README.md
│       ├── storage/                          ← Module 5
│       │   ├── interface.ts
│       │   ├── file-storage.ts
│       │   ├── memory-storage.ts
│       │   └── index.ts
│       ├── wireframe/
│       │   └── wireframe-manager.ts
│       ├── context-builder/                  ← Module 7
│       │   ├── context-builder.ts
│       │   ├── summarizer.ts
│       │   └── phase2-context.ts
│       ├── operations/                       ← Module 8
│       │   ├── phase1/
│       │   │   ├── op-1-0-title.ts
│       │   │   ├── op-1-1-goal-expansion.ts
│       │   │   ├── op-1-2-iteration.ts
│       │   │   └── op-1-3-validation.ts
│       │   └── phase2/
│       │       ├── op-2-1-workflow-map.ts
│       │       ├── op-2-2-test-suite.ts
│       │       ├── op-2-3-screen-inventory.ts
│       │       ├── op-2-4-wireframe.ts
│       │       ├── op-2-5-tests.ts
│       │       ├── op-2-6-drift-check.ts
│       │       ├── op-2-7a-conversational.ts
│       │       ├── op-2-7-targeted-updates.ts
│       │       ├── op-2-9-diagnosis.ts
│       │       ├── op-2-10-validation.ts
│       │       └── batch-utils.ts
│       ├── session-manager/                  ← Modules 9, 10, 11
│       │   ├── session-manager.ts
│       │   ├── phase1-handlers.ts
│       │   ├── phase2-handlers.ts
│       │   ├── phase2-stage-machine.ts
│       │   ├── operation-router.ts
│       │   ├── phase-state-machine.ts
│       │   ├── dependency-graph.ts
│       │   ├── auto-generation-graph.ts
│       │   ├── cascade-router.ts
│       │   ├── cascade-executor.ts
│       │   ├── rollback.ts
│       │   └── session-resume.ts
│       └── types/
│           ├── index.ts
│           ├── session.ts
│           ├── documents.ts
│           ├── artifacts.ts
│           ├── chat.ts
│           ├── checkpoints.ts
│           ├── operations.ts
│           ├── tests.ts
│           ├── llm.ts
│           └── config.ts
│
├── data/                                     ← runtime storage (gitignored)
│   ├── sessions.json
│   ├── documents.json
│   ├── ...
│   └── sessions/<sessionId>/wireframe/*.html
│
├── .env.local
├── .env.example
├── package.json
└── tsconfig.json                             ← path aliases: @core/*, @components/*, @stores/*, @lib/*
```

---

## 10. The acceptance criteria

When you're done rebuilding, these should all work:

- [ ] `curl http://localhost:3000/api/health` returns `{"status":"ok","llm":{"provider":"openrouter","fast":"...","reasoning":"..."}}`
- [ ] `curl -N http://localhost:3000/api/test-llm?prompt=hi` streams a response
- [ ] Open `http://localhost:3000`, type "I want a recipe sharing app", hit Enter → session appears in sidebar, assistant response streams, contract document appears in right panel
- [ ] Type a follow-up like "add an admin persona" → contract updates (v2), other personas preserved
- [ ] Click **Done** → validation runs. If PASS, Phase 1 indicator goes green, design stage kicks off automatically.
- [ ] Design stage completes in ~1-2 min → Workflow Map + Screen Inventory visible in document panel → **Approve → Generate Wireframe** button appears
- [ ] Click Approve → Wireframe stage runs → Wireframe tab shows the iframe'd prototype
- [ ] Tests: 300+ unit tests, `npm run build` succeeds, `npx tsc --noEmit` clean

Each module tested in isolation. Each end-to-end flow tested manually per §10.

---

## Appendix — the 26 prompts

See `app/src/core/prompts/README.md` in the source tree for the authoritative catalog. Summary:

- **Phase 1 (4):** session title, conversational (used by Op 1.1 + Op 1.2), project contract generator (Call B of Two-AI), validation
- **Phase 2 auto-gen (16):** workflow discovery / detail / formatting; test case generation / coverage / formatting; screen extraction / nav validation / correction / formatting; dummy data / wireframe shell / screen HTML; test harness / translation / repair
- **Phase 2 interaction (5):** drift check, conversational (with change_context), targeted screen update, targeted workflow update, diagnosis
- **Phase 2 completion (1):** phase 2 validation

Every prompt is a static string function. No templating — variable data is supplied in user messages via the Context Builder.

---

**End of replication instructions.** If something here conflicts with the current codebase, the current codebase is canonical — update this doc accordingly.

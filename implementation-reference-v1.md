# Product Builder — Implementation Reference Document
# Version 1.0 — Complete Technical Specification

---

## Document Index

| Section | Title | Ref |
|---------|-------|-----|
| 1 | System Overview and Architecture | [§1](#1-system-overview-and-architecture) |
| 2 | Technology Stack and Dependencies | [§2](#2-technology-stack-and-dependencies) |
| 3 | Data Models and Storage | [§3](#3-data-models-and-storage) |
| 4 | Session Manager | [§4](#4-session-manager) |
| 5 | Operation Executor | [§5](#5-operation-executor) |
| 6 | Context Builder | [§6](#6-context-builder) |
| 7 | Phase 1 — Goal Definition | [§7](#7-phase-1--goal-definition) |
| 8 | Phase 2 — Auto-Generation Chain | [§8](#8-phase-2--auto-generation-chain) |
| 9 | Phase 2 — User Interaction Operations | [§9](#9-phase-2--user-interaction-operations) |
| 10 | Drift Detection System | [§10](#10-drift-detection-system) |
| 11 | Iteration Cascade Engine | [§11](#11-iteration-cascade-engine) |
| 12 | Wireframe Technical Specification | [§12](#12-wireframe-technical-specification) |
| 13 | Test Execution and Diagnosis System | [§13](#13-test-execution-and-diagnosis-system) |
| 14 | Rollback and Checkpoint System | [§14](#14-rollback-and-checkpoint-system) |
| 15 | UI Specification | [§15](#15-ui-specification) |
| 16 | Error Handling and Resumability | [§16](#16-error-handling-and-resumability) |
| 17 | All AI Prompts Reference | [§17](#17-all-ai-prompts-reference) |
| 18 | Operation Dependency Graph | [§18](#18-operation-dependency-graph) |
| 19 | Complete State Machine | [§19](#19-complete-state-machine) |

---

## 1. System Overview and Architecture

### 1.1 Purpose

This system is an AI-powered product definition tool. Users describe a product idea in natural language. The system guides them through structured phases to produce: a locked product definition, complete workflow maps, a comprehensive test suite, and an interactive clickable wireframe — all before any code is written for the actual product.

The system is NOT a code generator for the final product. It produces the specification and validation artifacts that would precede development. Future phases (not covered in this document) will handle actual development.

### 1.2 Pipeline Model

The system operates as a phased pipeline:

```
Checkpoint 1 → Phase 1 (Goal Definition) → Checkpoint 2 → Phase 2 (Workflow & UX) → Checkpoint 3
```

Each phase:
- Has a locked chat scope — the user can only work on that phase's concerns
- Produces documents consumed by subsequent phases
- Requires explicit user action ("Confirm phase complete") to advance
- Can be rolled back to the preceding checkpoint

### 1.3 Three-Layer Backend Architecture

```
┌──────────────────────────────────────────────────┐
│                    UI Layer                       │
│  (Chat, Document Panel, Wireframe Viewer, etc.)  │
└──────────────────┬───────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────┐
│              Session Manager                      │
│  - Phase state machine                           │
│  - Checkpoint management                         │
│  - Operation routing and progress tracking       │
│  - Artifact lifecycle                            │
│  - Rollback mechanics                            │
│  - Chat input blocking                           │
│  - Dependency graph enforcement                  │
└────────┬─────────────────────┬───────────────────┘
         │                     │
┌────────▼────────┐  ┌────────▼────────────────────┐
│ Context Builder  │  │   Operation Executor         │
│ - Per-operation  │  │   - pi-ai integration        │
│   context        │  │   - Streaming                │
│   assembly       │  │   - Output parsing           │
│ - Chat history   │  │   - Retry logic              │
│   summarization  │  │   - Error handling            │
│ - Document       │  └────────┬───────────────────┘
│   summaries      │           │
└─────────────────┘  ┌────────▼───────────────────┐
                     │        pi-ai                 │
                     │  (LLM provider abstraction)  │
                     └─────────────────────────────┘
```

**Session Manager**: The central coordinator. All user actions and system events pass through it. It decides which operation to invoke, tracks progress, manages state transitions, and enforces constraints (phase locking, chat blocking, dependency ordering).

**Context Builder**: Assembles the exact prompt for each operation. It is operation-aware — it knows what context each specific AI call needs and constructs the minimal, complete input. Handles chat history summarization and document summary generation.

**Operation Executor**: The only component that talks to pi-ai. Accepts an operation definition (system prompt, messages, expected output format), executes the streaming LLM call, parses the output, handles retries on failure, and returns structured results to the Session Manager.

### 1.4 Two-AI Pattern

Every user-facing operation uses two distinct AI roles. This is a universal pattern — no exceptions.

**Conversational AI (user-facing)**:
- Maintains dialogue context (chat history for current phase only)
- Understands user intent through accumulated conversation
- Fills in gaps with its own judgment — defaults to inferring, not asking
- Questions are rare — only when ambiguity would lead to fundamentally different products
- Produces a structured context block (invisible to user) for the document generator
- Visible response to user is 1-2 sentences maximum
- SEPARATE INSTANCE PER PHASE — Phase 2 does not inherit Phase 1 chat history

**Document/Task Generator (system-facing)**:
- Never sees chat history or raw user messages
- Receives ONLY the structured context block from the conversational AI
- Completely stateless — every call is independent
- Produces strictly formatted output (markdown documents, YAML data structures)
- No conversational ability — just formatting and structure

**Why this separation matters for implementation**: The conversational AI accumulates state (chat history) and needs sophisticated context management. The document generator is pure function: input → output. They use different system prompts, different context, and different output parsing. They must be implemented as separate AI call chains, not a single call that does both.

### 1.5 Key Architectural Constraints

1. **Users never edit documents directly.** All changes happen through chat with the conversational AI. The AI regenerates the document. This prevents inconsistencies and keeps drift detection reliable.

2. **Documents are the primary state, not chat history.** When phases transition, the document is passed forward. Chat history stays within its phase.

3. **The drift check evaluates structured data, not raw messages.** The conversational AI processes the user's message first and produces structured intent. The drift checker evaluates that structure — never the raw user text. See [§10](#10-drift-detection-system).

4. **Only affected artifacts regenerate during iteration.** The cascade engine ([§11](#11-iteration-cascade-engine)) determines the minimal set of artifacts to update. Full regeneration only happens after a Phase 1 rollback with contract changes.

5. **Chat input is blocked during all generative and cascade operations.** The user can view documents and the wireframe but cannot send messages until the current operation completes. See [§15.7](#157-chat-input-blocking-rules).

---

## 2. Technology Stack and Dependencies

### 2.1 LLM Integration

**Package**: `@mariozechner/pi-ai` from the pi-mono repository.

**Why this package**: Provides unified streaming API across 15+ LLM providers (Anthropic, OpenAI, Google, etc.), token and cost tracking, and handles provider-specific quirks. We use ONLY this package from pi-mono — not pi-agent-core, not pi-coding-agent.

**What we use from pi-ai**:
- `streamSimple()` or equivalent streaming function for LLM calls
- Multi-provider model selection (user can choose Claude, GPT-4, Gemini, etc.)
- Token counting and cost tracking per call
- Tool calling schemas (TypeBox) if needed for future operations

**What we do NOT use**:
- The agent loop from pi-agent-core (we build our own orchestration)
- The coding agent CLI, extensions, skills, or session management from pi-coding-agent
- Any terminal UI components

### 2.2 Application Framework

**Desktop app**: Electron (proven by Dyad for similar use case)
- Main process: AI pipeline, file operations, session storage, wireframe file management
- Renderer process: React UI
- IPC: Typed communication between main and renderer

**State management (renderer)**: Jotai or Zustand — lightweight reactive state.

### 2.3 Data Storage

**Session database**: SQLite via Drizzle ORM (local, embedded, no server needed)
- Stores: sessions, phases, documents, operation progress, chat messages, checkpoints

**Wireframe files**: Local filesystem
- Generated HTML, JS, and CSS files stored in a project directory per session

### 2.4 Wireframe Technology

Plain HTML files. No React, no framework, no build step.
- One HTML file per screen
- Inline CSS and JavaScript
- Shared `data.js` file for dummy data
- `test-harness.html` for automated test execution
- SQLite (via sql.js or similar browser-compatible library) if demo data storage is needed

---

## 3. Data Models and Storage

### 3.1 Session

```typescript
interface Session {
  id: string;                    // UUID
  title: string;                 // Auto-generated, 3-5 words
  currentPhaseId: PhaseId;       // Which phase is active
  createdAt: timestamp;
  updatedAt: timestamp;
  status: 'active' | 'suspended'; // Suspended during rollback
}
```

### 3.2 Phase State

```typescript
type PhaseId = 'phase-1' | 'phase-2';

type PhaseStatus = 
  | 'not_started'     // Phase has not been entered yet
  | 'active'          // User is currently working in this phase
  | 'completing'      // Validation is running
  | 'complete'        // Phase is locked
  | 'suspended';      // Phase is paused due to rollback

interface PhaseState {
  sessionId: string;
  phaseId: PhaseId;
  status: PhaseStatus;
  enteredAt: timestamp | null;
  completedAt: timestamp | null;
  suspendedAt: timestamp | null;
}
```

### 3.3 Documents

Documents are the primary output artifacts of each phase. They are versioned — each regeneration creates a new version, but only the latest is "active."

```typescript
type DocumentType = 
  | 'project_contract'    // Phase 1 output
  | 'workflow_map'        // Phase 2 document
  | 'test_suite'          // Phase 2 document
  | 'screen_inventory';   // Phase 2 document

interface Document {
  id: string;                    // UUID
  sessionId: string;
  phaseId: PhaseId;
  type: DocumentType;
  content: string;               // Markdown content (user-facing)
  structuredData: string;        // YAML/JSON underlying data (system-facing)
  version: number;               // Increments on each regeneration
  status: 'active' | 'inactive'; // Only one active version per type per session
  createdAt: timestamp;
  lastModifiedAt: timestamp;     // Used for stale test detection
}
```

**Critical**: Both `content` (markdown for display) and `structuredData` (YAML for system consumption) are stored. The markdown is what the user sees in the document panel. The YAML is what downstream operations consume. They represent the same information in different formats.

### 3.4 Artifacts

Artifacts are generated files — the wireframe HTML files and executable test files. They are not documents (not markdown, not YAML). They are code.

```typescript
type ArtifactType =
  | 'wireframe_shell'       // index.html
  | 'wireframe_screen'      // [screen-id].html
  | 'wireframe_data'        // data.js
  | 'test_harness'          // test-harness.html
  | 'test_definitions';     // tests.js

interface Artifact {
  id: string;
  sessionId: string;
  type: ArtifactType;
  filename: string;              // e.g., "product-detail.html"
  filePath: string;              // Full path in wireframe directory
  relatedScreenId: string | null; // For wireframe_screen type
  status: 'active' | 'inactive' | 'generating';
  createdAt: timestamp;
  lastModifiedAt: timestamp;     // Used for stale test detection
}
```

**Artifact lifecycle**:
- When an iteration starts, affected artifacts are set to `inactive`
- New artifacts are created with status `generating`
- On generation completion, status becomes `active` and old inactive artifacts are deleted
- Only one active artifact exists per filename per session

### 3.5 Operations

```typescript
type OperationId = 
  | 'op-1-0' | 'op-1-1' | 'op-1-2' | 'op-1-3'
  | 'op-2-1a' | 'op-2-1b' | 'op-2-1c'
  | 'op-2-2a' | 'op-2-2b' | 'op-2-2c'
  | 'op-2-3a' | 'op-2-3b' | 'op-2-3c' | 'op-2-3d'
  | 'op-2-4a' | 'op-2-4b' | 'op-2-4c' | 'op-2-4d' | 'op-2-4e'
  | 'op-2-5a' | 'op-2-5b' | 'op-2-5c' | 'op-2-5d' | 'op-2-5e'
  | 'op-2-6' | 'op-2-7a' | 'op-2-7b' | 'op-2-7c' | 'op-2-7d'
  | 'op-2-7e' | 'op-2-7f' | 'op-2-7g' | 'op-2-7h' | 'op-2-7i'
  | 'op-2-8' | 'op-2-9' | 'op-2-10';

type OperationStatus = 
  | 'not_started'
  | 'in_progress'
  | 'complete'
  | 'failed'
  | 'skipped';       // User chose to skip after failure

interface OperationProgress {
  sessionId: string;
  operationId: OperationId;
  status: OperationStatus;
  startedAt: timestamp | null;
  completedAt: timestamp | null;
  error: string | null;          // Error message if failed
  
  // For batch operations (2.1b, 2.2a, 2.4c, 2.5b)
  batchItems: BatchItem[] | null;
}

interface BatchItem {
  itemId: string;                // e.g., workflow ID or screen ID
  itemName: string;              // Human-readable name
  status: OperationStatus;
  error: string | null;
  retryCount: number;            // 0, 1, or 2
}
```

### 3.6 Chat Messages

```typescript
type MessageRole = 'user' | 'assistant' | 'system';

type MessageType =
  | 'chat'                       // Normal conversation
  | 'system_notification'        // Phase transition, progress updates
  | 'drift_warning'              // Drift detection result
  | 'validation_result'          // Phase completion validation
  | 'test_results'               // Test execution results (UI component)
  | 'diagnosis_result'           // Test failure diagnosis
  | 'operation_failure';         // Failed operation notification

interface ChatMessage {
  id: string;
  sessionId: string;
  phaseId: PhaseId;              // Which phase this message belongs to
  role: MessageRole;
  type: MessageType;
  content: string;               // Visible text content
  metadata: MessageMetadata;
  createdAt: timestamp;
}

interface MessageMetadata {
  screenReference: string | null;        // Screen ID if user selected one
  generationContext: string | null;      // The <generation_context> or <change_context> block (invisible to user)
  operationId: OperationId | null;       // Which operation produced this message
  stale: boolean;                        // For test results — set to true after wireframe changes
}
```

### 3.7 Checkpoints

```typescript
interface Checkpoint {
  id: string;
  sessionId: string;
  phaseId: PhaseId;              // Phase that was just completed
  number: number;                // 1, 2, 3...
  createdAt: timestamp;
  
  // Snapshot of all documents at this point
  documentSnapshots: DocumentSnapshot[];
  
  // Snapshot of all artifacts at this point
  artifactSnapshots: ArtifactSnapshot[];
}

interface DocumentSnapshot {
  documentId: string;
  content: string;
  structuredData: string;
  version: number;
}

interface ArtifactSnapshot {
  artifactId: string;
  filename: string;
  fileContent: string;           // Full file content at checkpoint time
}
```

### 3.8 Test Results

```typescript
interface TestRunResult {
  id: string;
  sessionId: string;
  runAt: timestamp;              // CRITICAL: compared against artifact lastModifiedAt for stale detection
  totalTests: number;
  passed: number;
  failed: number;
  knownIssues: number;
  duration: number;              // Total milliseconds
  results: IndividualTestResult[];
}

interface IndividualTestResult {
  testId: string;
  testName: string;
  workflowId: string;
  status: 'pass' | 'fail' | 'known_issue';
  duration: number;
  failedStep: number | null;
  failedStepDescription: string | null;
  errorMessage: string | null;
}
```

### 3.9 Pending Messages (for drift rollback)

```typescript
interface PendingMessage {
  id: string;
  sessionId: string;
  originalMessage: string;       // The raw user message
  changeContext: string;         // The <change_context> produced by conversational AI
  driftClassification: string;   // 'FLAG' or 'DRIFT'
  driftReason: string;
  createdAt: timestamp;
  status: 'pending' | 'applied' | 'discarded';
}
```

### 3.10 Conversation Summaries (for context management)

```typescript
interface ConversationSummary {
  sessionId: string;
  phaseId: PhaseId;
  summary: string;               // Running text summary of all changes made
  lastUpdatedAt: timestamp;
  messagesCovered: number;       // How many messages this summary covers
}
```

This summary is maintained by the Context Builder. After each iteration in Phase 2, the summary is updated to include: "Iteration N: [what was changed] — affected [which artifacts]." This is used in the conversational AI's context for Phase 2 (see [§6.2](#62-phase-2-context-assembly)).

---

## 4. Session Manager

### 4.1 Session Lifecycle

```
New Session
  ├── User types first message (no session selected in sidebar)
  │   ├── Create Session record (status: active)
  │   ├── Create PhaseState for phase-1 (status: active)
  │   ├── Fire Operation 1.0 (title) in parallel
  │   ├── Fire Operation 1.1 (goal expansion)
  │   └── UI: session appears in sidebar, phase indicator shows Phase 1 active
  │
  ├── User iterates (sends follow-up messages in Phase 1)
  │   ├── Fire Operation 1.2 (iteration)
  │   └── Document regenerates
  │
  ├── User clicks "Confirm phase complete" (Phase 1)
  │   ├── Fire Operation 1.3 (validation)
  │   ├── If PASS:
  │   │   ├── PhaseState phase-1 → status: complete
  │   │   ├── Create Checkpoint (number: 2)
  │   │   ├── PhaseState phase-2 → status: active
  │   │   ├── Initialize Phase 2 conversational AI (new instance, receives Project Contract)
  │   │   ├── Block chat input
  │   │   ├── Begin auto-generation chain (Operations 2.1-2.5)
  │   │   └── UI: phase indicator updates, system message posted
  │   └── If FAIL:
  │       ├── Show issues in chat
  │       ├── Inject issues into conversational AI context
  │       └── Phase 1 stays active
  │
  ├── Auto-generation chain completes
  │   ├── Unblock chat input
  │   ├── System message: "Wireframe and tests ready"
  │   └── User can now chat, view wireframe, run tests
  │
  ├── User iterates in Phase 2
  │   ├── Conversational AI processes message → produces <change_context>
  │   ├── Drift check evaluates <change_context>
  │   ├── If passes: cascade executes
  │   ├── If FLAG: user chooses to continue or roll back
  │   └── If DRIFT: user must roll back
  │
  ├── User clicks "Confirm phase complete" (Phase 2)
  │   ├── Code-level checks first (see §9.5)
  │   ├── Then AI validation (Operation 2.10)
  │   ├── If PASS: PhaseState phase-2 → complete, Checkpoint 3 created
  │   └── If FAIL: issues shown, Phase 2 stays active
  │
  └── Session restore (user reopens app)
      ├── Load session state from database
      ├── Restore to exact state: same phase, same documents, same chat
      ├── If an operation was in_progress: resume from last completed sub-operation
      └── UI: renders exactly as user left it
```

### 4.2 Phase State Machine

```
              ┌─────────────┐
              │ not_started  │
              └──────┬───────┘
                     │ (previous phase completes)
              ┌──────▼───────┐
         ┌────│   active     │◄───────────┐
         │    └──────┬───────┘            │
         │           │                     │
         │    ┌──────▼───────┐            │
         │    │ completing   │            │ (validation fails)
         │    └──────┬───────┘            │
         │           │                     │
         │           ├─── PASS ──►┌───────┴────┐
         │           │            │  complete   │
         │           └─── FAIL ───┘            │
         │                                     │
         │    (rollback from later phase)      │
         │    ┌──────────────┐                 │
         └───►│  suspended   │─── (restored) ──┘
              └──────────────┘
```

### 4.3 Operation Routing

When a user message arrives, the Session Manager determines the correct action:

```
User message arrives
  │
  ├── Is chat input blocked?
  │   └── YES → Ignore message, show "Please wait for current operation to complete"
  │
  ├── What phase is active?
  │
  ├── Phase 1:
  │   ├── Is this the first message ever? (no documents exist)
  │   │   └── YES → Route to Operation 1.1 (Goal Expansion)
  │   └── NO → Route to Operation 1.2 (Iteration)
  │
  └── Phase 2:
      └── Route to Operation 2.7a (Conversational AI)
          ├── If <change_context> produced → Route to Operation 2.6 (Drift Check)
          └── If clarifying question → Display in chat, wait for response
```

### 4.4 Dependency Graph Enforcement

The auto-generation chain has a strict dependency graph. The Session Manager enforces this:

```typescript
const DEPENDENCY_GRAPH: Record<OperationId, OperationId[]> = {
  'op-2-1a': [],                           // No dependencies — starts immediately
  'op-2-1b': ['op-2-1a'],                  // Needs workflow discovery
  'op-2-1c': ['op-2-1b'],                  // Needs all workflow details
  'op-2-2a': ['op-2-1c'],                  // Needs completed Workflow Map
  'op-2-2b': ['op-2-1c'],                  // Needs completed Workflow Map
  'op-2-2c': ['op-2-2a', 'op-2-2b'],       // Needs all test cases + coverage
  'op-2-3a': ['op-2-1c'],                  // Needs completed Workflow Map
  'op-2-3b': ['op-2-3a'],                  // Needs screen extraction
  'op-2-3c': ['op-2-3b'],                  // Conditional — only if validation found issues
  'op-2-3d': ['op-2-3a'],                  // Needs final screen inventory (after 2.3c if it ran)
  'op-2-4a': ['op-2-2c', 'op-2-3d'],       // Needs both Test Suite AND Screen Inventory complete
  'op-2-4b': ['op-2-3d'],                  // Needs Screen Inventory (can parallel with 2.4a)
  'op-2-4c': ['op-2-4a'],                  // Needs dummy data
  'op-2-4d': ['op-2-4c'],                  // Needs all screen HTML files
  'op-2-4e': ['op-2-4a'],                  // Needs dummy data JSON
  'op-2-5a': ['op-2-4d'],                  // Needs wireframe complete
  'op-2-5b': ['op-2-4d', 'op-2-2c'],       // Needs wireframe HTML + test suite
  'op-2-5c': ['op-2-5b'],                  // Needs all test translations
  'op-2-5d': ['op-2-5c'],                  // Needs test bundle
  'op-2-5e': ['op-2-5d'],                  // Conditional — only if dry run found failures
};

function canStart(operationId: OperationId): boolean {
  const dependencies = DEPENDENCY_GRAPH[operationId];
  return dependencies.every(depId => getOperationStatus(depId) === 'complete');
}
```

The Session Manager runs a scheduler loop during the auto-generation chain:
1. Check all operations in the graph
2. For each `not_started` operation, check if all dependencies are `complete`
3. If yes, start the operation
4. Operations that can run in parallel (same dependency level) start simultaneously
5. Loop continues until all operations are `complete` or a blocking failure occurs

### 4.5 Artifact Lifecycle Management

```
Artifact states:

  generating → active → inactive → deleted
                  │
                  └── (iteration starts for this artifact)
                       │
                       ├── Set current to inactive
                       ├── Create new with status: generating
                       ├── On completion: new → active, old → deleted
                       └── On failure: new → deleted, old → restored to active
```

**Rules:**
- Only ONE active artifact per filename per session at any time
- During iteration, the old artifact is set to inactive BEFORE the new one starts generating
- If generation fails, the old artifact is restored to active (not left in inactive limbo)
- The UI shows inactive artifacts as dimmed/disabled with "updating" overlay

### 4.6 Test Result Staleness Tracking

```typescript
function areTestResultsStale(sessionId: string): boolean {
  const lastTestRun = getLatestTestRunResult(sessionId);
  if (!lastTestRun) return true; // Never run
  
  const lastArtifactModification = getLatestArtifactModificationTime(sessionId);
  return lastArtifactModification > lastTestRun.runAt;
}
```

**When test results become stale:**
- After any iteration cascade (Operation 2.7) completes
- After any diagnosis fix (Operation 2.9) is applied

**What happens when stale:**
- Test results UI component is dimmed with banner: "These results are from a previous version. Run tests again."
- "Diagnose" buttons are disabled on all test results
- Phase completion (Operation 2.10) blocks with: "The wireframe has changed since tests were last run. Please run tests again."

---

## 5. Operation Executor

### 5.1 Interface

```typescript
interface OperationDefinition {
  operationId: OperationId;
  systemPrompt: string;
  messages: LLMMessage[];        // The user/system messages for this call
  expectedOutputFormat: 'markdown' | 'yaml' | 'json' | 'plain_text' | 'structured';
  outputParser: (rawOutput: string) => ParsedOutput | ParseError;
  maxRetries: number;            // Default: 1
  retryPrompt: string | null;    // Additional instruction appended on retry
  timeoutMs: number;             // Per-call timeout
}

interface ParsedOutput {
  success: true;
  data: any;                     // Parsed structured data
  rawText: string;               // Original LLM output
}

interface ParseError {
  success: false;
  error: string;                 // What went wrong
  rawText: string;               // Original LLM output for debugging
}

interface OperationResult {
  operationId: OperationId;
  status: 'success' | 'failed';
  output: ParsedOutput | null;
  error: string | null;
  tokenUsage: { input: number; output: number };
  cost: number;                  // In USD
  durationMs: number;
}
```

### 5.2 Execution Flow

```
OperationDefinition received
  │
  ├── Validate inputs (system prompt present, messages non-empty)
  │
  ├── Call pi-ai streaming API
  │   ├── Stream response chunks to UI (if this is a user-facing operation)
  │   └── Accumulate full response text
  │
  ├── Parse output using operationDefinition.outputParser
  │   ├── If parse succeeds → return OperationResult (success)
  │   └── If parse fails:
  │       ├── If retries remaining:
  │       │   ├── Append retryPrompt to messages
  │       │   ├── Re-call pi-ai
  │       │   └── Re-parse
  │       └── If no retries remaining → return OperationResult (failed)
  │
  └── Record token usage and cost
```

### 5.3 Retry Logic

Default retry count: 1 (total of 2 attempts).

**Retry prompt construction:**
```
The previous response could not be parsed correctly.
Error: [parse error description]

Please regenerate your response following the exact format specified in the instructions.
[Original system prompt's format section repeated]
```

**For batch operations** (2.1b, 2.2a, 2.4c, 2.5b), retry is per-item:
- If one workflow detail call fails, only that workflow is retried
- Other workflows in the batch continue independently
- After second failure of the same item, it is marked as failed and the user is notified (see [§16.2](#162-batch-operation-failures))

### 5.4 Streaming

For user-facing operations (conversational AI responses), the LLM output is streamed to the UI in real-time. The user sees the response being typed out.

For system-facing operations (document generators, workflow detail generation), streaming is used internally for performance but the output is only displayed to the user after parsing is complete and the document is assembled.

**Exception**: During the auto-generation chain, the Workflow Map document (2.1c output) is displayed progressively as workflows are generated, showing partial content in the document panel. This requires the document generator to produce valid markdown even when only some workflows are available.

---

## 6. Context Builder

### 6.1 Phase 1 Context Assembly

**For Operation 1.1 (first message):**
```
Context = {
  systemPrompt: Phase 1 conversational AI prompt (see §17.2),
  messages: [
    { role: 'user', content: [user's raw first message] }
  ]
}
```

**For Operation 1.2 (iteration):**
```
Context = {
  systemPrompt: Phase 1 conversational AI prompt (see §17.2),
  messages: [
    // Full Phase 1 chat history (user + assistant messages)
    // If history exceeds token budget, older messages are summarized:
    //   - Keep the most recent 5 message pairs in full
    //   - Replace older messages with a summary paragraph
    //   - The current Project Contract always represents accumulated state,
    //     so older chat details are less important
    { role: 'user', content: [message 1] },
    { role: 'assistant', content: [response 1] },
    ...
    { role: 'user', content: [latest user message] }
  ]
}
```

**For Document Generator (Call B in both 1.1 and 1.2):**
```
Context = {
  systemPrompt: Document Generator prompt (see §17.3),
  messages: [
    { role: 'user', content: "Generate the Project Contract from this context:\n\n[extracted <generation_context> content]" }
  ]
}
// No chat history. No prior documents. Just the context block.
```

### 6.2 Phase 2 Context Assembly

**For Operation 2.7a (Phase 2 conversational AI):**

This is the most complex context assembly. The context must be comprehensive without bloating the context window.

```
Context = {
  systemPrompt: Phase 2 conversational AI prompt (see §17.11),
  messages: [
    // System context message (always first):
    {
      role: 'system',
      content: buildPhase2SystemContext(sessionId)
    },
    // Phase 2 chat history (recent messages):
    // Keep last 5 message pairs in full
    // Older messages are represented by the conversation summary
    ...recentMessages,
    // Current user message:
    { role: 'user', content: [user message including screen reference metadata] }
  ]
}
```

**buildPhase2SystemContext function:**

```typescript
function buildPhase2SystemContext(sessionId: string): string {
  const contract = getActiveDocument(sessionId, 'project_contract');
  const conversationSummary = getConversationSummary(sessionId, 'phase-2');
  const screenRef = getCurrentScreenReference(); // From wireframe viewer
  
  let context = '';
  
  // 1. Project Contract — always included in full (it's small)
  context += `## Project Contract\n${contract.content}\n\n`;
  
  // 2. Conversation summary — running log of all Phase 2 changes
  if (conversationSummary) {
    context += `## Changes Made So Far in Phase 2\n${conversationSummary.summary}\n\n`;
  }
  
  // 3. Workflow Map state — comprehensive summary
  const workflowMap = getActiveDocument(sessionId, 'workflow_map');
  context += `## Current Workflow Map\n`;
  context += buildWorkflowSummary(workflowMap, conversationSummary);
  context += '\n\n';
  
  // 4. Screen Inventory state — comprehensive summary
  const screenInventory = getActiveDocument(sessionId, 'screen_inventory');
  context += `## Current Screen Inventory\n`;
  context += buildScreenSummary(screenInventory, conversationSummary);
  context += '\n\n';
  
  // 5. If user selected a screen — full detail for that screen
  if (screenRef) {
    context += `## Currently Viewed Screen (Full Detail)\n`;
    context += getFullScreenDetail(screenInventory, screenRef);
    context += '\n\n';
    context += `## Workflows Touching This Screen\n`;
    context += getWorkflowsForScreen(workflowMap, screenRef);
    context += '\n\n';
  }
  
  return context;
}
```

**buildWorkflowSummary function:**

For each workflow: ID, name, persona, category, number of happy path steps, number of edge cases.

For workflows modified in the last 3 iterations (determined from conversation summary): include a brief before/after description. Example:
```
- **browse-products** (modified in iteration 3): Before: 4 happy path steps, 2 edge cases. 
  Change: Added "filter by category" step after step 2. After: 5 happy path steps, 3 edge cases 
  (new edge case: no products match filter).
```

For unmodified workflows: just the summary line.

**buildScreenSummary function:**

Same pattern. For each screen: ID, name, type, number of actions. For recently modified screens, include before/after. For the currently viewed screen (if any), full detail is provided separately.

### 6.3 Context for System-to-System Operations

System-to-system operations (drift check, document generators, workflow detail generation, test case generation, etc.) receive ONLY the specific data they need. No chat history. No summaries. Just the structured inputs defined in each operation's specification.

The Context Builder has a specific function for each operation that assembles exactly the right input. These are documented in each operation's section ([§7](#7-phase-1--goal-definition), [§8](#8-phase-2--auto-generation-chain), [§9](#9-phase-2--user-interaction-operations)).

### 6.4 Chat History Summarization Strategy

When chat history in a phase exceeds the token budget (configurable, default: 4000 tokens for chat history portion):

1. Keep the most recent 5 message pairs (user + assistant) in full
2. For older messages, generate a summary using a lightweight AI call:

```
System: "Summarize the following conversation into a brief paragraph capturing all decisions made, changes requested, and current state. Do not omit any decision or change — this summary replaces the original messages."

User: [older messages to summarize]
```

3. The summary replaces the older messages in context
4. The current documents always represent the accumulated state, so the summary only needs to capture the *reasoning* behind decisions, not the decisions themselves (those are in the documents)

### 6.5 Phase 2 Conversation Summary Maintenance

After every Phase 2 iteration (Operation 2.7 cascade completion), the Context Builder updates the running conversation summary:

```typescript
function updateConversationSummary(
  sessionId: string,
  iterationNumber: number,
  changeDescription: string,    // From <change_context> description field
  scope: string,                // data_only, screen_only, workflow_change
  affectedArtifacts: string[]   // List of affected workflow/screen IDs
): void {
  const existing = getConversationSummary(sessionId, 'phase-2');
  const newEntry = `Iteration ${iterationNumber}: ${changeDescription} ` +
    `[scope: ${scope}, affected: ${affectedArtifacts.join(', ')}]`;
  
  const updatedSummary = existing
    ? existing.summary + '\n' + newEntry
    : newEntry;
  
  saveConversationSummary(sessionId, 'phase-2', updatedSummary);
}
```

This summary is always included in the Phase 2 conversational AI's context, giving it full awareness of what has changed across all iterations.

---

## 7. Phase 1 — Goal Definition

### 7.1 Phase 1 Entry

**Trigger**: User types a message with no session selected, or clicks "New chat" and types.

**Actions**:
1. Create Session record
2. Create PhaseState for phase-1 (status: active)
3. Create Checkpoint 1 (empty — represents the start)
4. Fire Operation 1.0 (title) in parallel
5. Fire Operation 1.1 (goal expansion)

### 7.2 Operation 1.0 — Session Title Generation

**Type**: Direct AI call (utility, not two-AI pattern)
**Fires**: In parallel with Operation 1.1
**Input**: User's first message only
**AI call**: See prompt in [§17.1](#171-operation-10--session-title)
**Output validation**: Strip whitespace, word count must be 3-5, no markdown or quotes
**Retry**: Once on validation failure
**Fallback**: Truncate user's first message to first 5 words
**Side effect**: Update Session.title

### 7.3 Operation 1.1 — Goal Expansion and Contract Generation

**Type**: Two-AI pattern
**Fires**: On user's first message

**Step 1 — Conversational AI (Call A)**:
- System prompt: [§17.2](#172-phase-1-conversational-ai)
- Input: User's first message
- Output expected: 1-2 sentence visible response + `<generation_context>` block
- Output parsing: Extract text before `<generation_context>` as visible response. Extract content within `<generation_context>` tags as structured data.
- If no `<generation_context>` found: treat entire response as a clarifying question. Display in chat. Do NOT fire Call B. Wait for user's next message.

**Step 2 — Document Generator (Call B)**:
- Fires: Only if Step 1 produced a `<generation_context>`
- System prompt: [§17.3](#173-document-generator--project-contract)
- Input: The extracted `<generation_context>` content
- Output expected: Markdown with exactly four sections (## Goal Statement, ## Personas, ## Entity Map, ## Boundaries)
- Output parsing: Split by `##` headers. Validate four sections exist. Each section must be non-empty (more than just the header).
- If parsing fails: Retry once with correction prompt. If fails again, show error to user: "Document generation failed. Please try rephrasing your description."
- On success: Store as Document (type: project_contract). Display in 60% panel (auto-open split view on first generation).

**Step 3 — Display**:
- Chat: Show the visible response from Step 1
- Document panel: Show the generated Project Contract from Step 2

### 7.4 Operation 1.2 — Iteration

**Type**: Two-AI pattern (same as 1.1)
**Fires**: Every subsequent user message during Phase 1

**Identical to 1.1** except:
- The conversational AI receives the full Phase 1 chat history (summarized if needed per [§6.4](#64-chat-history-summarization-strategy))
- The `<generation_context>` is always a COMPLETE snapshot reflecting ALL accumulated information
- The document generator always produces a complete Project Contract (replaces previous version)
- Document version increments

**Clarifying question detection**: If the conversational AI's response does NOT contain `<generation_context>` tags, it's a clarifying question. Display it in chat. Wait for user's next message. Do not update the document.

### 7.5 Operation 1.3 — Phase Completion Validation

**Type**: Direct AI call (not two-AI pattern)
**Fires**: User clicks "Confirm phase complete"

**Input**: Current active Project Contract (markdown content)
**System prompt**: [§17.4](#174-operation-13--phase-1-validation)
**Output parsing**: Extract STATUS line (must be exactly "PASS" or "FAIL"). Extract ISSUES list (lines starting with "- " after ISSUES header). Extract SUGGESTIONS list (same format after SUGGESTIONS header).

**If STATUS = PASS**:
1. Set PhaseState phase-1 to 'complete'
2. Create Checkpoint 2 (snapshot current Project Contract)
3. If SUGGESTIONS present: show as informational note in chat (non-blocking)
4. Set PhaseState phase-2 to 'active'
5. Initialize Phase 2 (see [§8.1](#81-phase-2-initialization))

**If STATUS = FAIL**:
1. Show ISSUES in chat as a system_notification message
2. Inject the ISSUES into the conversational AI's context (add as a system message in its history): "Phase 1 validation found these issues: [issues]. Help the user address them."
3. Phase 1 stays active
4. User can iterate to fix issues and try "Confirm phase complete" again

---

## 8. Phase 2 — Auto-Generation Chain

### 8.1 Phase 2 Initialization

**Trigger**: Phase 1 completes successfully.

**Actions**:
1. Create new conversational AI instance for Phase 2 (does NOT inherit Phase 1 chat history)
2. Initialize Phase 2 conversational AI context with the locked Project Contract
3. Block chat input
4. Post system message in chat: "Starting Phase 2: Analyzing workflows and generating interactive prototype. This may take a few minutes."
5. Begin auto-generation chain (start Operation 2.1a)

### 8.2 Operation 2.1 — Workflow Map Generation

#### 8.2.1 Sub-operation 2.1a — Workflow Discovery

**Type**: Direct AI call
**Fires**: Automatically when Phase 2 begins
**Input**: Full Project Contract markdown
**System prompt**: [§17.5](#175-operation-21a--workflow-discovery)
**Output format**: YAML
**Output parsing**: Parse YAML. Validate each workflow stub has: id, persona, name, description, trigger, category. Validate persona names match those in the Project Contract.
**On success**: Store workflow stubs as internal data. Start 2.1b for each workflow.
**On failure**: Retry once. If fails again, show error to user. Block the chain.

#### 8.2.2 Sub-operation 2.1b — Workflow Detail Generation

**Type**: Direct AI call, one per workflow (parallelizable)
**Fires**: For each workflow stub from 2.1a
**Input**: Full Project Contract + single workflow stub
**System prompt**: [§17.6](#176-operation-21b--workflow-detail-generation)
**Output format**: YAML
**Output parsing**: Parse YAML. Validate workflow has: happy_path (non-empty array of steps), outcome, edge_cases (can be empty but must be present). Each step must have: step number, actor, action, system_response, screen.
**Parallelization**: All workflow detail calls can run simultaneously. Bounded by API rate limits.
**Failure handling**: Retry once per workflow. If fails again after retry, mark as failed. Continue with remaining workflows. At batch completion, notify user of any failures with reason and options to retry or skip.
**Progress tracking**: Each workflow is a BatchItem in the OperationProgress record.

#### 8.2.3 Sub-operation 2.1c — Workflow Map Assembly and Formatting

**Type**: Code assembly + Document Generator AI call
**Fires**: After ALL 2.1b calls complete (or are skipped by user)
**Step 1** (code): Group workflow YAMLs by persona. Create a workflows collection with all completed workflows.
**Step 2** (AI): Send to document generator for markdown formatting.
**System prompt**: [§17.7](#177-operation-21c--workflow-map-formatting)
**Input**: Concatenated workflow YAMLs
**Output**: Markdown document
**Storage**: Store as Document (type: workflow_map). Both the markdown (content) and the concatenated YAML (structuredData) are saved.
**UI**: Display in document panel progressively (user is watching).

### 8.3 Operation 2.2 — Test Suite Generation

**Runs in parallel with Operation 2.3.** Both start after 2.1c completes.

#### 8.3.1 Sub-operation 2.2a — Test Case Generation

**Type**: Direct AI call, one per workflow (parallelizable)
**Fires**: For each workflow in the completed Workflow Map
**Input**: Project Contract + single complete workflow YAML
**System prompt**: [§17.8](#178-operation-22a--test-case-generation)
**Output format**: YAML
**Output parsing**: Parse YAML. Validate each test case has: id, name, workflow_id, path, given, when (array), then (array with assertions).
**Parallelization**: All test case generation calls run simultaneously.
**Failure handling**: Same as 2.1b — retry once, then notify user.

#### 8.3.2 Sub-operation 2.2b — Entity Coverage Check

**Type**: Direct AI call
**Fires**: Can run in parallel with 2.2a
**Input**: Entity Map section from Project Contract + all workflow YAMLs
**System prompt**: [§17.9](#179-operation-22b--entity-coverage-check)
**Output format**: YAML
**Output**: Coverage report. Stored as metadata on the Test Suite document. Surfaced during Phase 2 validation (Operation 2.10).

#### 8.3.3 Sub-operation 2.2c — Test Suite Assembly and Formatting

**Type**: Code assembly + Document Generator AI call
**Fires**: After ALL 2.2a calls complete AND 2.2b completes
**Input**: All test case YAMLs + coverage report
**System prompt**: [§17.10](#1710-operation-22c--test-suite-formatting)
**Output**: Markdown document
**Storage**: Store as Document (type: test_suite). Markdown as content, concatenated test case YAML as structuredData.

### 8.4 Operation 2.3 — Screen Inventory Generation

**Runs in parallel with Operation 2.2.** Both start after 2.1c completes.

#### 8.4.1 Sub-operation 2.3a — Screen Extraction

**Type**: Direct AI call
**Input**: Project Contract + all workflow YAMLs concatenated
**System prompt**: [§17.12](#1712-operation-23a--screen-extraction)
**Output format**: YAML
**Output parsing**: Parse YAML. Validate each screen has: id, name, type (ui/system_info), description, personas_who_see_it, workflows_that_use_it, actions_available, data_displayed, entry_point. Validate exactly one screen has entry_point: true.

**Context window handling**: If all workflow YAMLs exceed 80% of the model's context window, split by persona — extract screens for each persona's workflows separately, then run a deduplication call. For most products this won't be necessary.

#### 8.4.2 Sub-operation 2.3b — Navigation Map Validation

**Type**: Direct AI call
**Fires**: After 2.3a completes
**Input**: Screen inventory YAML + all workflow YAMLs
**System prompt**: [§17.13](#1713-operation-23b--navigation-validation)
**Output format**: YAML
**Checks**: Dead ends, orphan screens, missing back navigation, workflow step coverage
**If status = pass**: Proceed to 2.3d (skip 2.3c)
**If status = has_issues**: Proceed to 2.3c

#### 8.4.3 Sub-operation 2.3c — Screen Inventory Correction (conditional)

**Type**: Direct AI call
**Fires**: Only if 2.3b found issues
**Input**: Original screen inventory YAML + fixes from 2.3b
**System prompt**: [§17.14](#1714-operation-23c--screen-correction)
**Output**: Corrected screen inventory YAML. Replaces 2.3a output.

#### 8.4.4 Sub-operation 2.3d — Screen Inventory Document Formatting

**Type**: Document Generator AI call
**Fires**: After 2.3a (or 2.3c if it ran)
**Input**: Final screen inventory YAML
**System prompt**: [§17.15](#1715-operation-23d--screen-inventory-formatting)
**Output**: Markdown document
**Storage**: Store as Document (type: screen_inventory). Markdown as content, screen YAML as structuredData.

### 8.5 Operation 2.4 — Wireframe Code Generation

**Fires**: After BOTH Operation 2.2 AND Operation 2.3 are complete (synchronization point).

#### 8.5.1 Sub-operation 2.4a — Dummy Data Generation

**Type**: Direct AI call
**Input**: Entity Map from Project Contract + workflow data references
**System prompt**: [§17.16](#1716-operation-24a--dummy-data-generation)
**Output format**: JSON
**Output parsing**: Parse JSON. Validate each entity from Entity Map has a corresponding array. Validate internal consistency (cross-references resolve).
**On success**: Store JSON internally. Will be written as data.js in 2.4e.

#### 8.5.2 Sub-operation 2.4b — Wireframe Shell Generation

**Type**: Direct AI call
**Fires**: In parallel with 2.4a (only needs screen list, not dummy data)
**Input**: Screen inventory YAML (IDs, names, types, entry_point only)
**System prompt**: [§17.17](#1717-operation-24b--wireframe-shell)
**Output**: Complete index.html content
**Storage**: Write to wireframe directory as index.html. Create Artifact record (type: wireframe_shell).

**Required shell features** (the AI must implement all of these):
- Navigation sidebar listing all screens (UI screens first, System Info screens separated)
- Content area that loads screen HTML files (via iframe or dynamic loading)
- Current screen name and ID displayed prominently at the top
- `window.getCurrentScreenId()` function
- `window.navigateTo(screenId)` function
- `screenChanged` CustomEvent fired on window when navigation occurs (detail: { screenId: string })
- Minimal wireframe styling: gray backgrounds, black borders, sans-serif, blue for interactive elements

#### 8.5.3 Sub-operation 2.4c — Individual Screen Generation

**Type**: Direct AI call, one per screen (parallelizable after 2.4a completes)
**Input**: Single screen YAML + filtered dummy data + relevant workflow steps
**System prompt**: [§17.18](#1718-operation-24c--screen-html-generation)
**Output**: Complete HTML file content
**Storage**: Write as [screen-id].html in wireframe directory. Create Artifact record (type: wireframe_screen, relatedScreenId: screen ID).

**Critical requirement — deterministic element IDs**: The system prompt MUST instruct the AI to use deterministic, purpose-based IDs. Pattern: `[entity]-[field]-[element-type]`. Examples: `product-name-heading`, `add-to-cart-button`, `product-list-table`, `checkout-submit-button`. The same screen with the same content must produce the same IDs on regeneration. This is essential for test stability (see [§13](#13-test-execution-and-diagnosis-system)).

**Dummy data access**: Each screen HTML includes `<script src="data.js"></script>` and reads from the global `DUMMY_DATA` object. Screens do NOT hardcode data values — they render data dynamically from `DUMMY_DATA`.

**Navigation**: Interactive elements call `parent.navigateTo('[target-screen-id]')` for cross-screen navigation.

**Parallelization**: All screen generation calls run simultaneously after 2.4a provides the dummy data.
**Failure handling**: Retry once per screen. Same batch failure protocol as 2.1b.

#### 8.5.4 Sub-operation 2.4d — Wireframe Smoke Test

**Type**: Code execution (NOT an AI call)
**Fires**: After all 2.4c calls complete

**Checks**:
1. For every screen ID in the Screen Inventory, a corresponding [screen-id].html file exists
2. Every `parent.navigateTo('...')` string in every HTML file references a screen ID that has a corresponding HTML file
3. The entry point screen file exists
4. The shell's screen list matches the set of generated screen files

**On all checks pass**: Proceed to 2.4e then 2.5
**On failure**: Identify specific missing files or broken links. Rerun 2.4c for the affected screens. If shell's screen list is wrong, rerun 2.4b.

#### 8.5.5 Sub-operation 2.4e — Data File Assembly

**Type**: Code (NOT an AI call)
**Fires**: After 2.4a completes (can be early in the chain)
**Action**: Write the JSON from 2.4a as `data.js`:
```javascript
const DUMMY_DATA = { /* JSON content from 2.4a */ };
```
**Storage**: Write to wireframe directory. Create Artifact record (type: wireframe_data).

### 8.6 Operation 2.5 — Automated Test Generation

**Fires**: After Operation 2.4 completes (wireframe ready).

#### 8.6.1 Sub-operation 2.5a — Test Harness Generation

**Type**: Direct AI call
**Input**: List of screen IDs
**System prompt**: [§17.19](#1719-operation-25a--test-harness)
**Output**: Complete test-harness.html content
**Storage**: Write to wireframe directory. Create Artifact record (type: test_harness).

**Required harness features**:
- Loads wireframe shell (index.html) in an iframe
- Waits for iframe to fully load before running tests
- Exposes `runTests(testDefinitions)` function
- Executes test steps sequentially with configurable delay (default 300ms)
- Records per-test: id, name, pass/fail, duration, failed step details
- Fires `testsComplete` CustomEvent on window with full results array
- Visual progress indicator during execution
- Does NOT auto-run — waits for explicit `runTests()` call

#### 8.6.2 Sub-operation 2.5b — Test Translation

**Type**: Direct AI call, one per workflow's test cases (parallelizable)
**Input**: Test cases YAML for one workflow + HTML source of all screens referenced by those tests
**System prompt**: [§17.20](#1720-operation-25b--test-translation)
**Output format**: YAML
**Output parsing**: Validate each test has: id, name, steps array. Each step has: type (from allowed list), and required params for that type.

**HTML source inclusion**: Each referenced screen's HTML is wrapped in `<screen id="[screen-id]">...</screen>` tags so the AI can identify which HTML belongs to which screen and produce accurate CSS selectors.

**Parallelization**: All workflow test translation calls run simultaneously.
**Failure handling**: Retry once, then notify user.

#### 8.6.3 Sub-operation 2.5c — Test Bundle Assembly

**Type**: Code (NOT AI)
**Action**: Collect all executable test definitions from 2.5b. Write as `tests.js`:
```javascript
const TEST_DEFINITIONS = [ /* all test definitions */ ];
```
**Storage**: Write to wireframe directory. Create Artifact record (type: test_definitions).

#### 8.6.4 Sub-operation 2.5d — Test Dry Run

**Type**: Code execution (NOT AI)
**Action**: Programmatically load test-harness.html, run all tests, collect results.
**Purpose**: Catch infrastructure failures (bad selectors, missing screens) before presenting to user.
**On all pass**: Auto-generation chain is COMPLETE. Proceed to [§8.7](#87-auto-generation-complete).
**On failures**: Proceed to 2.5e for each failed test.

#### 8.6.5 Sub-operation 2.5e — Test Repair (conditional)

**Type**: Direct AI call, one per failed test
**Input**: Failed test definition + error details + screen HTML where failure occurred
**System prompt**: [§17.21](#1721-operation-25e--test-repair)
**Output**: Corrected test definition
**After repair**: Rebuild test bundle (2.5c), rerun dry run (2.5d).
**If fails again after repair**: Mark test as "known issue — infrastructure." Continue. User will see it in test results.

### 8.7 Auto-Generation Complete

**Actions when the entire chain finishes**:
1. Unblock chat input
2. Post system message: "Wireframe and automated tests are ready. You can explore the wireframe and run tests when you're ready."
3. Ask user: "Would you like to view the wireframe?" (button in chat)
4. If user clicks yes (or opens wireframe from documents list): switch document panel to wireframe viewer

---

## 9. Phase 2 — User Interaction Operations

These operations fire after the auto-generation chain is complete and the user is interacting with the system.

### 9.1 Message Processing Flow in Phase 2

```
User sends message
  │
  ├── Session Manager checks: is chat input blocked?
  │   └── YES → Show "Please wait" → STOP
  │
  ├── Block chat input (cascade will run)
  │
  ├── Route to Operation 2.7a (Conversational AI)
  │   │
  │   ├── Conversational AI produces <change_context>
  │   │   │
  │   │   ├── Route to Operation 2.6 (Drift Check)
  │   │   │   │
  │   │   │   ├── COMPATIBLE → Route to Operation 2.7b (Cascade Router)
  │   │   │   │   └── Execute cascade → Unblock chat input
  │   │   │   │
  │   │   │   ├── FLAG → Show warning to user → Unblock chat input
  │   │   │   │   ├── User clicks "Continue anyway" → Route to 2.7b
  │   │   │   │   └── User clicks "Go back to Phase 1" → Rollback (§14)
  │   │   │   │
  │   │   │   └── DRIFT → Show block message → Unblock chat input
  │   │   │       └── User clicks "Go back to Phase 1" → Rollback (§14)
  │   │   │
  │   └── Conversational AI produces clarifying question (no <change_context>)
  │       └── Display in chat → Unblock chat input → Wait for response
```

### 9.2 Operation 2.6 — Drift Pre-check

Full specification in [§10](#10-drift-detection-system).

### 9.3 Operation 2.7 — Iteration Response

Full specification in [§11](#11-iteration-cascade-engine).

### 9.4 Operation 2.8 — Test Execution

Full specification in [§13.1](#131-test-execution).

### 9.5 Operation 2.9 — Test Failure Diagnosis

Full specification in [§13.2](#132-test-failure-diagnosis).

### 9.6 Operation 2.10 — Phase Completion Validation

**Trigger**: User clicks "Confirm phase complete" during Phase 2.

**Step 1 — Code-Level Checks** (run first, block if any fail):

| Check | Failure message |
|-------|-----------------|
| Test run exists | "Please run the test suite at least once before completing this phase." |
| Test run is recent (not stale) | "The wireframe has changed since tests were last run. Please run tests again." |
| All tests pass or are marked known issues | "N tests are still failing. Please fix them or mark them as known issues." |
| HTML file exists for every screen in Screen Inventory | "Missing wireframe files detected. Please report this issue." |
| Test definitions exist for every workflow | "Missing test definitions detected. Please report this issue." |

**Step 2 — AI Validation** (only if all code checks pass):

**Type**: Direct AI call
**Input**: Full Project Contract + all workflow YAMLs + entity coverage report from 2.2b + test execution summary (counts)
**System prompt**: [§17.22](#1722-operation-210--phase-2-validation)
**Output parsing**: Same as Operation 1.3 — extract STATUS, ISSUES, WARNINGS, SUGGESTIONS.

**If PASS**:
1. PhaseState phase-2 → 'complete'
2. Create Checkpoint 3 (snapshot all documents and artifacts)
3. Show confirmation in chat. Warnings/suggestions shown as informational notes.
4. Phase 2 is locked.

**If FAIL**:
1. Show ISSUES in chat
2. Inject into conversational AI context
3. Phase 2 stays active

---

## 10. Drift Detection System

### 10.1 When Drift Check Runs

The drift check runs AFTER the Phase 2 conversational AI (Operation 2.7a) processes the user's message and produces a `<change_context>` block. It evaluates the structured intent, never the raw user message.

**This is a critical architectural decision.** The conversational AI understands context, resolves ambiguity, and produces a clear statement of intent. The drift checker evaluates that clear statement against the Phase 1 contract. This eliminates false positives from ambiguous user messages and ensures the drift check always has complete, structured data to work with.

### 10.2 What the Drift Checker Evaluates

Input:
```
Personas list (from Project Contract): names + definitions + interaction types
Entity Map (from Project Contract): entity names + persona interactions
Boundaries (from Project Contract): boundary statements
Proposed change: the full <change_context> block
```

### 10.3 Classification Rules

**COMPATIBLE (proceed normally)**:
- Adding a new workflow for an existing persona using existing entities
- Adding/modifying/removing screens
- Changing workflow steps, order, or edge cases
- Adding edge cases to existing workflows
- Modifying how entities are displayed
- Adding new fields/attributes to existing entities (refinement)
- Changing dummy data
- Modifying navigation between screens

**FLAG (warn user, let them choose)**:
- A workflow gives a persona capabilities that seem to overlap with another persona's role
- An entity from Phase 1 becomes unused after this change
- A change introduces a concept that could be interpreted as a new entity OR as an attribute of an existing entity

**DRIFT (block, require rollback)**:
- Explicitly naming a new persona not in Phase 1
- Introducing an entirely new entity type not in the Entity Map
- Removing or fundamentally redefining a persona
- Splitting one entity into two distinct entities
- Merging two entities into one
- Requesting functionality explicitly excluded by Boundaries
- Changing the fundamental purpose of the product

### 10.4 Drift Check AI Prompt

See [§17.11](#1711-operation-26--drift-check) for the full prompt.

### 10.5 Drift Check Response Handling

**COMPATIBLE**:
- The `<change_context>` proceeds to the Cascade Router (Operation 2.7b)
- The drift check is invisible to the user

**FLAG**:
- Show system message in chat: "This change might involve a change to Phase 1. Specifically: [reason]. You have two options:"
- Show two buttons:
  - "Continue anyway" → the `<change_context>` proceeds to Cascade Router. An additional note is injected into the cascade context: "This change was flagged for potential drift but the user chose to continue."
  - "Go back to Phase 1" → initiate rollback ([§14](#14-rollback-and-checkpoint-system))

**DRIFT**:
- Show system message in chat: "This change requires a modification to the Phase 1 project definition: [reason]. Your request has been saved."
- Show one button: "Go back to Phase 1"
- Store the user's original message AND the `<change_context>` as a PendingMessage
- On button click: initiate rollback ([§14](#14-rollback-and-checkpoint-system))

---

## 11. Iteration Cascade Engine

### 11.1 Overview

When the user requests a change during Phase 2 and the drift check passes, the Cascade Engine determines WHAT needs to regenerate and in what ORDER.

### 11.2 Operation 2.7a — Conversational AI

**Type**: Conversational AI (Phase 2 instance)
**System prompt**: [§17.11](#1711-operation-27a--phase-2-conversational-ai)
**Context assembly**: See [§6.2](#62-phase-2-context-assembly)

**Output parsing**:
1. Extract visible text (everything outside `<change_context>` tags) → display in chat
2. Extract `<change_context>` block → parse YAML content
3. Validate required fields: scope, description, affected_workflows, affected_screens
4. If scope is `workflow_change`: validate workflow_changes array is present
5. If scope is `screen_only`: validate screen_changes array is present
6. If scope is `data_only`: validate data_changes array is present

If no `<change_context>` found: it's a clarifying question. Display in chat. Unblock input. Wait.

### 11.3 Operation 2.7b — Cascade Router

**Type**: Code (NOT AI)
**Input**: Parsed `<change_context>` from 2.7a

**Route by scope**:

#### Scope: `data_only`
```
1. Regenerate dummy data (modified 2.4a call with data_changes as context)
2. Rebuild data.js (2.4e)
3. Mark all test results as stale
4. Unblock chat input
```
Estimated calls: 1 AI call.

#### Scope: `screen_only`
```
1. Update Screen Inventory (2.7c)
2. Diff old vs new screen inventory to find:
   - Screens modified → regenerate their HTML (2.4c per screen)
   - Screens added → generate new HTML (2.4c) + update shell (2.4b)
   - Screens removed → delete HTML + update shell (2.4b)
3. Re-translate tests that reference changed screens (2.5b per affected workflow)
4. Rebuild test bundle (2.5c)
5. Run test dry run (2.5d), repair if needed (2.5e)
6. Regenerate Screen Inventory markdown document (2.3d)
7. Mark all test results as stale
8. Unblock chat input
```
Estimated calls: 4-8 AI calls.

#### Scope: `workflow_change`
```
1. For each affected workflow:
   a. If change_type = 'modify': Update workflow (2.7d)
   b. If change_type = 'add': Generate new workflow (same as 2.1b)
   c. If change_type = 'remove': Delete from Workflow Map (no AI call)
2. Regenerate test cases for changed/new workflows (2.2a per workflow)
3. Check if screen changes are needed:
   a. If new workflows reference screens that don't exist → add to screen inventory
   b. If removed workflows were the only user of some screens → flag for removal
   c. Run targeted Screen Inventory update (2.7c)
4. Diff screen inventory changes → regenerate affected screen HTML (2.4c)
5. Update shell if screens added/removed (2.4b)
6. Re-translate affected tests (2.5b)
7. Rebuild test bundle (2.5c)
8. Run test dry run (2.5d), repair if needed (2.5e)
9. Regenerate Workflow Map markdown (2.1c)
10. Regenerate Test Suite markdown (2.2c)
11. Regenerate Screen Inventory markdown (2.3d)
12. Mark all test results as stale
13. Update conversation summary (§6.5)
14. Unblock chat input
```
Estimated calls: 9-21 AI calls.

### 11.4 Sub-operations Used by the Cascade

These are the same operations defined in the auto-generation chain but called with targeted inputs.

#### Operation 2.7c — Targeted Screen Inventory Update
**Type**: Direct AI call
**System prompt**: [§17.23](#1723-operation-27c--targeted-screen-update)
**Input**: Current screen inventory YAML + screen_changes from `<change_context>` + workflow context if workflows also changed
**Output**: Complete updated screen inventory YAML
**Post-processing**: Diff old vs new to identify exactly which screens changed/added/removed

#### Operation 2.7d — Targeted Workflow Update
**Type**: Direct AI call, one per affected workflow
**System prompt**: [§17.24](#1724-operation-27d--targeted-workflow-update)
**Input**: Project Contract + specific workflow YAML + change detail from `<change_context>`
**Output**: Complete updated workflow YAML

### 11.5 Chat Input Blocking During Cascade

Chat input is blocked from the moment the user sends a message (before 2.7a even starts) until the entire cascade completes. The UI shows a progress indicator.

If the cascade takes more than 5 seconds, a progress message appears in chat: "Applying changes..." with a spinner. This message is replaced by the cascade completion summary when done.

---

## 12. Wireframe Technical Specification

### 12.1 File Structure

```
[session-wireframe-directory]/
├── index.html              # Navigation shell
├── data.js                 # Dummy data (DUMMY_DATA global)
├── test-harness.html       # Test execution environment
├── tests.js                # Executable test definitions (TEST_DEFINITIONS global)
├── home-screen.html        # Example screen file
├── product-list.html       # Example screen file
├── product-detail.html     # Example screen file
├── checkout.html           # Example screen file
├── order-confirmation.html # Example screen file (system_info type)
└── ...
```

### 12.2 Shell (index.html) Contract

The shell MUST implement:

```javascript
// Navigate to a screen by ID. Loads [screenId].html in the content area.
window.navigateTo = function(screenId) { ... }

// Return the currently displayed screen's ID as a string.
window.getCurrentScreenId = function() { ... }

// Fired every time navigation occurs.
// event.detail = { screenId: "the-new-screen-id" }
window.addEventListener('screenChanged', function(event) { ... })
```

The shell MUST display:
- Screen ID prominently at top of content area (for user reference in chat)
- Navigation sidebar listing all screens, grouped by type:
  - UI screens first
  - Divider
  - System Info screens (labeled "System Processes")
- Currently active screen highlighted in sidebar

### 12.3 Screen File Contract

Each screen HTML file:
- Contains ONLY screen content (no `<html>`, `<head>`, or `<body>` tags if loaded via innerHTML; OR complete document if loaded via iframe — depends on shell implementation)
- Includes `<script src="data.js"></script>` for data access
- Uses `parent.navigateTo('[screen-id]')` for navigation
- Uses deterministic element IDs: `[entity]-[field]-[element-type]` pattern
- No external dependencies (no CDN links, no npm packages)
- Inline CSS only
- Wireframe aesthetic: gray backgrounds (#f5f5f5), black borders (#333), sans-serif font, blue (#2563eb) for interactive elements
- System Info screens: amber background (#fef3c7), amber border (#f59e0b), banner: "System Process — Not a user-facing screen"

### 12.4 Data File Contract (data.js)

```javascript
// Global object accessible from all screen files
const DUMMY_DATA = {
  // Each key is an entity name (lowercase, underscored)
  products: [
    { id: "1", name: "Running Shoes", price: "$99.99", category: "Footwear", stock: 42, image: null },
    { id: "2", name: "Water Bottle", price: "$24.99", category: "Accessories", stock: 0, image: null },
    // ... 3-5 items per entity
  ],
  users: [ ... ],
  orders: [ ... ],
  // Internal consistency: order.productId references a product.id that exists
};
```

### 12.5 Wireframe Viewer Integration

The wireframe viewer in our application:
- Loads index.html in a sandboxed iframe
- Listens for `screenChanged` events from the iframe
- When user types in chat, the current screen ID is populated in the chat input as visible metadata: `[Viewing: product-detail]`
- This metadata is included in the message sent to the conversational AI

---

## 13. Test Execution and Diagnosis System

### 13.1 Test Execution (Operation 2.8)

**Trigger**: User clicks "Run tests" button in the wireframe canvas.
**Type**: Code execution (NOT AI)

**Execution flow**:
1. Load test-harness.html (or send command to already-loaded harness)
2. Call `runTests(TEST_DEFINITIONS)`
3. Harness executes each test sequentially
4. Harness fires `testsComplete` event with results
5. Our application receives results and formats them

**Results display in chat**:
- Message type: `test_results`
- Summary: "23 of 25 tests passed. 2 failed. 12.4 seconds."
- Expandable list of all tests grouped by workflow
- Each test shows: name, pass/fail icon, duration
- Failed tests are highlighted and clickable

**When user clicks a failed test**:
- Right panel (60%) splits: top 60% wireframe, bottom 40% test details
- Wireframe navigates to the screen where failure occurred
- Test details show:
  - Test ID and name
  - Human-readable test case (from Test Suite document)
  - Failed step number and description
  - Error message
  - Duration
  - Two buttons: "Diagnose this failure" | "Skip — mark as known issue"

**"Skip — mark as known issue"**:
- Sets IndividualTestResult.status to 'known_issue'
- Test won't block Phase completion
- Flag persists across test runs UNLESS the test is regenerated (flag clears on regeneration)

### 13.2 Test Failure Diagnosis (Operation 2.9)

**Trigger**: User clicks "Diagnose this failure"
**Type**: Direct AI call

**Input**:
```
- Human-readable test case (from Test Suite document, YAML)
- Executable test steps (from tests.js)
- Failure details: step number, step definition, error message
- HTML source of the screen where failure occurred
- Workflow YAML that this test is based on
```

**System prompt**: [§17.25](#1725-operation-29--test-diagnosis)

**Output parsing**: Extract diagnosis (must be one of: WIREFRAME_BUG, TEST_BUG, WORKFLOW_FLAW), root_cause, affected_artifact, proposed_fix, confidence.

**Display**: Replace raw failure details in bottom 40% panel with diagnosis results. Show confidence level.

**If confidence = low**: Additional note: "This diagnosis is uncertain. Review before applying."

### 13.3 Diagnosis Fix Application

**WIREFRAME_BUG fix**:
1. User clicks "Fix wireframe"
2. Block chat input
3. Regenerate the affected screen HTML (2.4c) with appended instruction: "IMPORTANT FIX: [proposed_fix]"
4. Re-translate tests that reference this screen (2.5b)
5. Rebuild test bundle (2.5c)
6. Auto-run ONLY the previously failed test to verify fix
7. Mark ALL test results as stale (other tests may be affected by the HTML change)
8. Show result to user: "Fix applied. The test now [passes/still fails]."
9. Unblock chat input

**TEST_BUG fix**:
1. User clicks "Fix test"
2. Block chat input
3. Run test repair (2.5e) with diagnosis context
4. Rebuild test bundle (2.5c)
5. Auto-run ONLY the repaired test
6. Mark ALL test results as stale
7. Show result to user
8. Unblock chat input

**WORKFLOW_FLAW fix**:
1. User clicks "Fix workflow (requires approval)"
2. Present proposed fix in chat: "The diagnosis found a flaw in workflow '[name]': [root_cause]. Proposed fix: [proposed_fix]. This will update the workflow, tests, and wireframe. Approve?"
3. Two buttons: "Approve fix" | "Dismiss"
4. If "Dismiss": mark test as known issue. Unblock chat input.
5. If "Approve":
   a. Construct a synthetic `<change_context>` from the proposed fix:
      ```
      scope: workflow_change
      description: [proposed_fix]
      affected_workflows: [the workflow ID]
      workflow_changes:
        - workflow_id: [ID]
          change_type: modify
          detail: [proposed_fix]
      ```
   b. Run drift check (2.6) on this synthetic `<change_context>`
   c. If drift passes: execute cascade (2.7b) with this context
   d. If drift fails: normal drift handling — user must roll back to Phase 1
   e. Mark ALL test results as stale

---

## 14. Rollback and Checkpoint System

### 14.1 When Rollback is Triggered

- User clicks "Previous phase" button during Phase 2 (when idle)
- User clicks "Go back to Phase 1" after a drift FLAG or DRIFT result

### 14.2 Rollback Procedure

```
1. Record current Phase 2 state as "suspended":
   - All Phase 2 documents: mark as suspended (not deleted)
   - All wireframe artifacts: mark as suspended
   - All Phase 2 chat messages: mark as suspended
   - Phase 2 conversational AI context: preserved

2. Phase 1 reopens:
   - PhaseState phase-1: status → active
   - PhaseState phase-2: status → suspended
   - Load Project Contract into document panel
   - Restore Phase 1 conversational AI with its original chat history
   - Phase indicator shows Phase 1 as active

3. User iterates on Phase 1:
   - Normal Phase 1 operations (1.2 iteration)
   - User modifies personas, entities, boundaries as needed

4. User clicks "Confirm phase complete" on Phase 1:
   - Validation runs (1.3)
   - If FAIL: stay in Phase 1, fix issues
   - If PASS: compare new Project Contract with Checkpoint 2's snapshot

5. Contract comparison:
   - Diff the new Project Contract against Checkpoint 2's document snapshot
   
   IF CONTRACT UNCHANGED:
     - Restore suspended Phase 2 exactly as-is
     - All documents, artifacts, chat history restored
     - PhaseState phase-2: status → active
     - Phase 2 conversational AI restored with its history
     - Unblock chat input
   
   IF CONTRACT CHANGED:
     - Delete all suspended Phase 2 data (documents, artifacts)
     - Archive Phase 2 chat history (hidden from user, but stored)
     - Show note: "Phase 2 was regenerated due to Phase 1 changes. Previous Phase 2 conversation is archived."
     - Create new Phase 2 conversational AI instance (fresh, with new contract)
     - Update Checkpoint 2 with new contract
     - Begin full auto-generation chain (Operations 2.1-2.5) from scratch
```

### 14.3 Pending Message Handling After Rollback

If a PendingMessage exists (from a DRIFT-blocked request):

After Phase 1 re-locks and Phase 2 is initialized (whether restored or regenerated):

1. Run drift check (2.6) on the pending message's `<change_context>` against the NEW Project Contract
2. **If now COMPATIBLE**: present in chat: "You previously requested: '[original message]'. Now that Phase 1 is updated, would you like to apply this?"
   - Button: "Apply" → execute cascade with the stored `<change_context>`
   - Button: "Discard" → delete PendingMessage
3. **If the Phase 2 regeneration likely already incorporated the intent**: present with note: "You previously requested: '[original message]'. The updated Phase 2 may already include what you wanted. Would you like to apply it anyway, or discard?"
   - Button: "Apply anyway" → execute cascade
   - Button: "Discard" → delete PendingMessage
4. **If still DRIFT**: "Your previous request '[original message]' still requires Phase 1 changes that weren't made. Discarding."
   - Delete PendingMessage

**How to determine if "Phase 2 regeneration likely already incorporated the intent"**: The drift check on the pending `<change_context>` returns COMPATIBLE, AND the change_context references entities/personas that were added in the Phase 1 update. This heuristic indicates the Phase 1 update was specifically made to enable this request, so the fresh Phase 2 generation likely already accounts for it.

---

## 15. UI Specification

### 15.1 Layout — Full Width (No Document Open)

```
┌─────────────────────────────────────────────────────────────┐
│ [New Chat] ░░░░░░░░ Phase Flow Indicator ░░░░░░ [Documents] │
├─────────────┬───────────────────────────────────────────────┤
│             │                                               │
│  Session    │              Chat Messages                    │
│  Sidebar    │              (scrollable)                     │
│             │                                               │
│  - Project1 │                                               │
│  - Project2 │                                               │
│  > Project3 │                                               │
│             │                                               │
│             ├───────────────────────────────────────────────┤
│             │ [Viewing: screen-id]                          │
│             │ [________chat input________] [Previous][Done] │
└─────────────┴───────────────────────────────────────────────┘
```

### 15.2 Layout — Document/Artifact Open (40/60 Split)

```
┌─────────────────────────────────────────────────────────────┐
│ [New Chat] ░░░░░░░░ Phase Flow Indicator ░░░░░░ [Documents] │
├─────────────┬──────────────────┬────────────────────────────┤
│             │                  │                            │
│  Session    │  Chat Messages   │   Document / Wireframe     │
│  Sidebar    │  (scrollable)    │   (60% width)              │
│             │                  │                            │
│  - Project1 │                  │                            │
│  - Project2 │                  │                            │
│  > Project3 │                  │                            │
│             │                  │                            │
│             ├──────────────────┤                            │
│             │[Viewing: scr-id] │                            │
│             │[__chat input__]  │                            │
│             │ [Previous][Done] │                            │
└─────────────┴──────────────────┴────────────────────────────┘
```

### 15.3 Layout — Test Results Detail (Panel Split)

When user clicks a failed test, the 60% document panel splits:

```
┌────────────────────────────────────┐
│                                    │
│   Wireframe (60% of panel)         │
│   (navigated to failure screen)    │
│                                    │
├────────────────────────────────────┤
│                                    │
│   Test Details (40% of panel)      │
│   - Test name and ID               │
│   - Given/When/Then                │
│   - Failed step + error            │
│   - [Diagnose] [Skip]              │
│                                    │
└────────────────────────────────────┘
```

### 15.4 Phase Flow Indicator

Displayed at the top of the chat area. Shows all phases as a horizontal flow:

```
[● Phase 1: Goal Definition] ──── [○ Phase 2: Workflow & UX] ──── [○ Phase 3: ...]
     ✓ Complete                        ◆ Active                       Locked
```

States per phase:
- ○ Grey circle: not yet reached
- ◆ Blue diamond: currently active
- ● Green checkmark: complete

### 15.5 Documents Panel

Accessed via "Documents" button (top right). Shows a dropdown/sidebar listing all generated documents and artifacts:

```
Phase 1:
  📄 Project Contract (v3, updated 2m ago)     [↓]

Phase 2:
  📄 Workflow Map (v1, updated 5m ago)         [↓]
  📄 Test Suite (v1, updated 5m ago)           [↓]
  📄 Screen Inventory (v1, updated 5m ago)     [↓]
  🖼️ Interactive Wireframe                     [↓]
  
  [Download All]
```

Clicking a document opens it in the 60% panel. [↓] is the per-item download button.

### 15.6 Session Sidebar

Left sidebar showing all sessions:
- Sorted by last updated (most recent on top)
- Shows: title, last updated timestamp
- Active session is highlighted
- Clicking a session switches to it (restores exact state)
- "New Chat" button at top left

### 15.7 Chat Input Blocking Rules

Chat input is disabled (greyed out, cannot type or send) when:
- Auto-generation chain is running (Operations 2.1-2.5)
- Iteration cascade is running (Operation 2.7)
- Test execution is running (Operation 2.8)
- Diagnosis fix is being applied (Operation 2.9 fixes)
- Phase completion validation is running (Operations 1.3, 2.10)

Visual indicator: The chat input shows "Processing..." or a specific progress message when blocked.

### 15.8 Button States

**"Previous phase" button**:
| Condition | State |
|-----------|-------|
| Phase 1 active | Disabled (nothing before) |
| Phase 2 active, idle | Enabled |
| Phase 2 active, operation running | Disabled |
| Any phase completing | Disabled |

**"Confirm phase complete" button**:
| Condition | State |
|-----------|-------|
| Phase active, idle | Enabled |
| Phase active, operation running | Disabled |
| Phase already complete | Disabled (hidden or greyed) |

### 15.9 Screen Reference in Chat Input

When the wireframe viewer is open and the user is on a specific screen:
- The chat input automatically shows metadata: `[Viewing: product-detail-screen]`
- This text is visible to the user in the input box
- The user can delete it if they don't want to reference a screen
- The user can manually type a screen ID
- This metadata is sent as part of the message to the conversational AI

---

## 16. Error Handling and Resumability

### 16.1 Single Operation Failure

**For non-batch operations**: Retry once with the correction prompt. If fails again, show error to user in chat: "An error occurred while [operation description]. Error: [brief reason]. Please try again." Unblock chat input. The user can rephrase their request or retry.

### 16.2 Batch Operation Failures

**For batch operations (2.1b, 2.2a, 2.4c, 2.5b)**:
- Retry failed item once automatically
- If fails again, mark as failed, continue with rest of batch
- At batch completion, show in chat:
  ```
  "[N-1] of [N] workflows generated successfully. 
  1 failed: [workflow name]
  Reason: [brief error description]"
  ```
- Two buttons: "Retry" | "Skip for now"
- "Retry": reruns the failed call
- "Skip for now": marks item as skipped. The item is excluded from downstream operations. It can be retried later.

### 16.3 Cascade Failure

If an operation within an iteration cascade (2.7) fails:
- The cascade stops at the failed point
- Already-completed operations in the cascade are NOT rolled back (their outputs are valid)
- The user is notified: "The update partially completed. [Description of what completed] succeeded, but [failed operation] encountered an error: [reason]."
- Two buttons: "Retry from failure point" | "Undo all changes"
- "Retry": resumes cascade from the failed operation
- "Undo all changes": restores all documents and artifacts to their state before the cascade started. This requires the Session Manager to snapshot document states before starting any cascade.

### 16.4 Session Resumability

**On app close and reopen**:
1. Load all sessions from database
2. For the active session, check OperationProgress records
3. If any operation has status 'in_progress':
   a. Determine the operation's position in the dependency graph
   b. Find the last sub-operation with status 'complete'
   c. Resume from the next sub-operation
4. For batch operations: check BatchItem statuses, resume from the next incomplete item
5. UI: restore exact visual state (same phase, same open document/artifact, same chat scroll position if possible)

**State snapshot before cascade** (for undo capability):
```typescript
interface CascadeSnapshot {
  id: string;
  sessionId: string;
  triggeredBy: string;           // The user message that triggered this cascade
  createdAt: timestamp;
  documentSnapshots: DocumentSnapshot[];
  artifactSnapshots: ArtifactSnapshot[];
  status: 'active' | 'applied' | 'undone';
}
```

Before every cascade (Operation 2.7), create a CascadeSnapshot. If the user requests "Undo all changes," restore from this snapshot.

---

## 17. All AI Prompts Reference

This section contains every AI prompt used in the system. Each prompt is referenced from the operation that uses it.

### 17.1 Operation 1.0 — Session Title

```
Respond with ONLY a project title between 3 and 5 words. No punctuation, no quotes, no explanation, no formatting. Just the title.

Example input: "I want to build an app where people can track their daily water intake and get reminders"
Example output: Water Intake Tracker

Input: [user message]
```

### 17.2 Phase 1 Conversational AI

```
You are a product definition advisor helping a user define what they want to build. You are in Phase 1: Goal Definition.

Your job is to take the user's input and produce a complete, detailed product definition. Fill in gaps with your best judgment rather than asking the user. Be opinionated — make decisions about personas, entities, and boundaries based on what makes sense for the described product.

On EVERY message, produce a <generation_context> block containing the full current state of the product definition. This includes everything discussed so far plus your inferences.

<generation_context>
goal: [clear description of the product and what problem it solves]
personas:
  - name: [role label]
    definition: [who they are]
    interaction: [how they relate to the system]
entities:
  - name: [entity name]
    description: [what it is]
    persona_interactions:
      - persona: [name]
        action: [what they do with it]
boundaries:
  - [what the product does NOT do]
</generation_context>

The <generation_context> must always be a COMPLETE snapshot — every persona, every entity, every boundary — not just what changed.

Your visible response to the user should be 1-2 sentences acknowledging what you did. Do not explain the contract contents — the user will see the generated document directly.

Only ask a clarifying question if the ambiguity would lead to two fundamentally different products. Default to inferring and letting the user correct you.

When the user requests changes, apply them and also update any other parts of the context that are affected by the change. Produce the full updated <generation_context>.
```

### 17.3 Document Generator — Project Contract

```
You are a document generator. Produce a Project Contract in markdown with exactly four sections: Goal Statement, Personas, Entity Map, and Boundaries.

Use ONLY the information provided below. Do not infer, add, or assume anything beyond what is given.

Format:

## Goal Statement
[paragraph]

## Personas
For each persona:
**[Name]**
[Definition sentence]. Interaction type: [how they relate to the system].

## Entity Map
For each entity:
**[Entity name]**: [What it is]. [Persona A] does X. [Persona B] does Y.

## Boundaries
- [boundary 1]
- [boundary 2]
...
```

### 17.4 Operation 1.3 — Phase 1 Validation

```
You are a product definition validator. Your job is to check whether a Project Contract is complete and internally consistent enough to move to the next phase of development.

Check the following criteria:

Structural completeness:
- Goal Statement exists and is specific enough that two developers reading it would build roughly the same product
- At least one Persona is defined with name, definition, and interaction type
- Entity Map has at least one entity, and every entity is referenced by at least one persona
- Boundaries section has at least one meaningful boundary
- Every persona listed appears in at least one Entity Map entry

Internal consistency:
- Personas don't overlap significantly (two personas that do the same thing should be one)
- Entities make sense for the stated goal (no entities that seem unrelated to the product)
- Boundaries don't contradict the goal
- The goal, personas, entities, and boundaries tell a coherent story about the same product

Respond in this exact format:

STATUS: PASS or FAIL

ISSUES:
- [issue description, one per line, only if FAIL]

SUGGESTIONS:
- [optional improvement suggestions even if PASS, one per line, or "None"]
```

### 17.5 Operation 2.1a — Workflow Discovery

```
You are a product workflow analyst. Given a Project Contract, identify every distinct workflow that exists in the product.

A workflow is a sequence of steps that a persona (or the system) performs to accomplish a specific goal.

For each persona in the contract, identify:
- Every action they can take in the system
- Each action becomes one workflow

Also identify system-initiated workflows:
- Background processes (e.g., scheduled cleanup, data aggregation)
- Triggered events (e.g., sending notifications when something happens)
- Scheduled tasks (e.g., nightly reports, subscription renewals)
- Webhook/integration responses (e.g., payment confirmation from external service)

Respond with a YAML list:

workflows:
  - id: [short-kebab-case-id]
    persona: [persona name, or "System" for system-initiated]
    name: [human readable name]
    description: [one sentence describing what this workflow accomplishes]
    trigger: [what starts this workflow]
    category: [one of: core, supporting, edge-case, system]
```

### 17.6 Operation 2.1b — Workflow Detail Generation

```
You are a product workflow designer. You will be given a product description and a specific workflow to detail.

Produce a complete workflow definition including the happy path and ALL edge cases and alternate paths.

Format:

workflow:
  id: [from input]
  persona: [from input]
  name: [from input]
  trigger: [from input]
  
  happy_path:
    - step: 1
      actor: [who performs this step — the persona or the system]
      action: [what they do]
      system_response: [what the system does in response]
      screen: [which screen this happens on, or "none" for non-UI steps]
    - step: 2
      ...
  
  outcome: [what state the system is in when this workflow completes successfully]
  
  edge_cases:
    - id: [workflow-id]-edge-[number]
      branches_from_step: [which happy path step this diverges from]
      condition: [what triggers this edge case]
      steps:
        - step: 1
          actor: [who]
          action: [what]
          system_response: [what]
          screen: [where]
      outcome: [how this edge case resolves]

Be thorough with edge cases. Consider:
- Invalid input at each step
- Missing or unavailable data
- Permission denied scenarios
- Concurrent actions by other users
- External service failures (payment, email, etc.)
- Empty states (no data exists yet)
- Rate limits or resource constraints
```

### 17.7 Operation 2.1c — Workflow Map Formatting

```
You are a document formatter. Convert the structured workflow data below into a clean, readable markdown document.

Format:

# Workflow Map

## Summary
[Table listing all workflows: ID, Persona, Name, Category]

## [Persona Name] Workflows

### [Workflow Name]
**Trigger:** [what starts it]
**Category:** [core/supporting/edge-case/system]

**Happy Path:**
1. [Actor] → [Action]. System: [Response]. Screen: [Screen name]
2. ...

**Outcome:** [end state]

**Edge Cases:**

**[Edge case condition]** (branches from step [N])
1. [Actor] → [Action]. System: [Response]. Screen: [Screen name]
Outcome: [resolution]

---

Repeat for each workflow, grouped by persona. System workflows go in their own section at the end.
```

### 17.8 Operation 2.2a — Test Case Generation

```
You are a test case writer. Given a product description and a single workflow definition, produce test cases that fully cover the workflow.

Generate one test case for the happy path and one test case for each edge case defined in the workflow.

Each test case must follow this exact format:

tests:
  - id: [workflow-id]-test-[number]
    name: [human readable name of what this tests]
    workflow_id: [the workflow this tests]
    path: [happy_path or the edge case id]
    given: [the starting state — what must be true before the test begins]
    when: [the sequence of user/system actions, step by step]
      - action: [what the actor does]
        actor: [persona or system]
        screen: [which screen this happens on]
    then: [the expected end state — what must be true after the test completes]
      - assertion: [one specific thing to verify]
        screen: [where to verify it, or "system" for non-UI checks]

Rules:
- Use concrete dummy data in the test cases, not abstractions. Instead of "a product," say "a product named 'Running Shoes' priced at $99.99."
- Each assertion must be independently verifiable — no compound assertions.
- The "given" section must fully describe the starting state so the test is reproducible.
- For edge case tests, the "when" section should follow the happy path up to the branching point, then diverge.
- For non-UI steps (background jobs, emails, webhooks), assertions check system state, not screen content.
```

### 17.9 Operation 2.2b — Entity Coverage Check

```
You are a coverage analyst. Compare the entity list from the Project Contract against the workflows in the Workflow Map.

For each entity in the Project Contract, determine:
- Is it referenced in at least one workflow? If yes, which workflows?
- If no, flag it as unused.

Respond in this format:

coverage:
  - entity: [entity name]
    status: [used or unused]
    referenced_in: [list of workflow IDs, or empty if unused]

unused_entities:
  - [entity name]: [suggestion — should this entity be removed from the contract, or is a workflow missing?]
```

### 17.10 Operation 2.2c — Test Suite Formatting

```
You are a document formatter. Convert the structured test case data below into a clean, readable markdown document.

Format:

# Test Suite

## Coverage Summary
[Total test cases, broken down by workflow. Also include entity coverage status.]

## [Persona Name] Workflow Tests

### [Workflow Name] Tests

#### Happy Path: [Test name]
**Given:** [starting state]
**When:**
1. [Actor] → [action] on [screen]
2. ...
**Then:**
- [assertion 1] on [screen]
- [assertion 2] on [screen]

#### Edge Case: [Edge case condition]
**Given:** [starting state]
**When:**
1. [Actor] → [action] on [screen]
2. ...
**Then:**
- [assertion 1] on [screen]
- [assertion 2] on [screen]

---

Group tests by persona, then by workflow. System workflow tests at the end.
If there are unused entities, add a section: "## Entity Coverage Flags" listing them with suggestions.
```

### 17.11 Operation 2.6 — Drift Check

```
You are a scope drift detector. You will receive a structured description of a proposed change to a product prototype, along with the locked project definition from a previous phase.

Your ONLY job is to determine whether the proposed change stays within the boundaries of the project definition.

Check for these specific drift types:

1. NEW_PERSONA: The change implies a user type not listed in the personas.
2. REMOVED_PERSONA: The change would eliminate a persona entirely.
3. NEW_ENTITY: The change introduces an object type not in the entity map.
4. REMOVED_ENTITY: The change would eliminate an entity entirely.
5. PERSONA_REDEFINITION: The change fundamentally changes what a persona does.
6. BOUNDARY_VIOLATION: The change asks for something listed in boundaries as out of scope.
7. GOAL_CHANGE: The change would alter the fundamental purpose of the product.

Classification rules:
- Adding a new workflow for an existing persona using existing entities is NOT drift.
- Adding a new screen or changing screen layout is NOT drift.
- Changing workflow steps or order is NOT drift.
- Adding edge cases is NOT drift.
- Modifying how an entity is displayed is NOT drift.
- Adding a new field/attribute to an existing entity is NOT drift.
- Splitting or merging entities IS drift.

Respond in EXACTLY this format:

classification: [COMPATIBLE or FLAG or DRIFT]
type: [drift type from list above, or NONE if compatible]
reason: [one sentence explaining your classification]
```

### 17.12 Operation 2.3a — Screen Extraction

```
You are a UX analyst. Given a set of workflows, extract every distinct screen that the application needs.

Rules:
- If multiple workflows reference the same screen, that's ONE screen, not two.
- Every screen referenced in any workflow step must appear in your output.
- Non-UI workflow steps get a special screen type called "system_info" — these are informational display screens that show what the system is doing. They are NOT part of normal app navigation and exist only to demonstrate background system behavior during testing.
- Identify which screen is the entry point (the first screen a user sees).

For each screen:

screens:
  - id: [short-kebab-case-id]
    name: [human readable name]
    type: [ui or system_info]
    description: [one sentence — what this screen shows or does]
    personas_who_see_it: [list of persona names]
    workflows_that_use_it: [list of workflow IDs]
    actions_available:
      - action: [what the user can do on this screen]
        leads_to: [screen id this action navigates to, or "stays" if no navigation]
    data_displayed:
      - [what information is shown on this screen, described in terms of entities]
    entry_point: [true or false]
```

### 17.13 Operation 2.3b — Navigation Validation

```
You are a UX consistency checker. Given a set of screens with their actions and navigation links, check for:

1. Dead ends: screens with no actions that lead to other screens (except final confirmation/success screens)
2. Orphan screens: screens that no action from any other screen leads to (except the entry point)
3. Missing back navigation: screens that the user can reach but cannot leave except by browser back
4. Workflow coverage: for each workflow, verify every step's "screen" field matches a screen in the inventory
5. Missing screens: workflow steps reference a screen that doesn't exist

Respond:

validation:
  status: [pass or has_issues]
  dead_ends: [list of screen IDs, or empty]
  orphans: [list of screen IDs, or empty]
  missing_back_nav: [list of screen IDs, or empty]
  missing_screens: [list of screen references from workflows that have no matching screen, or empty]
  
fixes:
  - screen_id: [affected screen]
    issue: [what's wrong]
    suggested_fix: [what to add or change]
```

### 17.14 Operation 2.3c — Screen Correction

```
You are a UX analyst. You previously generated a screen inventory that had some issues. Apply the fixes below and produce the corrected screen inventory in the same YAML format.

Only change what the fixes require. Do not alter screens that have no issues.
```

### 17.15 Operation 2.3d — Screen Inventory Formatting

```
You are a document formatter. Convert the structured screen inventory data below into a clean, readable markdown document.

Format:

# Screen Inventory

## Summary
[Table: Screen ID, Name, Type (UI/System Info), Personas, Entry Point?]

## Navigation Map
[For each screen, list what actions are available and where they lead.]

## Screen Details

### [Screen Name]
**ID:** [id]
**Type:** [UI or System Info — if System Info, note that this screen is not part of normal app navigation and exists only to demonstrate background system behavior]
**Seen by:** [personas]
**Used in workflows:** [workflow names]

**Data displayed:**
- [what information is shown]

**Actions available:**
- [action] → navigates to [Screen Name]
- [action] → stays on this screen

---

Repeat for each screen. Group UI screens first, System Info screens at the end in their own section.
```

### 17.16 Operation 2.4a — Dummy Data Generation

```
You are a test data generator. Given a product's entity map and workflows, produce a set of realistic dummy data that can be used to populate a wireframe prototype.

Rules:
- Generate 3-5 records per entity
- Use realistic but obviously fake data (e.g., "Jane Cooper" not "User 1", "$49.99" not "$X")
- Include edge cases: at least one empty/null optional field, one boundary condition record (e.g., zero stock, empty cart)
- Data must be internally consistent — references between entities must resolve
- Include IDs for each record

Format as JSON:

{
  "entity_name": [
    { "id": "1", "field": "value", ... },
    ...
  ],
  ...
}
```

### 17.17 Operation 2.4b — Wireframe Shell

```
You are a wireframe developer. Generate an index.html file that serves as the shell for a clickable wireframe prototype.

Requirements:
- Load individual screen HTML files into a main content area (via iframe or dynamic content loading)
- Display the current screen name and screen ID prominently at the top
- Provide a navigation sidebar listing all screens grouped by type:
  - UI screens first
  - Divider
  - System Info screens at the bottom (labeled "System Processes")
- Clicking a screen name in the sidebar loads that screen
- Expose JavaScript function: window.getCurrentScreenId() → returns current screen ID as string
- Expose JavaScript function: window.navigateTo(screenId) → navigates to that screen
- Fire CustomEvent 'screenChanged' on window when navigation occurs, with detail: { screenId: string }
- Style: minimal wireframe aesthetic. Background: #f5f5f5. Borders: #333. Font: sans-serif. Interactive elements: #2563eb (blue). 
- System Info screens in sidebar should have amber indicator
- Highlight currently active screen in sidebar

The shell must work with the following screens:
[list of screen IDs, names, and types]

The entry point screen is: [entry point screen ID]

No external dependencies. Plain HTML, CSS, JavaScript only.
```

### 17.18 Operation 2.4c — Screen HTML Generation

```
You are a wireframe developer. Generate a single HTML file for one screen of a clickable wireframe prototype.

Requirements:
- Contains ONLY the screen content.
- Low-fidelity wireframe styling: gray boxes (#e5e5e5) for images/placeholders, borders (#333) for sections, sans-serif text, blue (#2563eb) for interactive elements.
- All interactive elements call parent.navigateTo('[target-screen-id]') on click.
- Include <script src="data.js"></script> for data access. Read from the global DUMMY_DATA object.
- For lists: iterate DUMMY_DATA.[entity] and render each item as a clickable row.
- For detail views: read item ID from URL hash (e.g., #product-1) and find the matching record in DUMMY_DATA.
- For forms: show input fields with placeholder text. Submit buttons navigate to the next screen.
- For System Info screens: amber background (#fef3c7), amber border (#f59e0b), prominent header explaining what system process this represents, "Continue" button navigating to next workflow screen. This screen is NOT part of normal app navigation — it exists only to demonstrate background system behavior.
- No external dependencies. Plain HTML, inline CSS, inline JavaScript only.
- Element IDs MUST be deterministic and based on purpose. Use the pattern: [entity]-[field]-[element-type]. Examples: product-name-heading, add-to-cart-button, product-list-table, checkout-submit-button, cart-item-count-display. The same screen with the same content MUST produce the same IDs every time. NEVER use random or auto-generated IDs.
- Include clear labels for every section and element.
- For EACH action available on this screen, there MUST be a visible interactive element (button, link, or clickable area).
```

### 17.19 Operation 2.5a — Test Harness

```
You are a test automation developer. Generate a test harness HTML file that can execute automated tests against a wireframe prototype.

The wireframe is a set of HTML files loaded inside a shell (index.html). The shell provides:
- window.navigateTo(screenId) — navigates to a specific screen
- window.getCurrentScreenId() — returns the current screen ID
- A "screenChanged" CustomEvent on window when navigation occurs

The test harness must:
- Load the wireframe shell in an iframe
- Wait for the iframe to fully load before starting tests
- Expose a global function runTests(testDefinitions) that takes an array of test objects and executes them sequentially
- Each test object structure:
  {
    id: "test-id",
    name: "human readable name",
    steps: [
      { type: "navigate", screenId: "target-screen" },
      { type: "click", selector: "CSS selector of element to click" },
      { type: "wait", ms: 500 },
      { type: "assert_screen", expectedScreenId: "expected-screen" },
      { type: "assert_element_exists", selector: "CSS selector" },
      { type: "assert_text_contains", selector: "CSS selector", text: "expected text" },
      { type: "assert_element_not_exists", selector: "CSS selector" }
    ]
  }
- Execute steps sequentially within each test with configurable delay (default 300ms)
- Record per-test: id, name, pass/fail, duration (ms), failed step index, failed step description, error message
- After all tests: fire CustomEvent 'testsComplete' on window with full results array in event.detail
- Visual progress indicator: which test is running, running pass/fail count
- Do NOT auto-run. Wait for runTests() to be called.

No external dependencies. Plain HTML, CSS, JavaScript.
```

### 17.20 Operation 2.5b — Test Translation

```
You are a test automation developer. Convert human-readable test cases into executable test definitions that the test harness can run.

You will be given:
1. A set of test cases in given/when/then format for a specific workflow
2. The HTML source of every screen referenced by these test cases

Translate each test case into a sequence of executable steps.

Step types available:
- navigate: { type: "navigate", screenId: "[screen-id]" }
- click: { type: "click", selector: "[CSS selector]" }
- wait: { type: "wait", ms: [milliseconds] }
- assert_screen: { type: "assert_screen", expectedScreenId: "[screen-id]" }
- assert_element_exists: { type: "assert_element_exists", selector: "[CSS selector]" }
- assert_text_contains: { type: "assert_text_contains", selector: "[CSS selector]", text: "[expected text]" }
- assert_element_not_exists: { type: "assert_element_not_exists", selector: "[CSS selector]" }

Rules:
- CSS selectors MUST match elements actually present in the provided HTML source. Read the HTML and use exact IDs, classes, or structural selectors.
- Every test must start with a "navigate" step to set the starting screen.
- After every click that triggers navigation, add "wait" (300ms) then "assert_screen" to verify.
- For non-UI assertions, use assert_screen to verify system info screen appeared, then assert_text_contains.

Output format:

tests:
  - id: [test id from input]
    name: [test name from input]
    steps:
      - type: [step type]
        [step params]
```

### 17.21 Operation 2.5e — Test Repair

```
You are a test automation developer fixing a broken test. The test was generated but failed during execution.

You will be given:
1. The test definition with all steps
2. Which step failed and the error message
3. The HTML source of the screen where the failure occurred

Common issues:
- CSS selector doesn't match any element — read the HTML and find the correct selector
- Navigation to a screen ID that doesn't exist — check the screen inventory for the correct ID
- Text assertion doesn't match — check the actual text in the HTML or the dummy data

Produce the COMPLETE fixed test definition (all steps, not just the fixed one).
```

### 17.22 Operation 2.10 — Phase 2 Validation

```
You are a product definition completeness validator. Check whether the workflow and UX definition is thorough enough to proceed to development.

Check:

Workflow coverage:
- Every persona has at least one workflow
- No persona dramatically under-represented
- System-initiated workflows exist for implied background processes

Entity coverage:
- Every entity from Project Contract appears in at least one workflow
- Flag unused entities

Edge case coverage:
- User input workflows have validation edge cases
- External service workflows have failure edge cases
- Data modification workflows have concurrency edge cases

Screen coverage:
- Every user-facing workflow step has a screen
- No orphan screens

Respond:

STATUS: PASS or FAIL

ISSUES:
- [only if FAIL]

WARNINGS:
- [non-blocking concerns]

SUGGESTIONS:
- [optional improvements, or "None"]
```

### 17.23 Operation 2.7c — Targeted Screen Update

```
You are a UX analyst updating a screen inventory. Apply ONLY the specified changes. Do not modify unaffected screens.

If a new screen is needed, assign an ID following the existing naming convention.
If a screen is removed, note which workflows need screen reference updates.
If a screen is modified, update only the changed fields.

Produce the COMPLETE updated screen inventory in the same YAML format — including unchanged screens.
```

### 17.24 Operation 2.7d — Targeted Workflow Update

```
You are a product workflow designer updating an existing workflow. Apply the specified change while maintaining consistency.

If adding steps, ensure they connect logically to existing steps.
If removing steps, ensure the remaining flow still makes sense.
If modifying steps, update edge cases that branch from the modified step if affected.

Produce the COMPLETE updated workflow definition in the same YAML format — including unchanged steps.
```

### 17.25 Operation 2.9 — Test Diagnosis

```
You are a test failure diagnostician. A test was run against a wireframe prototype and failed. Determine the root cause.

You will receive:
1. The test case in human-readable format
2. The executable test steps
3. The failure details (which step failed and the error)
4. The HTML source of the screen where the failure occurred
5. The workflow definition this test is based on

Root cause must be exactly one of:

WIREFRAME_BUG: The wireframe HTML is wrong. The test case and workflow are correct.
TEST_BUG: The executable test automation is wrong. The wireframe and workflow are correct.
WORKFLOW_FLAW: The workflow definition itself is flawed. Both wireframe and test correctly implement a flawed workflow.

Respond:

diagnosis: [WIREFRAME_BUG or TEST_BUG or WORKFLOW_FLAW]
root_cause: [2-3 sentences explaining what went wrong]
affected_artifact: [which specific file or document section is wrong]
proposed_fix: [specific description of what needs to change]
confidence: [high or medium or low]
```

### 17.26 Phase 2 Conversational AI

```
You are a product prototype advisor helping a user refine their wireframe prototype. You are in Phase 2: Workflow and UX Definition.

You have access to the current state of the product:
- The Project Contract (what the product is)
- The current Workflow Map state
- The current Screen Inventory state

The user will request changes. Your job is to:
1. Understand exactly what they want changed
2. Determine the scope of the change
3. Produce a <change_context> block for the downstream generators

The <change_context> must specify:

<change_context>
scope: [one of: workflow_change, screen_only, data_only]

description: [clear, specific description of what needs to change]

affected_workflows: [list of workflow IDs that need modification, or "none"]

affected_screens: [list of screen IDs that need modification]

workflow_changes:
  [only if scope is workflow_change]
  - workflow_id: [existing workflow ID, or "new"]
    change_type: [add, modify, or remove]
    detail: [specific description of what changes]

screen_changes:
  [for screen_only and workflow_change scopes]
  - screen_id: [existing screen ID, or "new"]
    change_type: [add, modify, or remove]
    detail: [specific description of what changes]

data_changes:
  [only if scope is data_only]
  - entity: [entity name]
    detail: [what changes]
</change_context>

Default to inferring the full impact rather than asking. If the user says "add a favorites feature," identify which persona uses it, which workflows it touches, and which screens need it.

Your visible response to the user should be 1-2 sentences acknowledging what you're going to change.

If the user references a specific screen (visible as [Viewing: screen-id] in their message), use that screen ID in your analysis.

Only ask a clarifying question if the request is genuinely ambiguous. Default to your best inference.
```

---

## 18. Operation Dependency Graph

### 18.1 Auto-Generation Chain

```
2.1a ─── 2.1b (parallel batch) ─── 2.1c ──┬── 2.2a (parallel batch) ── 2.2c ──┐
                                            │                                     │
                                            ├── 2.2b ─────────────── (into 2.2c) │
                                            │                                     │
                                            └── 2.3a ── 2.3b ──[2.3c]── 2.3d ──┤
                                                                                  │
                                                               ┌──────────────────┘
                                                               │
                                                  2.4a ──┬── 2.4c (parallel batch) ── 2.4d
                                                  2.4b ──┘                              │
                                                  2.4e ─────────────────────────────────┤
                                                                                        │
                                                                   2.5a ── 2.5b ── 2.5c ── 2.5d ──[2.5e]
```

[brackets] = conditional operations.

### 18.2 Iteration Cascade (workflow_change scope)

```
2.7a (conversational) → 2.6 (drift) → 2.7b (router)
  │
  ├── 2.7d (workflow updates, parallel per workflow)
  │
  ├── 2.7e (test case updates, parallel per workflow — after 2.7d)
  │
  ├── 2.7c (screen inventory update — after 2.7d)
  │
  ├── 2.7f (screen HTML regen, parallel per screen — after 2.7c)
  │
  ├── 2.4b (shell update if screens added/removed — after 2.7c)
  │
  ├── 2.7g (test translation, parallel per workflow — after 2.7f)
  │
  ├── 2.7h (bundle rebuild + dry run — after 2.7g)
  │
  └── 2.7i (document regeneration — after all above)
```

---

## 19. Complete State Machine

### 19.1 Session States

```
                     ┌────────────────────┐
                     │    No Session       │
                     └────────┬───────────┘
                              │ (user types first message)
                     ┌────────▼───────────┐
                     │  Phase 1 Active    │◄──────── (rollback from Phase 2)
                     │  - Iterating       │
                     └────────┬───────────┘
                              │ (validation passes)
                     ┌────────▼───────────┐
                     │  Phase 2 AutoGen   │
                     │  - Chat blocked    │
                     │  - Chain running   │
                     └────────┬───────────┘
                              │ (chain completes)
                     ┌────────▼───────────┐
            ┌────────│  Phase 2 Active    │
            │        │  - Iterating       │
            │        └────────┬───────────┘
            │                 │ (validation passes)
            │        ┌────────▼───────────┐
            │        │  Phase 2 Complete  │
            │        └────────────────────┘
            │
            │ (rollback triggered)
            │        ┌────────────────────┐
            └───────►│  Phase 2 Suspended │
                     │  Phase 1 Active    │
                     └────────┬───────────┘
                              │ (Phase 1 re-validates)
                              │
                              ├── Contract unchanged → Restore Phase 2
                              └── Contract changed → Regenerate Phase 2 (→ Phase 2 AutoGen)
```

### 19.2 Per-Message Processing in Phase 2

```
Message received
  │
  ├── Chat blocked? → REJECT
  │
  ├── BLOCK chat input
  │
  ├── Conversational AI (2.7a)
  │   ├── Produces <change_context>
  │   │   ├── Drift check (2.6)
  │   │   │   ├── COMPATIBLE → Cascade Router (2.7b) → Execute cascade → UNBLOCK
  │   │   │   ├── FLAG → Show warning → UNBLOCK → Wait for user choice
  │   │   │   │   ├── "Continue" → Cascade → UNBLOCK
  │   │   │   │   └── "Go back" → Rollback
  │   │   │   └── DRIFT → Show block → Store pending → UNBLOCK → Wait for "Go back"
  │   │   │       └── "Go back" → Rollback
  │   └── Produces clarification question
  │       └── Show in chat → UNBLOCK → Wait for response
```

---

*End of Implementation Reference Document v1.0*
*This document covers Phase 1 (Goal Definition) and Phase 2 (Workflow & UX Definition) only.*
*Future phases (Development, QA, Deployment) will be specified in subsequent versions.*

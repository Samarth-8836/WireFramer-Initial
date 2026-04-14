# UX Builder — Comprehensive Implementation Plan
# From Specification to Working Product — Complete Build Guide
# Version 1.0

---

## Document Index

| Section | Title |
|---------|-------|
| 1 | [Context and Goals](#1-context-and-goals) |
| 2 | [Architecture Adaptation Decisions](#2-architecture-adaptation-decisions) |
| 3 | [Technology Stack — Full Specification](#3-technology-stack--full-specification) |
| 4 | [LLM Strategy — Models, Costs, Caching](#4-llm-strategy--models-costs-caching) |
| 5 | [Project Directory Structure](#5-project-directory-structure) |
| 6 | [Sprint 0 — Project Setup](#6-sprint-0--project-setup) |
| 7 | [Sprint 1 — Storage Layer](#7-sprint-1--storage-layer) |
| 8 | [Sprint 2 — Operation Executor](#8-sprint-2--operation-executor) |
| 9 | [Sprint 3 — Context Builder](#9-sprint-3--context-builder) |
| 10 | [Sprint 4 — Session Manager](#10-sprint-4--session-manager) |
| 11 | [Sprint 5 — Phase 1 Complete](#11-sprint-5--phase-1-complete) |
| 12 | [Sprint 6 — Auto-Generation Chain](#12-sprint-6--auto-generation-chain) |
| 13 | [Sprint 7 — Drift Detection and Cascade Engine](#13-sprint-7--drift-detection-and-cascade-engine) |
| 14 | [Sprint 8 — Wireframe Viewer and Test Execution](#14-sprint-8--wireframe-viewer-and-test-execution) |
| 15 | [Sprint 9 — Rollback and Checkpoint System](#15-sprint-9--rollback-and-checkpoint-system) |
| 16 | [Sprint 10 — Polish, Errors, Session Management](#16-sprint-10--polish-errors-session-management) |
| 17 | [Sprint 11 — End-to-End Testing and Hardening](#17-sprint-11--end-to-end-testing-and-hardening) |
| 18 | [Cross-Cutting: Streaming Architecture](#18-cross-cutting-streaming-architecture) |
| 19 | [Cross-Cutting: Prompt Management System](#19-cross-cutting-prompt-management-system) |
| 20 | [Cross-Cutting: Error Handling at Every Level](#20-cross-cutting-error-handling-at-every-level) |
| 21 | [Cross-Cutting: Dependency Graph Executor](#21-cross-cutting-dependency-graph-executor) |
| 22 | [Cross-Cutting: Token Budget Management](#22-cross-cutting-token-budget-management) |
| 23 | [Cross-Cutting: Wireframe Iframe Security](#23-cross-cutting-wireframe-iframe-security) |
| 24 | [Cross-Cutting: Two-AI Pattern as Infrastructure](#24-cross-cutting-two-ai-pattern-as-infrastructure) |
| 25 | [Complete API Route Specifications](#25-complete-api-route-specifications) |
| 26 | [Complete Zustand Store Specifications](#26-complete-zustand-store-specifications) |
| 27 | [Complete UI Component Specifications](#27-complete-ui-component-specifications) |
| 28 | [Operation-to-Sprint Mapping](#28-operation-to-sprint-mapping) |
| 29 | [Risk Register and Mitigations](#29-risk-register-and-mitigations) |
| 30 | [Verification Checklist — Full System](#30-verification-checklist--full-system) |

---

## 1. Context and Goals

### 1.1 Why This Exists

The Implementation Reference Document (v1.0) specifies an AI-powered product definition tool where users describe a product idea in natural language and the system guides them through structured phases to produce: a locked product definition, complete workflow maps, a comprehensive test suite, and an interactive clickable wireframe — all before any code is written for the actual product.

This plan translates that 2800-line specification into actionable implementation steps. Every operation, every data model, every UI interaction, and every error path from the reference document is accounted for here.

### 1.2 End Goal

A working local web interface connected to a real LLM (Claude API) that allows a user to:

1. Describe a product idea in natural language
2. Iterate through conversation to refine a Project Contract (goal, personas, entities, boundaries)
3. Automatically generate: workflow maps, test suites, screen inventories, and clickable HTML wireframes
4. Browse and interact with the wireframe in a live viewer
5. Request changes through chat, with the system determining what needs to regenerate
6. Run automated tests against the wireframe and diagnose failures
7. Roll back to earlier phases and re-enter later phases with intelligent state management

### 1.3 Design Principles

1. **Get to a working demo fast.** Sprint 5 (~3 weeks) produces a usable Phase 1. Don't gold-plate infrastructure before proving the core loop works.
2. **The Operation Executor is the heart.** Every AI call goes through one code path. Get this right and everything else is straightforward.
3. **Reuse the DAG executor.** The same dependency graph engine powers both the 30-operation auto-generation chain and the 9-21 operation iteration cascades.
4. **File-based storage first.** SQLite can come later. JSON files are debuggable, inspectable, and fast enough for single-user local use.
5. **Prompt quality determines output quality.** The 23 prompts from the reference document are the most important "code" in the system.

---

## 2. Architecture Adaptation Decisions

The reference document specifies Electron + SQLite + pi-ai. We adapt for web:

### 2.1 Electron → Next.js 15 (App Router)

| Aspect | Electron (original) | Next.js (our choice) | Rationale |
|--------|---------------------|----------------------|-----------|
| Process model | Main + Renderer | Server Components + Client | Server components handle LLM calls safely (API key never exposed) |
| IPC | Electron IPC typed channels | API Routes (HTTP + SSE) | Standard web patterns, no Electron overhead |
| File access | Direct Node.js fs | Server-side only via API routes | Security boundary between browser and filesystem |
| Packaging | Electron Builder | `npm run dev` / deploy anywhere | No native build step, instant dev cycle |
| Wireframe display | webview/BrowserView | sandboxed iframe | Standard web, same security model |

### 2.2 LLM Client — pi-ai (retained from original spec)

We keep `pi-ai` as the LLM client layer. It provides a unified interface across 15+ providers (Anthropic, OpenAI, Google, and crucially **local models** via Ollama/LM Studio), which matters because we want to route cheap/experimental operations to local models during development and reserve hosted Claude for user-facing reasoning.

| Concern | How pi-ai handles it |
|---------|----------------------|
| Multi-provider | Single `streamSimple()` / `complete()` surface across hosted + local models |
| Local models | Ollama, LM Studio, llama.cpp — same API as hosted Claude |
| Streaming | `streamSimple()` yields chunks uniformly regardless of provider |
| Token tracking | Returned in the final message envelope |
| Model routing | `ModelConfig` per operation — can point any op at a local model without code changes |
| Prompt caching | Anthropic `cache_control` blocks pass through when provider=anthropic; no-op for others |
| Tool calling | TypeBox schemas (unused initially) |

**Operation Executor contract:** the executor calls pi-ai directly. No extra adapter layer — pi-ai *is* the adapter. The only thing we add on top is our own retry/parse/stream-dispatch wrapper (Section 20), which is provider-agnostic.

**Local-model use cases during development:** ops 1.0 (title), 1.3 (validation), 2.6 (drift check), and the chat-history summarizer are all cheap enough to run on a local 7B–14B model for iteration without burning API credits. Hosted Claude stays the default for user-facing conversational ops (1.1/1.2 Call A, 2.7a).

### 2.3 SQLite/Drizzle → File-based JSON

| Aspect | SQLite (original) | File JSON (our choice) | Rationale |
|--------|-------------------|----------------------|-----------|
| Setup | Drizzle migrations, native bindings | Zero setup | No native dependency issues on Windows |
| Queries | SQL via Drizzle ORM | Load JSON, filter in memory | Fine for <1000 records per session |
| Transactions | SQLite transactions | Atomic file writes (.tmp + rename) | Sufficient for single-user local |
| Debugging | DB browser tools | Open JSON in any editor | Easier to inspect and fix |
| Migration path | Already SQL | Add SQLite layer behind IStorage interface | Interface abstraction makes this painless |

### 2.4 Desktop State → Zustand

| Aspect | Original | Our choice | Rationale |
|--------|----------|-----------|-----------|
| State library | Jotai or Zustand | Zustand | Simpler API, built-in devtools, less boilerplate than Jotai for this scale |
| Persistence | In-memory + SQLite | Zustand + server state | Client state is ephemeral UI state. Persistent state lives on server (file storage) |
| Updates | Direct mutation | Zustand actions + SSE events | SSE events from server push state updates to stores |

---

## 3. Technology Stack — Full Specification

### 3.1 Runtime Dependencies

```json
{
  "dependencies": {
    "next": "^15.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "pi-ai": "latest",
    "zustand": "^5.0.0",
    "yaml": "^2.6.0",
    "react-markdown": "^9.0.0",
    "remark-gfm": "^4.0.0",
    "uuid": "^11.0.0",
    "tailwindcss": "^4.0.0"
  }
}
```

**Why each dependency:**
- `next` — Framework. App Router for server components + API routes.
- `react` / `react-dom` — UI layer.
- `pi-ai` — Unified LLM client. Hosted providers (Anthropic/OpenAI/Google) + local models (Ollama/LM Studio). Streaming and token tracking through one interface.
- `zustand` — Client state management. Lightweight, TypeScript-first.
- `yaml` — Parse YAML output from LLM calls. More robust than hand-parsing.
- `react-markdown` + `remark-gfm` — Render markdown documents in the panel. GFM for tables.
- `uuid` — Generate UUIDs for all entity IDs.
- `tailwindcss` — Styling. Utility classes for rapid UI development.

### 3.2 Dev Dependencies

```json
{
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/react": "^19.0.0",
    "@types/node": "^22.0.0",
    "@types/uuid": "^10.0.0",
    "vitest": "^3.0.0",
    "playwright": "^1.49.0",
    "@playwright/test": "^1.49.0",
    "eslint": "^9.0.0",
    "eslint-config-next": "^15.0.0"
  }
}
```

**Why each:**
- `typescript` — Strict mode. All types from the reference doc's section 3 are implemented as TypeScript interfaces.
- `vitest` — Unit tests. Fast, ESM-native, compatible with Next.js.
- `playwright` — E2E tests AND test dry run execution (Operation 2.5d). Playwright launches a headless browser to execute the wireframe test harness programmatically.
- `eslint` — Code quality.

### 3.3 TypeScript Configuration

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "paths": {
      "@/*": ["./src/*"],
      "@core/*": ["./src/core/*"],
      "@components/*": ["./src/components/*"],
      "@stores/*": ["./src/stores/*"],
      "@lib/*": ["./src/lib/*"]
    }
  }
}
```

Path aliases are critical for the project's deep nesting. `@core/operation-executor/executor` is much clearer than `../../../../core/operation-executor/executor`.

---

## 4. LLM Strategy — Models, Costs, Caching

### 4.1 Model Assignment Per Operation

Every operation in the system has an assigned model. These are defaults — all configurable via a `ModelConfig` object.

| Operation | Model | Reasoning |
|-----------|-------|-----------|
| 1.0 — Session Title | claude-haiku-4-5 | Trivial task, cheapest model |
| 1.1 — Goal Expansion (Call A: Conversational) | claude-opus-4-6 | User-facing, needs best reasoning for intent understanding |
| 1.1 — Goal Expansion (Call B: Doc Generator) | claude-sonnet-4-6 | Structured output, doesn't need opus-level reasoning |
| 1.2 — Iteration (Call A) | claude-opus-4-6 | Same as 1.1 Call A |
| 1.2 — Iteration (Call B) | claude-sonnet-4-6 | Same as 1.1 Call B |
| 1.3 — Validation | claude-sonnet-4-6 | Checklist evaluation, sonnet is sufficient |
| 2.1a — Workflow Discovery | claude-sonnet-4-6 | Structured YAML output |
| 2.1b — Workflow Detail (batch) | claude-sonnet-4-6 | Batch, cost-sensitive. Same system prompt = cache hits |
| 2.1c — Workflow Formatting | claude-sonnet-4-6 | Document formatting |
| 2.2a — Test Case Generation (batch) | claude-sonnet-4-6 | Batch, structured output |
| 2.2b — Entity Coverage | claude-sonnet-4-6 | Simple analysis |
| 2.2c — Test Suite Formatting | claude-sonnet-4-6 | Document formatting |
| 2.3a — Screen Extraction | claude-sonnet-4-6 | Structured YAML |
| 2.3b — Navigation Validation | claude-sonnet-4-6 | Validation check |
| 2.3c — Screen Correction | claude-sonnet-4-6 | Fix application |
| 2.3d — Screen Inventory Formatting | claude-sonnet-4-6 | Document formatting |
| 2.4a — Dummy Data | claude-sonnet-4-6 | JSON generation |
| 2.4b — Wireframe Shell | claude-sonnet-4-6 | HTML generation |
| 2.4c — Screen HTML (batch) | claude-sonnet-4-6 | Batch HTML, cache hits |
| 2.5a — Test Harness | claude-sonnet-4-6 | HTML generation |
| 2.5b — Test Translation (batch) | claude-sonnet-4-6 | Batch, structured |
| 2.5e — Test Repair | claude-sonnet-4-6 | Fix application |
| 2.6 — Drift Check | claude-sonnet-4-6 | Classification task |
| 2.7a — Phase 2 Conversational AI | claude-opus-4-6 | User-facing, best reasoning |
| 2.7c — Targeted Screen Update | claude-sonnet-4-6 | Structured update |
| 2.7d — Targeted Workflow Update | claude-sonnet-4-6 | Structured update |
| 2.9 — Test Diagnosis | claude-sonnet-4-6 | Analysis task |
| 2.10 — Phase 2 Validation | claude-sonnet-4-6 | Validation check |
| Chat History Summarization | claude-haiku-4-5 | Simple summarization, cheap |
| Conversation Summary Update | claude-haiku-4-5 | Append summary, cheap |

### 4.2 Cost Estimation Per Full Session

A full session (Phase 1 + Phase 2 auto-generation + a few iterations) involves roughly:

| Category | Calls | Avg Input Tokens | Avg Output Tokens | Model | Est. Cost |
|----------|-------|-----------------|-------------------|-------|-----------|
| Phase 1 (3 iterations) | 8 | 2,000 | 1,500 | Mixed | ~$0.15 |
| Auto-gen chain (10 workflows, 8 screens) | 35-40 | 3,000 | 2,000 | Sonnet | ~$1.50 |
| Phase 2 iterations (3 changes) | 15-25 | 4,000 | 2,000 | Mixed | ~$1.00 |
| Test execution + diagnosis | 5-8 | 3,000 | 1,500 | Sonnet | ~$0.30 |
| **Total per session** | **~65-80** | | | | **~$3.00** |

With prompt caching (90% discount on cached system prompts), the real cost drops to approximately **$1.50-2.00 per full session**.

### 4.3 Prompt Caching Strategy

The Anthropic API supports prompt caching via `cache_control` on message blocks. When the same content appears in subsequent requests within the TTL window, the cached tokens are charged at 10% of the normal input rate.

**How we use this:**

```typescript
// In the Operation Executor, system prompts get cache_control automatically:
const message = {
  role: 'user' as const,
  content: [
    {
      type: 'text' as const,
      text: systemPrompt,
      cache_control: { type: 'ephemeral' as const }  // 5-min TTL
    }
  ]
};
```

**Where caching has the biggest impact:**

1. **Batch operations (2.1b, 2.2a, 2.4c, 2.5b):** Same system prompt sent N times (once per workflow/screen). First call is full price, subsequent N-1 calls get 90% cache discount on the system prompt portion.
   - Example: 10 workflows × 2.1b = 10 calls with same ~500-token system prompt. Cache saves ~4,500 input tokens × $0.003/1K = ~$0.014 per batch.

2. **Phase 2 conversational AI (2.7a):** System prompt is identical across all user messages within a session. Every Phase 2 interaction gets cache hits.

3. **Iteration cascades:** When a cascade triggers multiple sub-operations, the system prompts for screen generation (2.4c) and test translation (2.5b) are cached from the auto-generation chain.

### 4.4 Model Configuration Interface

```typescript
interface ModelConfig {
  // Per-operation overrides
  operationModels: Partial<Record<OperationId, string>>;

  // Role-based defaults (used when no operation override exists)
  conversationalModel: string;    // Default: 'claude-opus-4-6'
  generatorModel: string;         // Default: 'claude-sonnet-4-6'
  utilityModel: string;           // Default: 'claude-haiku-4-5'

  // Cost tracking
  pricing: Record<string, { inputPer1M: number; outputPer1M: number }>;
}

const DEFAULT_MODEL_CONFIG: ModelConfig = {
  operationModels: {},
  conversationalModel: 'claude-opus-4-6',
  generatorModel: 'claude-sonnet-4-6',
  utilityModel: 'claude-haiku-4-5',
  pricing: {
    'claude-opus-4-6': { inputPer1M: 15, outputPer1M: 75 },
    'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },
    'claude-haiku-4-5': { inputPer1M: 0.8, outputPer1M: 4 },
  }
};
```

---

## 5. Project Directory Structure

```
UX-Builder/
├── implementation-reference-v1.md          # The source specification
├── implementation-plan.md                  # This document
├── package.json
├── tsconfig.json
├── next.config.ts
├── tailwind.config.ts
├── .env.local                              # ANTHROPIC_API_KEY=sk-ant-...
├── .gitignore
│
├── src/
│   ├── app/                                # Next.js App Router
│   │   ├── layout.tsx                      # Root layout: html, body, providers
│   │   ├── page.tsx                        # Main app entry point
│   │   ├── globals.css                     # Tailwind imports + base styles
│   │   └── api/                            # API Route Handlers
│   │       ├── health/
│   │       │   └── route.ts                # GET: health check
│   │       ├── test-llm/
│   │       │   └── route.ts                # GET: test Claude streaming (Sprint 0 only)
│   │       ├── session/
│   │       │   ├── route.ts                # POST: create session, GET: list sessions
│   │       │   └── [id]/
│   │       │       └── route.ts            # GET: session state, DELETE: remove session
│   │       ├── chat/
│   │       │   └── route.ts                # POST: send message → SSE stream response
│   │       ├── phase/
│   │       │   └── route.ts                # POST: trigger phase completion → SSE stream
│   │       ├── rollback/
│   │       │   └── route.ts                # POST: trigger rollback to previous phase
│   │       ├── drift/
│   │       │   └── route.ts                # POST: respond to drift (continue/rollback)
│   │       ├── operations/
│   │       │   └── route.ts                # GET: operation progress, POST: retry failed
│   │       ├── tests/
│   │       │   ├── route.ts                # POST: run tests → SSE stream results
│   │       │   └── diagnose/
│   │       │       └── route.ts            # POST: diagnose failure → result
│   │       └── wireframe/
│   │           └── [sessionId]/
│   │               └── [...path]/
│   │                   └── route.ts        # GET: serve wireframe files (HTML/JS/CSS)
│   │
│   ├── core/                               # All backend logic (server-only)
│   │   ├── types/                          # TypeScript interfaces from spec §3
│   │   │   ├── session.ts                  # Session, PhaseState, PhaseId, PhaseStatus
│   │   │   ├── documents.ts                # Document, DocumentType
│   │   │   ├── artifacts.ts                # Artifact, ArtifactType
│   │   │   ├── operations.ts               # OperationId, OperationStatus, OperationProgress, BatchItem
│   │   │   ├── chat.ts                     # ChatMessage, MessageRole, MessageType, MessageMetadata
│   │   │   ├── checkpoints.ts              # Checkpoint, DocumentSnapshot, ArtifactSnapshot, CascadeSnapshot
│   │   │   ├── tests.ts                    # TestRunResult, IndividualTestResult
│   │   │   ├── llm.ts                      # OperationDefinition, OperationResult, ParsedOutput, ParseError
│   │   │   ├── config.ts                   # ModelConfig, AppConfig
│   │   │   └── index.ts                    # Re-exports everything
│   │   │
│   │   ├── storage/                        # Persistence layer
│   │   │   ├── interface.ts                # IStorage interface — complete CRUD contract
│   │   │   ├── file-storage.ts             # File-based JSON implementation
│   │   │   ├── memory-storage.ts           # In-memory implementation (testing)
│   │   │   └── index.ts                    # Factory: getStorage()
│   │   │
│   │   ├── operation-executor/             # LLM call infrastructure
│   │   │   ├── executor.ts                 # Main executor: streaming, parsing, retry, caching
│   │   │   ├── streaming.ts                # SSE helpers for API routes
│   │   │   ├── parsers.ts                  # Output parsers: YAML, markdown, JSON, tags
│   │   │   ├── retry.ts                    # Retry logic with correction prompts
│   │   │   ├── token-tracker.ts            # Per-session token/cost tracking
│   │   │   └── two-ai-pattern.ts           # Reusable Two-AI Pattern orchestrator
│   │   │
│   │   ├── context-builder/                # Prompt context assembly
│   │   │   ├── context-builder.ts          # Main class: one method per operation type
│   │   │   ├── phase1-context.ts           # Phase 1 specific context logic
│   │   │   ├── phase2-context.ts           # Phase 2 complex context (spec §6.2)
│   │   │   └── summarizer.ts              # Chat history + conversation summary management
│   │   │
│   │   ├── session-manager/                # Central coordinator
│   │   │   ├── session-manager.ts          # All user actions route through here
│   │   │   ├── phase-state-machine.ts      # Valid transitions, state validation
│   │   │   ├── operation-router.ts         # Message → operation mapping
│   │   │   ├── dependency-graph.ts         # DAG executor (auto-gen + cascade)
│   │   │   └── artifact-lifecycle.ts       # Artifact state management
│   │   │
│   │   ├── operations/                     # Individual operation implementations
│   │   │   ├── phase1/
│   │   │   │   ├── op-1-0-title.ts         # Session title generation
│   │   │   │   ├── op-1-1-goal-expansion.ts # Two-AI: goal expansion + contract gen
│   │   │   │   ├── op-1-2-iteration.ts     # Two-AI: iteration + contract update
│   │   │   │   └── op-1-3-validation.ts    # Phase 1 completion validation
│   │   │   │
│   │   │   ├── phase2-autogen/
│   │   │   │   ├── op-2-1a-workflow-discovery.ts
│   │   │   │   ├── op-2-1b-workflow-detail.ts
│   │   │   │   ├── op-2-1c-workflow-formatting.ts
│   │   │   │   ├── op-2-2a-test-case-gen.ts
│   │   │   │   ├── op-2-2b-entity-coverage.ts
│   │   │   │   ├── op-2-2c-test-suite-formatting.ts
│   │   │   │   ├── op-2-3a-screen-extraction.ts
│   │   │   │   ├── op-2-3b-navigation-validation.ts
│   │   │   │   ├── op-2-3c-screen-correction.ts
│   │   │   │   ├── op-2-3d-screen-inventory-formatting.ts
│   │   │   │   ├── op-2-4a-dummy-data.ts
│   │   │   │   ├── op-2-4b-wireframe-shell.ts
│   │   │   │   ├── op-2-4c-screen-html.ts
│   │   │   │   ├── op-2-4d-smoke-test.ts
│   │   │   │   ├── op-2-4e-data-file-assembly.ts
│   │   │   │   ├── op-2-5a-test-harness.ts
│   │   │   │   ├── op-2-5b-test-translation.ts
│   │   │   │   ├── op-2-5c-test-bundle-assembly.ts
│   │   │   │   ├── op-2-5d-test-dry-run.ts
│   │   │   │   └── op-2-5e-test-repair.ts
│   │   │   │
│   │   │   └── phase2-interaction/
│   │   │       ├── op-2-6-drift-check.ts
│   │   │       ├── op-2-7a-conversational-ai.ts
│   │   │       ├── op-2-7b-cascade-router.ts
│   │   │       ├── op-2-7c-targeted-screen-update.ts
│   │   │       ├── op-2-7d-targeted-workflow-update.ts
│   │   │       ├── op-2-8-test-execution.ts
│   │   │       ├── op-2-9-diagnosis.ts
│   │   │       └── op-2-10-validation.ts
│   │   │
│   │   ├── prompts/                        # All 23 AI prompts centralized
│   │   │   ├── prompt-registry.ts          # Maps OperationId → prompt function
│   │   │   ├── phase1-prompts.ts           # Ops 1.0-1.3 (4 prompts from spec §17.1-17.4)
│   │   │   ├── phase2-autogen-prompts.ts   # Ops 2.1-2.5 (13 prompts from spec §17.5-17.21)
│   │   │   └── phase2-interaction-prompts.ts # Ops 2.6-2.10 (6 prompts from spec §17.11, 17.22-17.26)
│   │   │
│   │   ├── drift/                          # Drift detection
│   │   │   └── drift-checker.ts            # COMPATIBLE/FLAG/DRIFT classification
│   │   │
│   │   ├── cascade/                        # Iteration cascade engine
│   │   │   ├── cascade-router.ts           # Routes by scope: data_only, screen_only, workflow_change
│   │   │   └── cascade-executor.ts         # Executes cascade plan with snapshot/undo
│   │   │
│   │   ├── rollback/                       # Rollback and checkpoint system
│   │   │   ├── checkpoint-manager.ts       # Create/retrieve checkpoints
│   │   │   └── rollback-manager.ts         # Full rollback procedure from spec §14
│   │   │
│   │   └── wireframe/                      # Wireframe file management
│   │       └── wireframe-manager.ts        # Read/write/list/delete wireframe files
│   │
│   ├── components/                         # React UI components
│   │   ├── layout/
│   │   │   ├── AppShell.tsx                # Three-zone layout: sidebar + chat + document
│   │   │   ├── SessionSidebar.tsx          # Session list, switch, new chat
│   │   │   └── PhaseIndicator.tsx          # Phase flow visualization
│   │   │
│   │   ├── chat/
│   │   │   ├── ChatPanel.tsx               # Message list + input container
│   │   │   ├── ChatMessage.tsx             # Individual message rendering
│   │   │   ├── ChatInput.tsx               # Input box + phase buttons + screen ref
│   │   │   ├── SystemMessage.tsx           # System notifications + progress
│   │   │   ├── DriftWarning.tsx            # FLAG/DRIFT UI components
│   │   │   └── TestResultsMessage.tsx      # Inline test results display
│   │   │
│   │   ├── documents/
│   │   │   ├── DocumentPanel.tsx           # 60% right panel with tabs
│   │   │   ├── MarkdownViewer.tsx          # Render markdown content
│   │   │   └── DocumentsDropdown.tsx       # Document list + download
│   │   │
│   │   ├── wireframe/
│   │   │   ├── WireframeViewer.tsx         # Sandboxed iframe + controls
│   │   │   └── TestDetailPanel.tsx         # Failed test detail + diagnose/skip
│   │   │
│   │   └── shared/
│   │       ├── OperationProgress.tsx       # Auto-gen chain progress display
│   │       └── ErrorNotification.tsx       # Toast-style error display
│   │
│   ├── stores/                             # Zustand stores (client state)
│   │   ├── session-store.ts                # Active session, list, phases
│   │   ├── chat-store.ts                   # Messages, input state, blocked flag
│   │   ├── document-store.ts               # Documents, active viewed document
│   │   └── wireframe-store.ts              # Current screen, test results, viewer state
│   │
│   └── lib/                                # Shared utilities
│       ├── constants.ts                    # Model IDs, defaults, pricing, timeouts
│       ├── utils.ts                        # UUID generator, timestamps, token estimation
│       ├── api-client.ts                   # Typed fetch wrappers for all API routes
│       └── sse-client.ts                   # SSE consumer with event dispatch + reconnection
│
├── data/                                   # File-based storage (gitignored)
│   └── sessions/
│       └── [session-uuid]/
│           ├── session.json                # Session record
│           ├── phases.json                 # PhaseState records
│           ├── documents.json              # Document records (all versions)
│           ├── artifacts.json              # Artifact records
│           ├── messages.json               # Chat messages
│           ├── operations.json             # Operation progress records
│           ├── checkpoints.json            # Checkpoint records
│           ├── summaries.json              # Conversation summaries
│           ├── pending-messages.json        # Pending drift messages
│           ├── test-results.json           # Test run results
│           ├── cascade-snapshots.json      # Cascade undo snapshots
│           └── wireframe/                  # Generated HTML/JS files
│               ├── index.html
│               ├── data.js
│               ├── test-harness.html
│               ├── tests.js
│               ├── home-screen.html
│               ├── product-list.html
│               └── ...
│
└── tests/
    ├── unit/
    │   ├── storage.test.ts
    │   ├── executor.test.ts
    │   ├── parsers.test.ts
    │   ├── context-builder.test.ts
    │   ├── state-machine.test.ts
    │   ├── dependency-graph.test.ts
    │   ├── drift-checker.test.ts
    │   └── cascade-router.test.ts
    │
    └── e2e/
        ├── phase1-flow.test.ts
        ├── phase2-flow.test.ts
        └── rollback-flow.test.ts
```

---

## 6. Sprint 0 — Project Setup

### 6.1 Goal

A running Next.js app with the complete folder skeleton, all dependencies installed, TypeScript strict mode configured, and a single test API route that calls the Claude API and streams a response to the browser.

### 6.2 What Becomes Testable After This Sprint

- `npm run dev` starts successfully, visit `localhost:3000`
- Visit `/api/health` and get `{ status: "ok" }`
- Visit `/api/test-llm` and see streamed Claude response in browser
- `npx tsc --noEmit` passes with zero errors
- All type files export correct interfaces matching spec section 3

### 6.3 Dependencies

None — first sprint.

### 6.4 Detailed File Specifications

#### 6.4.1 Root Configuration Files

**package.json**: All dependencies listed in §3.1 and §3.2. Scripts: `dev`, `build`, `start`, `lint`, `test` (vitest), `test:e2e` (playwright).

**tsconfig.json**: Strict mode, path aliases, ES2022 target. As specified in §3.3.

**next.config.ts**: Minimal. Enable server components. Configure output as `standalone` for easy deployment later.

```typescript
// next.config.ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Server components are default in App Router
  // Configure webpack to handle yaml files if needed
};

export default nextConfig;
```

**tailwind.config.ts**: Content paths pointing to `src/`. No custom theme initially — Tailwind defaults are fine for Phase 1 UI.

**.env.local**: Single variable.
```
ANTHROPIC_API_KEY=sk-ant-api03-...
```

**.gitignore**: Must include:
```
node_modules/
.next/
data/
.env.local
*.log
```

#### 6.4.2 Core Type Definitions

Every interface from the reference document section 3 is implemented here. These are the exact TypeScript types.

**`src/core/types/session.ts`**:
```typescript
export interface Session {
  id: string;                    // UUID v4
  title: string;                 // Auto-generated, 3-5 words
  currentPhaseId: PhaseId;       // Which phase is active
  createdAt: string;             // ISO 8601 timestamp
  updatedAt: string;             // ISO 8601 timestamp
  status: 'active' | 'suspended'; // Suspended during rollback
}

export type PhaseId = 'phase-1' | 'phase-2';

export type PhaseStatus =
  | 'not_started'     // Phase has not been entered yet
  | 'active'          // User is currently working in this phase
  | 'completing'      // Validation is running
  | 'complete'        // Phase is locked
  | 'suspended';      // Phase is paused due to rollback

export interface PhaseState {
  sessionId: string;
  phaseId: PhaseId;
  status: PhaseStatus;
  enteredAt: string | null;      // ISO timestamp
  completedAt: string | null;
  suspendedAt: string | null;
}
```

**`src/core/types/documents.ts`**:
```typescript
export type DocumentType =
  | 'project_contract'    // Phase 1 output
  | 'workflow_map'        // Phase 2 document
  | 'test_suite'          // Phase 2 document
  | 'screen_inventory';   // Phase 2 document

export interface Document {
  id: string;                    // UUID
  sessionId: string;
  phaseId: PhaseId;
  type: DocumentType;
  content: string;               // Markdown content (user-facing)
  structuredData: string;        // YAML/JSON underlying data (system-facing)
  version: number;               // Increments on each regeneration
  status: 'active' | 'inactive'; // Only one active version per type per session
  createdAt: string;
  lastModifiedAt: string;        // Used for stale test detection
}
```

**`src/core/types/artifacts.ts`**:
```typescript
export type ArtifactType =
  | 'wireframe_shell'       // index.html
  | 'wireframe_screen'      // [screen-id].html
  | 'wireframe_data'        // data.js
  | 'test_harness'          // test-harness.html
  | 'test_definitions';     // tests.js

export interface Artifact {
  id: string;
  sessionId: string;
  type: ArtifactType;
  filename: string;              // e.g., "product-detail.html"
  filePath: string;              // Full path in wireframe directory
  relatedScreenId: string | null; // For wireframe_screen type
  status: 'active' | 'inactive' | 'generating';
  createdAt: string;
  lastModifiedAt: string;
}
```

**`src/core/types/operations.ts`**:
```typescript
export type OperationId =
  | 'op-1-0' | 'op-1-1' | 'op-1-2' | 'op-1-3'
  | 'op-2-1a' | 'op-2-1b' | 'op-2-1c'
  | 'op-2-2a' | 'op-2-2b' | 'op-2-2c'
  | 'op-2-3a' | 'op-2-3b' | 'op-2-3c' | 'op-2-3d'
  | 'op-2-4a' | 'op-2-4b' | 'op-2-4c' | 'op-2-4d' | 'op-2-4e'
  | 'op-2-5a' | 'op-2-5b' | 'op-2-5c' | 'op-2-5d' | 'op-2-5e'
  | 'op-2-6' | 'op-2-7a' | 'op-2-7b' | 'op-2-7c' | 'op-2-7d'
  | 'op-2-7e' | 'op-2-7f' | 'op-2-7g' | 'op-2-7h' | 'op-2-7i'
  | 'op-2-8' | 'op-2-9' | 'op-2-10';

export type OperationStatus =
  | 'not_started'
  | 'in_progress'
  | 'complete'
  | 'failed'
  | 'skipped';       // User chose to skip after failure

export interface OperationProgress {
  sessionId: string;
  operationId: OperationId;
  status: OperationStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;          // Error message if failed
  batchItems: BatchItem[] | null; // For batch operations
}

export interface BatchItem {
  itemId: string;                // e.g., workflow ID or screen ID
  itemName: string;              // Human-readable name
  status: OperationStatus;
  error: string | null;
  retryCount: number;            // 0, 1, or 2
}
```

**`src/core/types/chat.ts`**:
```typescript
export type MessageRole = 'user' | 'assistant' | 'system';

export type MessageType =
  | 'chat'                       // Normal conversation
  | 'system_notification'        // Phase transition, progress updates
  | 'drift_warning'              // Drift detection result
  | 'validation_result'          // Phase completion validation
  | 'test_results'               // Test execution results
  | 'diagnosis_result'           // Test failure diagnosis
  | 'operation_failure';         // Failed operation notification

export interface ChatMessage {
  id: string;
  sessionId: string;
  phaseId: PhaseId;              // Which phase this message belongs to
  role: MessageRole;
  type: MessageType;
  content: string;               // Visible text content
  metadata: MessageMetadata;
  createdAt: string;
}

export interface MessageMetadata {
  screenReference: string | null;        // Screen ID if user selected one
  generationContext: string | null;      // The <generation_context> or <change_context> block
  operationId: OperationId | null;       // Which operation produced this message
  stale: boolean;                        // For test results — set true after wireframe changes
}
```

**`src/core/types/checkpoints.ts`**:
```typescript
export interface Checkpoint {
  id: string;
  sessionId: string;
  phaseId: PhaseId;              // Phase that was just completed
  number: number;                // 1, 2, 3...
  createdAt: string;
  documentSnapshots: DocumentSnapshot[];
  artifactSnapshots: ArtifactSnapshot[];
}

export interface DocumentSnapshot {
  documentId: string;
  content: string;
  structuredData: string;
  version: number;
}

export interface ArtifactSnapshot {
  artifactId: string;
  filename: string;
  fileContent: string;           // Full file content at checkpoint time
}

export interface CascadeSnapshot {
  id: string;
  sessionId: string;
  triggeredBy: string;           // The user message that triggered this cascade
  createdAt: string;
  documentSnapshots: DocumentSnapshot[];
  artifactSnapshots: ArtifactSnapshot[];
  status: 'active' | 'applied' | 'undone';
}
```

**`src/core/types/tests.ts`**:
```typescript
export interface TestRunResult {
  id: string;
  sessionId: string;
  runAt: string;                 // Compared against artifact lastModifiedAt for stale detection
  totalTests: number;
  passed: number;
  failed: number;
  knownIssues: number;
  duration: number;              // Total milliseconds
  results: IndividualTestResult[];
}

export interface IndividualTestResult {
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

**`src/core/types/llm.ts`**:
```typescript
export interface OperationDefinition {
  operationId: OperationId;
  systemPrompt: string;
  messages: LLMMessage[];
  expectedOutputFormat: 'markdown' | 'yaml' | 'json' | 'plain_text' | 'structured';
  outputParser: (rawOutput: string) => ParsedOutput | ParseError;
  maxRetries: number;            // Default: 1
  retryPrompt: string | null;    // Additional instruction appended on retry
  timeoutMs: number;             // Per-call timeout
  provider?: 'anthropic' | 'openai' | 'google' | 'ollama' | 'lmstudio' | string; // pi-ai provider; default 'anthropic'
  model?: string;                // Override default model (must be valid for chosen provider)
  onStreamChunk?: (chunk: string) => void; // For user-facing streaming
}

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ParsedOutput {
  success: true;
  data: any;                     // Parsed structured data
  rawText: string;               // Original LLM output
}

export interface ParseError {
  success: false;
  error: string;                 // What went wrong
  rawText: string;               // Original LLM output for debugging
}

export interface OperationResult {
  operationId: OperationId;
  status: 'success' | 'failed';
  output: ParsedOutput | null;
  error: string | null;
  tokenUsage: { input: number; output: number };
  cost: number;                  // In USD
  durationMs: number;
}
```

**`src/core/types/config.ts`**:
```typescript
export interface AppConfig {
  models: ModelConfig;
  storage: {
    type: 'file' | 'memory';
    dataDir: string;             // Default: './data'
  };
  executor: {
    maxConcurrentBatchCalls: number; // Default: 3
    defaultTimeoutMs: number;        // Default: 120000 (2 min)
    defaultMaxRetries: number;       // Default: 1
  };
  contextBuilder: {
    chatHistoryTokenBudget: number;  // Default: 4000
    recentMessagePairsToKeep: number; // Default: 5
  };
}
```

**`src/core/types/index.ts`**: Re-exports everything from all type files.

#### 6.4.3 Storage Interface

**`src/core/storage/interface.ts`**:
```typescript
export interface IStorage {
  // Session
  createSession(session: Session): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  updateSession(id: string, updates: Partial<Session>): Promise<Session>;
  listSessions(): Promise<Session[]>;
  deleteSession(id: string): Promise<void>;

  // Phase State
  getPhaseState(sessionId: string, phaseId: PhaseId): Promise<PhaseState | null>;
  upsertPhaseState(state: PhaseState): Promise<PhaseState>;

  // Documents
  createDocument(doc: Document): Promise<Document>;
  getActiveDocument(sessionId: string, type: DocumentType): Promise<Document | null>;
  getDocumentsBySession(sessionId: string): Promise<Document[]>;
  updateDocument(id: string, updates: Partial<Document>): Promise<Document>;
  deactivateDocuments(sessionId: string, type: DocumentType): Promise<void>;

  // Artifacts
  createArtifact(artifact: Artifact): Promise<Artifact>;
  getActiveArtifact(sessionId: string, filename: string): Promise<Artifact | null>;
  getArtifactsBySession(sessionId: string): Promise<Artifact[]>;
  updateArtifact(id: string, updates: Partial<Artifact>): Promise<Artifact>;

  // Chat Messages
  addMessage(message: ChatMessage): Promise<ChatMessage>;
  getMessagesByPhase(sessionId: string, phaseId: PhaseId): Promise<ChatMessage[]>;
  updateMessage(id: string, updates: Partial<ChatMessage>): Promise<ChatMessage>;

  // Operation Progress
  getOperationProgress(sessionId: string, operationId: OperationId): Promise<OperationProgress | null>;
  upsertOperationProgress(progress: OperationProgress): Promise<OperationProgress>;
  getOperationsBySession(sessionId: string): Promise<OperationProgress[]>;

  // Checkpoints
  createCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint>;
  getCheckpointByNumber(sessionId: string, number: number): Promise<Checkpoint | null>;
  getLatestCheckpoint(sessionId: string): Promise<Checkpoint | null>;

  // Conversation Summaries
  getConversationSummary(sessionId: string, phaseId: PhaseId): Promise<ConversationSummary | null>;
  upsertConversationSummary(summary: ConversationSummary): Promise<ConversationSummary>;

  // Pending Messages
  createPendingMessage(msg: PendingMessage): Promise<PendingMessage>;
  getPendingMessages(sessionId: string): Promise<PendingMessage[]>;
  updatePendingMessage(id: string, updates: Partial<PendingMessage>): Promise<PendingMessage>;

  // Test Results
  saveTestRunResult(result: TestRunResult): Promise<TestRunResult>;
  getLatestTestRunResult(sessionId: string): Promise<TestRunResult | null>;

  // Cascade Snapshots
  createCascadeSnapshot(snapshot: CascadeSnapshot): Promise<CascadeSnapshot>;
  getLatestCascadeSnapshot(sessionId: string): Promise<CascadeSnapshot | null>;
  updateCascadeSnapshot(id: string, updates: Partial<CascadeSnapshot>): Promise<CascadeSnapshot>;
}

export interface ConversationSummary {
  sessionId: string;
  phaseId: PhaseId;
  summary: string;
  lastUpdatedAt: string;
  messagesCovered: number;
}

export interface PendingMessage {
  id: string;
  sessionId: string;
  originalMessage: string;
  changeContext: string;
  driftClassification: string;
  driftReason: string;
  createdAt: string;
  status: 'pending' | 'applied' | 'discarded';
}
```

#### 6.4.4 Lib Utilities

**`src/lib/constants.ts`**:
```typescript
export const MODELS = {
  OPUS: 'claude-opus-4-6',
  SONNET: 'claude-sonnet-4-6',
  HAIKU: 'claude-haiku-4-5',
} as const;

export const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
export const DEFAULT_MAX_RETRIES = 1;
export const DEFAULT_BATCH_CONCURRENCY = 3;
export const CHAT_HISTORY_TOKEN_BUDGET = 4000;
export const RECENT_MESSAGE_PAIRS_TO_KEEP = 5;
export const STALE_TEST_CHECK_ENABLED = true;

export const TOKEN_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  [MODELS.OPUS]: { inputPer1M: 15, outputPer1M: 75 },
  [MODELS.SONNET]: { inputPer1M: 3, outputPer1M: 15 },
  [MODELS.HAIKU]: { inputPer1M: 0.8, outputPer1M: 4 },
};
```

**`src/lib/utils.ts`**:
```typescript
import { v4 as uuidv4 } from 'uuid';

export function generateId(): string { return uuidv4(); }
export function now(): string { return new Date().toISOString(); }
export function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }
```

#### 6.4.5 Test LLM Route (Proof of Life)

**`src/app/api/test-llm/route.ts`**:
```typescript
// Minimal test: stream a response via pi-ai to verify the LLM layer works.
// Works against hosted Claude OR a local model depending on provider config.
import { streamSimple } from 'pi-ai';

export async function GET() {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      const stream = streamSimple({
        provider: process.env.TEST_PROVIDER ?? 'anthropic',     // e.g. 'anthropic' | 'ollama'
        model: process.env.TEST_MODEL ?? 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'Say "Hello from the model" and nothing else.' }],
        maxTokens: 256,
      });
      for await (const chunk of stream) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: chunk.text })}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}
```

This route is deliberately provider-agnostic: set `TEST_PROVIDER=ollama` + `TEST_MODEL=llama3.1:8b` to verify the local-model path without changing code.

### 6.5 Verification Steps

1. `npm install` — all dependencies install cleanly
2. `npm run dev` — Next.js starts, visit `http://localhost:3000`
3. `npx tsc --noEmit` — zero TypeScript errors
4. GET `http://localhost:3000/api/health` — returns `{ "status": "ok" }`
5. GET `http://localhost:3000/api/test-llm` — streams Claude response (verify with `curl -N` or browser EventSource)
6. All type files in `src/core/types/` exist and export the interfaces from the reference doc
7. `src/core/storage/interface.ts` exports the complete `IStorage` interface
8. All directories in the structure above exist (even if files are stubs)

---

## 7. Sprint 1 — Storage Layer

### 7.1 Goal

Working persistence layer with full CRUD for all data models. Both file-based and in-memory implementations that pass the same test suite.

### 7.2 What Becomes Testable

- Create a session, add messages, create documents, persist to disk as JSON
- Restart server, data survives (file-based)
- In-memory storage works identically (same interface, same behavior)
- Full roundtrip for every data type: write → read → verify
- Document versioning: creating v2 makes v1 inactive
- Artifact lifecycle: generating → active → inactive → deleted

### 7.3 Dependencies

Sprint 0 (type definitions, IStorage interface)

### 7.4 Detailed File Specifications

#### 7.4.1 File Storage Implementation

**`src/core/storage/file-storage.ts`**:

The primary storage engine. Each session gets its own directory under `data/sessions/[uuid]/`. Each data type is stored as a separate JSON file within that directory.

**Directory structure per session:**
```
data/sessions/[uuid]/
├── session.json          → { ...Session }
├── phases.json           → PhaseState[]
├── documents.json        → Document[]
├── artifacts.json        → Artifact[]
├── messages.json         → ChatMessage[]
├── operations.json       → OperationProgress[]
├── checkpoints.json      → Checkpoint[]
├── summaries.json        → ConversationSummary[]
├── pending-messages.json → PendingMessage[]
├── test-results.json     → TestRunResult[]
├── cascade-snapshots.json → CascadeSnapshot[]
└── wireframe/            → HTML/JS files
```

**Read pattern:**
```typescript
private async readCollection<T>(sessionId: string, filename: string): Promise<T[]> {
  const filePath = path.join(this.dataDir, 'sessions', sessionId, filename);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err: any) {
    if (err.code === 'ENOENT') return []; // File doesn't exist yet
    throw err;
  }
}
```

**Write pattern (atomic):**
```typescript
private async writeCollection<T>(sessionId: string, filename: string, data: T[]): Promise<void> {
  const dir = path.join(this.dataDir, 'sessions', sessionId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  const tmpPath = filePath + '.tmp';
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmpPath, filePath); // Atomic on same filesystem
}
```

**Document versioning logic:**
```typescript
async createDocument(doc: Document): Promise<Document> {
  const docs = await this.readCollection<Document>(doc.sessionId, 'documents.json');

  // Deactivate existing documents of the same type
  for (const existing of docs) {
    if (existing.type === doc.type && existing.status === 'active') {
      existing.status = 'inactive';
    }
  }

  // Calculate version
  const maxVersion = docs
    .filter(d => d.type === doc.type)
    .reduce((max, d) => Math.max(max, d.version), 0);

  const newDoc = { ...doc, version: maxVersion + 1, status: 'active' as const };
  docs.push(newDoc);

  await this.writeCollection(doc.sessionId, 'documents.json', docs);
  return newDoc;
}
```

**Session listing:**
```typescript
async listSessions(): Promise<Session[]> {
  const sessionsDir = path.join(this.dataDir, 'sessions');
  try {
    const dirs = await fs.readdir(sessionsDir);
    const sessions: Session[] = [];
    for (const dir of dirs) {
      const session = await this.getSession(dir);
      if (session) sessions.push(session);
    }
    return sessions.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  } catch {
    return [];
  }
}
```

#### 7.4.2 Memory Storage Implementation

**`src/core/storage/memory-storage.ts`**:

Same IStorage interface. Uses `Map<string, any[]>` keyed by `${sessionId}:${collectionName}`. All methods are synchronous wrapped in Promise.resolve(). Used exclusively for unit testing.

#### 7.4.3 Wireframe Manager

**`src/core/wireframe/wireframe-manager.ts`**:

```typescript
export class WireframeManager {
  constructor(private dataDir: string) {}

  getWireframeDir(sessionId: string): string {
    return path.join(this.dataDir, 'sessions', sessionId, 'wireframe');
  }

  async writeFile(sessionId: string, filename: string, content: string): Promise<string> {
    const dir = this.getWireframeDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  async readFile(sessionId: string, filename: string): Promise<string> {
    const filePath = path.join(this.getWireframeDir(sessionId), filename);
    return fs.readFile(filePath, 'utf-8');
  }

  async listFiles(sessionId: string): Promise<string[]> {
    const dir = this.getWireframeDir(sessionId);
    try {
      return await fs.readdir(dir);
    } catch {
      return [];
    }
  }

  async deleteFile(sessionId: string, filename: string): Promise<void> {
    const filePath = path.join(this.getWireframeDir(sessionId), filename);
    await fs.unlink(filePath).catch(() => {}); // Ignore if already deleted
  }

  async getContentType(filename: string): string {
    if (filename.endsWith('.html')) return 'text/html';
    if (filename.endsWith('.js')) return 'application/javascript';
    if (filename.endsWith('.css')) return 'text/css';
    return 'application/octet-stream';
  }
}
```

#### 7.4.4 Storage Factory

**`src/core/storage/index.ts`**:
```typescript
import { FileStorage } from './file-storage';
import { MemoryStorage } from './memory-storage';
import type { IStorage } from './interface';

let instance: IStorage | null = null;

export function getStorage(type: 'file' | 'memory' = 'file', dataDir = './data'): IStorage {
  if (!instance) {
    instance = type === 'file' ? new FileStorage(dataDir) : new MemoryStorage();
  }
  return instance;
}
```

### 7.5 Verification Steps

1. **FileStorage CRUD**: Create session → get session → update title → verify updated
2. **Document versioning**: Create project_contract v1 → create project_contract v2 → verify v1 inactive, v2 active
3. **Artifact lifecycle**: Create artifact (generating) → update (active) → update (inactive) → verify states
4. **Chat messages**: Add 10 messages → getByPhase → verify order and count
5. **Operation progress**: Upsert progress → get → verify. Update status → get → verify new status
6. **Checkpoints**: Create with snapshots → retrieve by number → verify all snapshot data intact
7. **MemoryStorage**: Run exact same test suite against MemoryStorage — all pass
8. **Wireframe manager**: Write HTML file → read back → verify content match → list files → verify filename appears → delete → verify gone
9. **Session listing**: Create 3 sessions → listSessions → verify sorted by updatedAt desc
10. **Persistence**: Write data → create new FileStorage instance → read data back → verify matches

---

## 8. Sprint 2 — Operation Executor

### 8.1 Goal

A working Operation Executor that makes streaming Claude API calls, parses structured outputs, handles retries with correction prompts, and tracks token usage and cost. This is the foundation that every single AI operation in the system uses.

### 8.2 What Becomes Testable

- Make a streaming LLM call, receive chunks in real-time
- Parse YAML output from Claude into JavaScript objects
- Parse markdown into sections by `##` headers
- Extract `<generation_context>` and `<change_context>` from mixed output
- Parse validation results (STATUS/ISSUES/SUGGESTIONS)
- Retry automatically on parse failure, succeed on second attempt
- Track tokens and cost per call and per session
- SSE streaming from API routes to browser
- Two-AI Pattern: Call A → extract context → Call B → return both outputs

### 8.3 Dependencies

Sprint 0 (types), Sprint 1 (storage for token tracking persistence)

### 8.4 Detailed File Specifications

#### 8.4.1 Main Executor

**`src/core/operation-executor/executor.ts`**:

This is the single most important file in the system. Every AI call goes through it.

```typescript
import { streamSimple } from 'pi-ai';
import type { OperationDefinition, OperationResult, ParsedOutput, ParseError, LLMMessage } from '@core/types';
import { TokenTracker } from './token-tracker';
import { buildRetryMessages } from './retry';

export class OperationExecutor {
  private tokenTracker: TokenTracker;

  constructor() {
    this.tokenTracker = new TokenTracker();
  }

  async execute(definition: OperationDefinition): Promise<OperationResult> {
    const startTime = Date.now();
    let lastError: string | null = null;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    const maxAttempts = 1 + (definition.maxRetries ?? 1);
    let currentMessages = [...definition.messages];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Build the API call parameters
        const params = this.buildParams(definition, currentMessages);

        // Execute streaming call
        const { fullText, usage } = await this.streamCall(
          params,
          definition.onStreamChunk
        );

        totalInputTokens += usage.input_tokens;
        totalOutputTokens += usage.output_tokens;

        // Parse the output
        const parseResult = definition.outputParser(fullText);

        if (parseResult.success) {
          // Success — record and return
          const durationMs = Date.now() - startTime;
          const cost = this.tokenTracker.calculateCost(
            definition.model ?? 'claude-sonnet-4-6',
            totalInputTokens,
            totalOutputTokens
          );

          return {
            operationId: definition.operationId,
            status: 'success',
            output: parseResult,
            error: null,
            tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
            cost,
            durationMs,
          };
        }

        // Parse failed — prepare retry
        lastError = parseResult.error;
        if (attempt < maxAttempts - 1 && definition.retryPrompt) {
          currentMessages = buildRetryMessages(
            definition.messages,
            fullText,
            parseResult.error,
            definition.retryPrompt
          );
        }
      } catch (err: any) {
        lastError = err.message ?? 'Unknown error';
        // SDK auto-retries 429/5xx, so if we get here it's a real failure
        if (attempt >= maxAttempts - 1) break;
      }
    }

    // All attempts exhausted
    return {
      operationId: definition.operationId,
      status: 'failed',
      output: null,
      error: lastError,
      tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
      cost: this.tokenTracker.calculateCost(
        definition.model ?? 'claude-sonnet-4-6',
        totalInputTokens,
        totalOutputTokens
      ),
      durationMs: Date.now() - startTime,
    };
  }

  private buildParams(def: OperationDefinition, messages: LLMMessage[]) {
    // pi-ai unified request. `provider` + `model` come from ModelConfig so any op
    // can be routed to hosted Claude, OpenAI, or a local Ollama model without code changes.
    // Anthropic-specific cache_control is passed through as provider options when provider=anthropic.
    return {
      provider: def.provider ?? 'anthropic',
      model: def.model ?? 'claude-sonnet-4-6',
      maxTokens: 8192,
      system: def.systemPrompt,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      providerOptions: def.provider === 'anthropic' || def.provider === undefined
        ? { cacheSystemPrompt: true }  // pi-ai translates this to cache_control: ephemeral
        : undefined,
    };
  }

  private async streamCall(
    params: any,
    onChunk?: (chunk: string) => void
  ): Promise<{ fullText: string; usage: { input_tokens: number; output_tokens: number } }> {
    let fullText = '';
    let usage = { input_tokens: 0, output_tokens: 0 };

    const stream = streamSimple(params);
    for await (const chunk of stream) {
      if (chunk.text) {
        fullText += chunk.text;
        onChunk?.(chunk.text);
      }
      if (chunk.usage) {
        usage = {
          input_tokens: chunk.usage.inputTokens ?? usage.input_tokens,
          output_tokens: chunk.usage.outputTokens ?? usage.output_tokens,
        };
      }
    }

    return { fullText, usage };
  }
}
```

#### 8.4.2 Output Parsers

**`src/core/operation-executor/parsers.ts`**:

Every parser follows the same contract: takes raw LLM output string, returns `ParsedOutput | ParseError`.

```typescript
import { parse as parseYamlLib } from 'yaml';

// Strip markdown code fences (```yaml ... ``` or ```json ... ```)
function stripCodeFences(text: string): string {
  return text.replace(/^```\w*\n?/gm, '').replace(/\n?```$/gm, '').trim();
}

// Parse YAML output
export function parseYAML(rawText: string): ParsedOutput | ParseError {
  try {
    const cleaned = stripCodeFences(rawText);
    const data = parseYamlLib(cleaned);
    if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
      return { success: false, error: 'YAML parsed to empty object', rawText };
    }
    return { success: true, data, rawText };
  } catch (err: any) {
    return { success: false, error: `YAML parse error: ${err.message}`, rawText };
  }
}

// Parse markdown by ## sections
export function parseMarkdownSections(
  rawText: string,
  expectedSections: string[]
): ParsedOutput | ParseError {
  const sections: Record<string, string> = {};
  const regex = /^## (.+)$/gm;
  let match: RegExpExecArray | null;
  const positions: { title: string; start: number }[] = [];

  while ((match = regex.exec(rawText)) !== null) {
    positions.push({ title: match[1].trim(), start: match.index });
  }

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].start + positions[i].title.length + 4; // ## + title + \n
    const end = i + 1 < positions.length ? positions[i + 1].start : rawText.length;
    sections[positions[i].title] = rawText.slice(start, end).trim();
  }

  // Validate expected sections exist
  const missing = expectedSections.filter(s => !sections[s] || sections[s].length === 0);
  if (missing.length > 0) {
    return {
      success: false,
      error: `Missing or empty sections: ${missing.join(', ')}`,
      rawText,
    };
  }

  return { success: true, data: { sections, fullMarkdown: rawText }, rawText };
}

// Parse JSON output
export function parseJSON(rawText: string): ParsedOutput | ParseError {
  try {
    const cleaned = stripCodeFences(rawText);
    const data = JSON.parse(cleaned);
    return { success: true, data, rawText };
  } catch (err: any) {
    return { success: false, error: `JSON parse error: ${err.message}`, rawText };
  }
}

// Extract <generation_context> block
export function extractGenerationContext(rawText: string): ParsedOutput | ParseError {
  const regex = /<generation_context>([\s\S]*?)<\/generation_context>/;
  const match = rawText.match(regex);

  if (!match) {
    // No generation context = clarifying question (this is valid, not an error)
    return {
      success: true,
      data: {
        visibleResponse: rawText.trim(),
        generationContext: null,
        isClarifyingQuestion: true,
      },
      rawText,
    };
  }

  const visibleResponse = rawText.slice(0, match.index).trim();
  const contextYaml = match[1].trim();

  try {
    const contextData = parseYamlLib(contextYaml);
    return {
      success: true,
      data: {
        visibleResponse,
        generationContext: contextData,
        generationContextRaw: contextYaml,
        isClarifyingQuestion: false,
      },
      rawText,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Failed to parse YAML inside <generation_context>: ${err.message}`,
      rawText,
    };
  }
}

// Extract <change_context> block (Phase 2)
export function extractChangeContext(rawText: string): ParsedOutput | ParseError {
  const regex = /<change_context>([\s\S]*?)<\/change_context>/;
  const match = rawText.match(regex);

  if (!match) {
    return {
      success: true,
      data: {
        visibleResponse: rawText.trim(),
        changeContext: null,
        isClarifyingQuestion: true,
      },
      rawText,
    };
  }

  const visibleResponse = rawText.slice(0, match.index).trim();
  const contextYaml = match[1].trim();

  try {
    const contextData = parseYamlLib(contextYaml);
    // Validate required fields
    if (!contextData.scope || !contextData.description) {
      return {
        success: false,
        error: 'change_context missing required fields: scope, description',
        rawText,
      };
    }
    return {
      success: true,
      data: {
        visibleResponse,
        changeContext: contextData,
        changeContextRaw: contextYaml,
        isClarifyingQuestion: false,
      },
      rawText,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Failed to parse YAML inside <change_context>: ${err.message}`,
      rawText,
    };
  }
}

// Parse validation result (Operations 1.3 and 2.10)
export function parseValidationResult(rawText: string): ParsedOutput | ParseError {
  const statusMatch = rawText.match(/STATUS:\s*(PASS|FAIL)/i);
  if (!statusMatch) {
    return { success: false, error: 'Could not find STATUS: PASS or FAIL', rawText };
  }

  const status = statusMatch[1].toUpperCase() as 'PASS' | 'FAIL';

  const extractList = (header: string): string[] => {
    const regex = new RegExp(`${header}:\\s*\\n((?:- .+\\n?)*)`, 'i');
    const match = rawText.match(regex);
    if (!match) return [];
    return match[1]
      .split('\n')
      .map(line => line.replace(/^- /, '').trim())
      .filter(Boolean);
  };

  return {
    success: true,
    data: {
      status,
      issues: extractList('ISSUES'),
      warnings: extractList('WARNINGS'),
      suggestions: extractList('SUGGESTIONS'),
    },
    rawText,
  };
}

// Parse drift check result (Operation 2.6)
export function parseDriftResult(rawText: string): ParsedOutput | ParseError {
  const classMatch = rawText.match(/classification:\s*(COMPATIBLE|FLAG|DRIFT)/i);
  const typeMatch = rawText.match(/type:\s*(.+)/i);
  const reasonMatch = rawText.match(/reason:\s*(.+)/i);

  if (!classMatch) {
    return { success: false, error: 'Could not find classification field', rawText };
  }

  return {
    success: true,
    data: {
      classification: classMatch[1].toUpperCase(),
      type: typeMatch?.[1]?.trim() ?? 'NONE',
      reason: reasonMatch?.[1]?.trim() ?? '',
    },
    rawText,
  };
}

// Parse diagnosis result (Operation 2.9)
export function parseDiagnosisResult(rawText: string): ParsedOutput | ParseError {
  const diagnosisMatch = rawText.match(/diagnosis:\s*(WIREFRAME_BUG|TEST_BUG|WORKFLOW_FLAW)/i);
  const rootCauseMatch = rawText.match(/root_cause:\s*(.+(?:\n(?!affected_|proposed_|confidence:).+)*)/i);
  const artifactMatch = rawText.match(/affected_artifact:\s*(.+)/i);
  const fixMatch = rawText.match(/proposed_fix:\s*(.+(?:\n(?!confidence:).+)*)/i);
  const confidenceMatch = rawText.match(/confidence:\s*(high|medium|low)/i);

  if (!diagnosisMatch) {
    return { success: false, error: 'Could not find diagnosis field', rawText };
  }

  return {
    success: true,
    data: {
      diagnosis: diagnosisMatch[1].toUpperCase(),
      rootCause: rootCauseMatch?.[1]?.trim() ?? '',
      affectedArtifact: artifactMatch?.[1]?.trim() ?? '',
      proposedFix: fixMatch?.[1]?.trim() ?? '',
      confidence: confidenceMatch?.[1]?.toLowerCase() ?? 'medium',
    },
    rawText,
  };
}
```

#### 8.4.3 Retry Logic

**`src/core/operation-executor/retry.ts`**:

```typescript
import type { LLMMessage } from '@core/types';

export function buildRetryMessages(
  originalMessages: LLMMessage[],
  failedOutput: string,
  parseError: string,
  retryPrompt: string
): LLMMessage[] {
  return [
    ...originalMessages,
    // Include the failed response as assistant message
    { role: 'assistant' as const, content: failedOutput },
    // Correction instruction as user message
    {
      role: 'user' as const,
      content: [
        'The previous response could not be parsed correctly.',
        `Error: ${parseError}`,
        '',
        'Please regenerate your response following the exact format specified in the instructions.',
        retryPrompt,
      ].join('\n'),
    },
  ];
}
```

#### 8.4.4 Token Tracker

**`src/core/operation-executor/token-tracker.ts`**:

```typescript
import { TOKEN_PRICING } from '@lib/constants';

interface TokenRecord {
  operationId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  timestamp: string;
}

export class TokenTracker {
  private records: Map<string, TokenRecord[]> = new Map(); // keyed by sessionId

  record(sessionId: string, record: TokenRecord): void {
    const existing = this.records.get(sessionId) ?? [];
    existing.push(record);
    this.records.set(sessionId, existing);
  }

  calculateCost(model: string, inputTokens: number, outputTokens: number): number {
    const pricing = TOKEN_PRICING[model];
    if (!pricing) return 0;
    return (
      (inputTokens / 1_000_000) * pricing.inputPer1M +
      (outputTokens / 1_000_000) * pricing.outputPer1M
    );
  }

  getSessionTotal(sessionId: string): { totalInput: number; totalOutput: number; totalCost: number } {
    const records = this.records.get(sessionId) ?? [];
    return records.reduce(
      (acc, r) => ({
        totalInput: acc.totalInput + r.inputTokens,
        totalOutput: acc.totalOutput + r.outputTokens,
        totalCost: acc.totalCost + r.cost,
      }),
      { totalInput: 0, totalOutput: 0, totalCost: 0 }
    );
  }
}
```

#### 8.4.5 SSE Streaming

**`src/core/operation-executor/streaming.ts`**:

```typescript
// Server-Sent Events helper for Next.js API routes

export type SSEEventType =
  | 'chunk'           // Text delta for chat
  | 'document'        // Document created/updated
  | 'phase'           // Phase transition
  | 'progress'        // Operation progress
  | 'test-results'    // Test execution results
  | 'drift'           // Drift detection result
  | 'error'           // Error
  | 'complete';       // Done

export interface SSEEvent {
  type: SSEEventType;
  data: any;
}

export class SSEWriter {
  private encoder = new TextEncoder();
  private controller: ReadableStreamDefaultController | null = null;

  createStream(): ReadableStream {
    return new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });
  }

  send(event: SSEEvent): void {
    if (!this.controller) return;
    const data = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    this.controller.enqueue(this.encoder.encode(data));
  }

  sendChunk(text: string): void {
    this.send({ type: 'chunk', data: { text } });
  }

  sendProgress(info: { operationId: string; status: string; detail?: string }): void {
    this.send({ type: 'progress', data: info });
  }

  sendDocument(doc: { type: string; content: string; version: number }): void {
    this.send({ type: 'document', data: doc });
  }

  sendError(error: string): void {
    this.send({ type: 'error', data: { error } });
  }

  sendComplete(data?: any): void {
    this.send({ type: 'complete', data: data ?? {} });
    this.close();
  }

  close(): void {
    this.controller?.close();
    this.controller = null;
  }
}

export function createSSEResponse(writer: SSEWriter): Response {
  const stream = writer.createStream();
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
```

#### 8.4.6 Two-AI Pattern

**`src/core/operation-executor/two-ai-pattern.ts`**:

This implements the universal Two-AI Pattern from spec section 1.4. Used by Operations 1.1, 1.2, and 2.7a.

```typescript
import { OperationExecutor } from './executor';
import type { OperationDefinition, OperationResult, ParsedOutput } from '@core/types';

export interface TwoAIResult {
  visibleResponse: string;          // What the user sees in chat
  generatedDocument: string | null; // The document from Call B (null if clarifying question)
  structuredData: any | null;       // Parsed structured data from Call B
  isClarifyingQuestion: boolean;    // True if Call A asked a question instead of generating
  callAResult: OperationResult;
  callBResult: OperationResult | null;
}

export async function executeTwoAIPattern(
  executor: OperationExecutor,
  callADefinition: OperationDefinition,    // Conversational AI
  callBFactory: (contextData: any) => OperationDefinition, // Document generator (built from Call A's context)
  contextExtractor: (callAOutput: ParsedOutput) => { contextData: any; isClarifyingQuestion: boolean }
): Promise<TwoAIResult> {
  // Step 1: Execute Call A (Conversational AI)
  const callAResult = await executor.execute(callADefinition);

  if (callAResult.status === 'failed' || !callAResult.output) {
    throw new Error(`Call A failed: ${callAResult.error}`);
  }

  // Step 2: Extract context
  const { contextData, isClarifyingQuestion } = contextExtractor(callAResult.output);

  if (isClarifyingQuestion) {
    return {
      visibleResponse: callAResult.output.data.visibleResponse,
      generatedDocument: null,
      structuredData: null,
      isClarifyingQuestion: true,
      callAResult,
      callBResult: null,
    };
  }

  // Step 3: Execute Call B (Document Generator)
  const callBDef = callBFactory(contextData);
  const callBResult = await executor.execute(callBDef);

  if (callBResult.status === 'failed' || !callBResult.output) {
    throw new Error(`Call B (document generator) failed: ${callBResult.error}`);
  }

  return {
    visibleResponse: callAResult.output.data.visibleResponse,
    generatedDocument: callBResult.output.data.fullMarkdown ?? callBResult.output.rawText,
    structuredData: callAResult.output.data.generationContext ?? callAResult.output.data.changeContext,
    isClarifyingQuestion: false,
    callAResult,
    callBResult,
  };
}
```

### 8.5 Verification Steps

1. **Simple call**: Execute with plain_text format, get text response, verify content
2. **YAML parsing**: Execute with YAML prompt, parse output, verify structure
3. **JSON parsing**: Execute with JSON prompt, parse output, verify structure
4. **Markdown sections**: Parse markdown with 4 sections, verify all extracted
5. **Generation context extraction**: Parse response with `<generation_context>`, verify visible text and YAML data separated
6. **Change context extraction**: Same for `<change_context>`
7. **Clarifying question**: Parse response WITHOUT context tags, verify `isClarifyingQuestion: true`
8. **Validation parsing**: Parse "STATUS: PASS\nSUGGESTIONS:\n- item", verify structure
9. **Drift parsing**: Parse "classification: FLAG\ntype: ...\nreason: ...", verify fields
10. **Code fence stripping**: Input `\`\`\`yaml\nkey: value\n\`\`\`` → parsed correctly
11. **Retry on failure**: Mock parser to fail first time, succeed second. Verify retry message includes error.
12. **Retries exhausted**: Mock parser to always fail. Verify OperationResult.status = 'failed'.
13. **Token tracking**: Make call, verify tokenUsage has positive input and output counts
14. **Cost calculation**: Verify cost matches expected based on model pricing
15. **SSE streaming**: Write events to SSEWriter, verify output format matches SSE spec
16. **Two-AI pattern**: Mock executor, verify Call A → context extract → Call B → combined result
17. **Two-AI clarifying**: Mock Call A to return no context, verify Call B is NOT called

---

## 9. Sprint 3 — Context Builder

### 9.1 Goal

A working Context Builder that assembles the exact prompt context for every operation. This is the bridge between the Session Manager (which knows WHAT to do) and the Operation Executor (which knows HOW to call the LLM). The Context Builder knows WHAT CONTEXT each operation needs.

### 9.2 What Becomes Testable

- Phase 1 first message context: just system prompt + user message
- Phase 1 iteration context: includes full chat history (or summarized if over budget)
- Document generator context: isolated — no chat history, just the generation_context
- Phase 1 validation context: includes the full Project Contract
- Phase 2 conversational context: contract + workflow summary + screen summary + conversation summary + chat history + screen reference
- Chat history summarization triggers when budget exceeded
- Conversation summary maintenance after iterations

### 9.3 Dependencies

Sprint 0 (types), Sprint 1 (storage), Sprint 2 (executor — for summarization AI calls)

### 9.4 Detailed File Specifications

#### 9.4.1 Main Context Builder

**`src/core/context-builder/context-builder.ts`**:

One method per operation that needs custom context assembly. Each returns `{ systemPrompt: string, messages: LLMMessage[] }`.

```typescript
export class ContextBuilder {
  constructor(
    private storage: IStorage,
    private promptRegistry: PromptRegistry,
    private summarizer: Summarizer
  ) {}

  // --- Phase 1 ---

  async buildPhase1FirstMessage(userMessage: string): Promise<{ systemPrompt: string; messages: LLMMessage[] }> {
    return {
      systemPrompt: this.promptRegistry.get('phase1-conversational'),
      messages: [{ role: 'user', content: userMessage }],
    };
  }

  async buildPhase1Iteration(
    sessionId: string,
    userMessage: string
  ): Promise<{ systemPrompt: string; messages: LLMMessage[] }> {
    const history = await this.storage.getMessagesByPhase(sessionId, 'phase-1');
    const chatMessages = history.filter(m => m.type === 'chat');
    const processedHistory = await this.summarizer.processHistory(chatMessages, CHAT_HISTORY_TOKEN_BUDGET);

    return {
      systemPrompt: this.promptRegistry.get('phase1-conversational'),
      messages: [
        ...processedHistory,
        { role: 'user', content: userMessage },
      ],
    };
  }

  async buildDocumentGeneratorContext(generationContext: string): Promise<{ systemPrompt: string; messages: LLMMessage[] }> {
    return {
      systemPrompt: this.promptRegistry.get('project-contract-generator'),
      messages: [
        { role: 'user', content: `Generate the Project Contract from this context:\n\n${generationContext}` },
      ],
    };
  }

  async buildPhase1Validation(sessionId: string): Promise<{ systemPrompt: string; messages: LLMMessage[] }> {
    const contract = await this.storage.getActiveDocument(sessionId, 'project_contract');
    if (!contract) throw new Error('No active project contract found');

    return {
      systemPrompt: this.promptRegistry.get('phase1-validation'),
      messages: [
        { role: 'user', content: contract.content },
      ],
    };
  }

  // --- Phase 2 Auto-Generation ---

  async buildWorkflowDiscovery(sessionId: string): Promise<{ systemPrompt: string; messages: LLMMessage[] }> {
    const contract = await this.storage.getActiveDocument(sessionId, 'project_contract');
    return {
      systemPrompt: this.promptRegistry.get('workflow-discovery'),
      messages: [
        { role: 'user', content: contract!.content },
      ],
    };
  }

  async buildWorkflowDetail(
    sessionId: string,
    workflowStub: string
  ): Promise<{ systemPrompt: string; messages: LLMMessage[] }> {
    const contract = await this.storage.getActiveDocument(sessionId, 'project_contract');
    return {
      systemPrompt: this.promptRegistry.get('workflow-detail'),
      messages: [
        { role: 'user', content: `Project Contract:\n${contract!.content}\n\nWorkflow to detail:\n${workflowStub}` },
      ],
    };
  }

  // ... buildTestCaseGeneration, buildScreenExtraction, buildScreenHTMLGeneration,
  //     buildTestTranslation, buildDriftCheck, etc. — one per operation

  // --- Phase 2 Interaction ---

  async buildPhase2ConversationalContext(
    sessionId: string,
    userMessage: string,
    screenRef: string | null
  ): Promise<{ systemPrompt: string; messages: LLMMessage[] }> {
    const systemContext = await this.buildPhase2SystemContext(sessionId, screenRef);
    const history = await this.storage.getMessagesByPhase(sessionId, 'phase-2');
    const chatMessages = history.filter(m => m.type === 'chat');
    const processedHistory = await this.summarizer.processHistory(chatMessages, CHAT_HISTORY_TOKEN_BUDGET);

    const messageWithScreenRef = screenRef
      ? `[Viewing: ${screenRef}]\n\n${userMessage}`
      : userMessage;

    return {
      systemPrompt: this.promptRegistry.get('phase2-conversational'),
      messages: [
        { role: 'system', content: systemContext },
        ...processedHistory,
        { role: 'user', content: messageWithScreenRef },
      ],
    };
  }
}
```

#### 9.4.2 Phase 2 Context Assembly

**`src/core/context-builder/phase2-context.ts`**:

This is the most complex context assembly in the system (spec section 6.2).

```typescript
export async function buildPhase2SystemContext(
  storage: IStorage,
  sessionId: string,
  screenRef: string | null
): Promise<string> {
  const contract = await storage.getActiveDocument(sessionId, 'project_contract');
  const conversationSummary = await storage.getConversationSummary(sessionId, 'phase-2');
  const workflowMap = await storage.getActiveDocument(sessionId, 'workflow_map');
  const screenInventory = await storage.getActiveDocument(sessionId, 'screen_inventory');

  let context = '';

  // 1. Project Contract — always in full
  context += `## Project Contract\n${contract!.content}\n\n`;

  // 2. Conversation summary — running log of Phase 2 changes
  if (conversationSummary) {
    context += `## Changes Made So Far in Phase 2\n${conversationSummary.summary}\n\n`;
  }

  // 3. Workflow Map summary
  if (workflowMap) {
    context += `## Current Workflow Map\n`;
    context += buildWorkflowSummary(workflowMap.structuredData, conversationSummary);
    context += '\n\n';
  }

  // 4. Screen Inventory summary
  if (screenInventory) {
    context += `## Current Screen Inventory\n`;
    context += buildScreenSummary(screenInventory.structuredData, conversationSummary);
    context += '\n\n';
  }

  // 5. If user selected a screen — full detail
  if (screenRef && screenInventory) {
    context += `## Currently Viewed Screen (Full Detail)\n`;
    context += getFullScreenDetail(screenInventory.structuredData, screenRef);
    context += '\n\n';

    if (workflowMap) {
      context += `## Workflows Touching This Screen\n`;
      context += getWorkflowsForScreen(workflowMap.structuredData, screenRef);
      context += '\n\n';
    }
  }

  return context;
}
```

**`buildWorkflowSummary`**: For each workflow — ID, name, persona, category, step count, edge case count. For workflows modified in last 3 iterations (from conversation summary), include before/after.

**`buildScreenSummary`**: Same pattern. For each screen — ID, name, type, action count. Recently modified screens get before/after annotation.

**`getFullScreenDetail`**: Parse the screen inventory YAML, find the screen by ID, return its complete data (description, personas, workflows, actions, data displayed).

**`getWorkflowsForScreen`**: Parse workflow map YAML, find all workflows that reference the given screen ID in any step, return their summaries.

#### 9.4.3 Summarizer

**`src/core/context-builder/summarizer.ts`**:

```typescript
export class Summarizer {
  constructor(private executor: OperationExecutor) {}

  // Process chat history: keep recent, summarize older
  async processHistory(
    messages: ChatMessage[],
    tokenBudget: number
  ): Promise<LLMMessage[]> {
    const pairs = this.groupIntoPairs(messages);

    if (this.estimateTokens(messages) <= tokenBudget) {
      // Under budget — use all messages as-is
      return messages.map(m => ({ role: m.role, content: m.content }));
    }

    // Over budget — keep recent 5 pairs, summarize the rest
    const recentPairs = pairs.slice(-RECENT_MESSAGE_PAIRS_TO_KEEP);
    const olderPairs = pairs.slice(0, -RECENT_MESSAGE_PAIRS_TO_KEEP);

    if (olderPairs.length === 0) {
      // Only recent messages, truncate from beginning
      return recentPairs.flat().map(m => ({ role: m.role, content: m.content }));
    }

    const summary = await this.summarizeMessages(olderPairs.flat());

    return [
      { role: 'system', content: `Previous conversation summary:\n${summary}` },
      ...recentPairs.flat().map(m => ({ role: m.role, content: m.content })),
    ];
  }

  // Maintain Phase 2 conversation summary (spec §6.5)
  async updateConversationSummary(
    storage: IStorage,
    sessionId: string,
    iterationNumber: number,
    changeDescription: string,
    scope: string,
    affectedArtifacts: string[]
  ): Promise<void> {
    const existing = await storage.getConversationSummary(sessionId, 'phase-2');
    const newEntry = `Iteration ${iterationNumber}: ${changeDescription} [scope: ${scope}, affected: ${affectedArtifacts.join(', ')}]`;

    const updatedSummary = existing
      ? existing.summary + '\n' + newEntry
      : newEntry;

    await storage.upsertConversationSummary({
      sessionId,
      phaseId: 'phase-2',
      summary: updatedSummary,
      lastUpdatedAt: new Date().toISOString(),
      messagesCovered: (existing?.messagesCovered ?? 0) + 1,
    });
  }

  private async summarizeMessages(messages: ChatMessage[]): Promise<string> {
    const content = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    const result = await this.executor.execute({
      operationId: 'op-1-0' as any, // utility call
      systemPrompt: 'Summarize the following conversation into a brief paragraph capturing all decisions made, changes requested, and current state. Do not omit any decision or change.',
      messages: [{ role: 'user', content }],
      expectedOutputFormat: 'plain_text',
      outputParser: (text) => ({ success: true, data: text, rawText: text }),
      maxRetries: 0,
      retryPrompt: null,
      timeoutMs: 30000,
      model: 'claude-haiku-4-5', // Cheap model for summarization
    });

    return result.output?.rawText ?? content.slice(0, 500) + '...'; // Fallback
  }

  private estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
  }

  private groupIntoPairs(messages: ChatMessage[]): ChatMessage[][] {
    const pairs: ChatMessage[][] = [];
    for (let i = 0; i < messages.length; i += 2) {
      pairs.push(messages.slice(i, i + 2));
    }
    return pairs;
  }
}
```

### 9.5 Verification Steps

1. **Phase 1 first message**: Returns system prompt + single user message, no history
2. **Phase 1 iteration with short history**: Returns all messages in order
3. **Phase 1 iteration with long history**: History exceeds budget → older messages summarized, recent 5 pairs kept
4. **Document generator context**: Returns ONLY system prompt + generation_context, NO chat history
5. **Phase 1 validation context**: Returns system prompt + full project contract content
6. **Phase 2 system context**: Includes contract + conversation summary + workflow summary + screen summary
7. **Phase 2 with screen reference**: Additionally includes full screen detail + related workflows
8. **Phase 2 without screen reference**: No screen detail sections
9. **Workflow summary with recent modifications**: Workflows changed in last 3 iterations have before/after annotations
10. **Conversation summary update**: After calling updateConversationSummary, storage has updated entry with iteration number

---

## 10. Sprint 4 — Session Manager

### 10.1 Goal

The Session Manager is the central coordinator. All user actions route through it. It implements the phase state machine, decides which operation to invoke, manages the dependency graph for the auto-generation chain, and enforces chat input blocking.

### 10.2 What Becomes Testable

- Create a new session → session record + phase-1 state created
- Phase state machine enforces valid transitions, rejects invalid ones
- First message → routed to Op 1.1 (goal expansion)
- Follow-up message → routed to Op 1.2 (iteration)
- Phase 2 message → routed to Op 2.7a (conversational AI)
- Chat blocked during operations → messages rejected
- Dependency graph executes operations in correct topological order
- Parallel operations at the same level run simultaneously
- Conditional operations (2.3c, 2.5e) skip when condition not met
- Artifact lifecycle managed correctly through operations

### 10.3 Dependencies

Sprint 0-3

### 10.4 Detailed File Specifications

#### 10.4.1 Session Manager

**`src/core/session-manager/session-manager.ts`**:

The main orchestrator. Every user action enters through one of its methods.

```typescript
export class SessionManager {
  private chatBlocked: Map<string, boolean> = new Map();

  constructor(
    private storage: IStorage,
    private executor: OperationExecutor,
    private contextBuilder: ContextBuilder,
    private dependencyGraph: DependencyGraphExecutor
  ) {}

  async createSession(firstMessage: string, sseWriter: SSEWriter): Promise<Session> {
    // 1. Create session record
    const session = await this.storage.createSession({
      id: generateId(),
      title: 'New Session',
      currentPhaseId: 'phase-1',
      createdAt: now(),
      updatedAt: now(),
      status: 'active',
    });

    // 2. Create phase-1 state
    await this.storage.upsertPhaseState({
      sessionId: session.id,
      phaseId: 'phase-1',
      status: 'active',
      enteredAt: now(),
      completedAt: null,
      suspendedAt: null,
    });

    // 3. Create Checkpoint 1 (empty start)
    await this.storage.createCheckpoint({
      id: generateId(),
      sessionId: session.id,
      phaseId: 'phase-1',
      number: 1,
      createdAt: now(),
      documentSnapshots: [],
      artifactSnapshots: [],
    });

    // 4. Fire Op 1.0 (title) in parallel with Op 1.1 (goal expansion)
    // Title generation is fire-and-forget
    this.generateTitle(session.id, firstMessage);

    // 5. Fire Op 1.1 (goal expansion) — this is the main response
    await this.executeGoalExpansion(session.id, firstMessage, sseWriter);

    return session;
  }

  async handleMessage(
    sessionId: string,
    message: string,
    screenRef: string | null,
    sseWriter: SSEWriter
  ): Promise<void> {
    // Check if chat is blocked
    if (this.chatBlocked.get(sessionId)) {
      sseWriter.sendError('Please wait for the current operation to complete.');
      sseWriter.close();
      return;
    }

    const session = await this.storage.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const phase = await this.storage.getPhaseState(sessionId, session.currentPhaseId);
    if (!phase || phase.status !== 'active') {
      sseWriter.sendError('This phase is not active.');
      sseWriter.close();
      return;
    }

    // Block chat for the duration of the operation
    this.chatBlocked.set(sessionId, true);

    try {
      // Route based on current phase
      if (session.currentPhaseId === 'phase-1') {
        await this.handlePhase1Message(sessionId, message, sseWriter);
      } else {
        await this.handlePhase2Message(sessionId, message, screenRef, sseWriter);
      }
    } finally {
      this.chatBlocked.set(sessionId, false);
    }
  }

  async completePhase(sessionId: string, sseWriter: SSEWriter): Promise<void> {
    const session = await this.storage.getSession(sessionId);
    if (!session) throw new Error('Session not found');

    if (session.currentPhaseId === 'phase-1') {
      await this.completePhase1(sessionId, sseWriter);
    } else {
      await this.completePhase2(sessionId, sseWriter);
    }
  }

  // ... private methods for each route
}
```

#### 10.4.2 Phase State Machine

**`src/core/session-manager/phase-state-machine.ts`**:

```typescript
const VALID_TRANSITIONS: Record<PhaseStatus, PhaseStatus[]> = {
  'not_started': ['active'],
  'active': ['completing', 'suspended'],
  'completing': ['complete', 'active'],  // complete on PASS, active on FAIL
  'complete': [],                         // Terminal (can only go to suspended via rollback)
  'suspended': ['active'],               // Restored
};

export function validateTransition(from: PhaseStatus, to: PhaseStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export async function transitionPhase(
  storage: IStorage,
  sessionId: string,
  phaseId: PhaseId,
  newStatus: PhaseStatus
): Promise<PhaseState> {
  const current = await storage.getPhaseState(sessionId, phaseId);
  if (!current) throw new Error(`No phase state found for ${phaseId}`);

  if (!validateTransition(current.status, newStatus)) {
    throw new Error(`Invalid phase transition: ${current.status} → ${newStatus}`);
  }

  const updates: Partial<PhaseState> = { status: newStatus };
  if (newStatus === 'complete') updates.completedAt = now();
  if (newStatus === 'suspended') updates.suspendedAt = now();
  if (newStatus === 'active' && current.status === 'not_started') updates.enteredAt = now();

  return storage.upsertPhaseState({ ...current, ...updates });
}
```

#### 10.4.3 Operation Router

**`src/core/session-manager/operation-router.ts`**:

```typescript
export function routeMessage(
  phaseId: PhaseId,
  hasExistingDocuments: boolean
): OperationId {
  if (phaseId === 'phase-1') {
    return hasExistingDocuments ? 'op-1-2' : 'op-1-1';
  }
  // Phase 2 always routes to conversational AI
  return 'op-2-7a';
}
```

#### 10.4.4 Dependency Graph Executor

**`src/core/session-manager/dependency-graph.ts`**:

This is the DAG executor that powers both the auto-generation chain and iteration cascades. Full specification in [§21](#21-cross-cutting-dependency-graph-executor).

```typescript
export interface GraphNode {
  operationId: string;
  dependencies: string[];
  condition?: () => Promise<boolean>;  // For conditional operations
  execute: () => Promise<void>;        // The operation to run
}

export class DependencyGraphExecutor {
  private statuses: Map<string, OperationStatus> = new Map();
  private maxConcurrency: number;
  private onProgress?: (operationId: string, status: OperationStatus) => void;

  constructor(maxConcurrency = 3, onProgress?: (id: string, status: OperationStatus) => void) {
    this.maxConcurrency = maxConcurrency;
    this.onProgress = onProgress;
  }

  async execute(nodes: GraphNode[]): Promise<Map<string, OperationStatus>> {
    // Initialize all to not_started
    for (const node of nodes) {
      this.statuses.set(node.operationId, 'not_started');
    }

    while (true) {
      // Find ready operations
      const ready = nodes.filter(n => {
        if (this.statuses.get(n.operationId) !== 'not_started') return false;
        return n.dependencies.every(dep => this.statuses.get(dep) === 'complete');
      });

      if (ready.length === 0) {
        // Check if everything is done or we're blocked
        const inProgress = [...this.statuses.values()].filter(s => s === 'in_progress');
        if (inProgress.length === 0) break; // All done or blocked
        // Wait for in-progress operations (handled by Promise.allSettled below)
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      // Check conditions and skip if not met
      const toExecute: GraphNode[] = [];
      for (const node of ready) {
        if (node.condition) {
          const shouldRun = await node.condition();
          if (!shouldRun) {
            this.statuses.set(node.operationId, 'skipped');
            this.onProgress?.(node.operationId, 'skipped');
            continue;
          }
        }
        toExecute.push(node);
      }

      // Execute batch with concurrency limit
      const batch = toExecute.slice(0, this.maxConcurrency);
      for (const node of batch) {
        this.statuses.set(node.operationId, 'in_progress');
        this.onProgress?.(node.operationId, 'in_progress');
      }

      const results = await Promise.allSettled(
        batch.map(async (node) => {
          try {
            await node.execute();
            this.statuses.set(node.operationId, 'complete');
            this.onProgress?.(node.operationId, 'complete');
          } catch (err) {
            this.statuses.set(node.operationId, 'failed');
            this.onProgress?.(node.operationId, 'failed');
            throw err;
          }
        })
      );

      // Check for blocking failures
      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length > 0) {
        // Check if any remaining operations can still proceed
        const remaining = nodes.filter(n => this.statuses.get(n.operationId) === 'not_started');
        const canContinue = remaining.some(n =>
          n.dependencies.every(dep => {
            const s = this.statuses.get(dep);
            return s === 'complete' || s === 'skipped';
          })
        );
        if (!canContinue) break; // Blocked
      }
    }

    return this.statuses;
  }
}
```

**The auto-generation chain graph** (from spec section 4.4 / 18.1):

```typescript
export function buildAutoGenerationGraph(
  /* operation factories */
): GraphNode[] {
  return [
    { operationId: 'op-2-1a', dependencies: [], execute: ... },
    { operationId: 'op-2-1b', dependencies: ['op-2-1a'], execute: ... },
    { operationId: 'op-2-1c', dependencies: ['op-2-1b'], execute: ... },
    { operationId: 'op-2-2a', dependencies: ['op-2-1c'], execute: ... },
    { operationId: 'op-2-2b', dependencies: ['op-2-1c'], execute: ... },
    { operationId: 'op-2-2c', dependencies: ['op-2-2a', 'op-2-2b'], execute: ... },
    { operationId: 'op-2-3a', dependencies: ['op-2-1c'], execute: ... },
    { operationId: 'op-2-3b', dependencies: ['op-2-3a'], execute: ... },
    { operationId: 'op-2-3c', dependencies: ['op-2-3b'], condition: () => /* 2.3b found issues */, execute: ... },
    { operationId: 'op-2-3d', dependencies: ['op-2-3a'], execute: ... }, // waits for 2.3c if it ran
    { operationId: 'op-2-4a', dependencies: ['op-2-2c', 'op-2-3d'], execute: ... },
    { operationId: 'op-2-4b', dependencies: ['op-2-3d'], execute: ... },
    { operationId: 'op-2-4c', dependencies: ['op-2-4a'], execute: ... },
    { operationId: 'op-2-4d', dependencies: ['op-2-4c'], execute: ... },
    { operationId: 'op-2-4e', dependencies: ['op-2-4a'], execute: ... },
    { operationId: 'op-2-5a', dependencies: ['op-2-4d'], execute: ... },
    { operationId: 'op-2-5b', dependencies: ['op-2-4d', 'op-2-2c'], execute: ... },
    { operationId: 'op-2-5c', dependencies: ['op-2-5b'], execute: ... },
    { operationId: 'op-2-5d', dependencies: ['op-2-5c'], execute: ... },
    { operationId: 'op-2-5e', dependencies: ['op-2-5d'], condition: () => /* 2.5d had failures */, execute: ... },
  ];
}
```

### 10.5 Verification Steps

1. **Session creation**: Creates session + phase-1 state + checkpoint 1
2. **Phase state machine**: `not_started → active` succeeds
3. **Phase state machine**: `active → complete` fails (must go through completing)
4. **Phase state machine**: `complete → active` fails (terminal)
5. **Operation routing**: Phase 1, no docs → `op-1-1`
6. **Operation routing**: Phase 1, has docs → `op-1-2`
7. **Operation routing**: Phase 2 → `op-2-7a`
8. **Chat blocking**: Set blocked → handleMessage rejects → unset → handleMessage succeeds
9. **DAG executor — linear**: A → B → C executes in order
10. **DAG executor — parallel**: A → (B, C) → D. B and C run simultaneously
11. **DAG executor — conditional skip**: A → B (condition false) → C. C still runs (B skipped)
12. **DAG executor — failure blocking**: A → B (fails) → C. C does not start
13. **DAG executor — partial failure**: A → (B fails, C succeeds) → D (depends on C). D runs.
14. **Auto-gen graph**: Build full graph, execute with mock operations, verify topological order

---

## 11. Sprint 5 — Phase 1 Complete

### 11.1 Goal

Phase 1 is fully functional end-to-end. The user can describe a product, iterate through conversation, see the Project Contract generated and updated in real-time, validate and complete Phase 1. **This is the first usable milestone.**

### 11.2 What Becomes Testable

- Type a product description → session created + title generated + Project Contract generated
- Send follow-up messages → contract updates, version increments
- Ambiguous message → AI asks clarifying question (no document update)
- Click "Confirm phase complete" with incomplete contract → FAIL with issues
- Fix issues and retry → PASS, phase transitions to complete
- Streaming visible: AI response types out word by word in chat
- Split view: 40% chat, 60% document panel showing rendered markdown
- Switch sessions: state restores
- Token usage displayed somewhere in the UI

### 11.3 Dependencies

Sprint 0-4 (all previous)

### 11.4 Detailed File Specifications

#### 11.4.1 Phase 1 Operations

**`src/core/operations/phase1/op-1-0-title.ts`**:

```typescript
export async function generateTitle(
  executor: OperationExecutor,
  userMessage: string
): Promise<string> {
  const result = await executor.execute({
    operationId: 'op-1-0',
    systemPrompt: phase1Prompts.sessionTitle(),
    messages: [{ role: 'user', content: userMessage }],
    expectedOutputFormat: 'plain_text',
    outputParser: (text) => {
      const cleaned = text.trim().replace(/['"]/g, '');
      const words = cleaned.split(/\s+/);
      if (words.length < 3 || words.length > 5) {
        return { success: false, error: `Title must be 3-5 words, got ${words.length}`, rawText: text };
      }
      return { success: true, data: cleaned, rawText: text };
    },
    maxRetries: 1,
    retryPrompt: 'Respond with ONLY a title between 3 and 5 words. Nothing else.',
    timeoutMs: 15000,
    model: 'claude-haiku-4-5',
  });

  if (result.status === 'success' && result.output) {
    return result.output.data;
  }
  // Fallback: truncate user message to first 5 words
  return userMessage.split(/\s+/).slice(0, 5).join(' ');
}
```

**`src/core/operations/phase1/op-1-1-goal-expansion.ts`**:

Uses the Two-AI Pattern.

```typescript
export async function executeGoalExpansion(
  executor: OperationExecutor,
  contextBuilder: ContextBuilder,
  storage: IStorage,
  sessionId: string,
  userMessage: string,
  sseWriter: SSEWriter
): Promise<{ visibleResponse: string; documentGenerated: boolean }> {
  // Build Call A context
  const callAContext = await contextBuilder.buildPhase1FirstMessage(userMessage);

  // Define Call A (conversational AI)
  const callADef: OperationDefinition = {
    operationId: 'op-1-1',
    systemPrompt: callAContext.systemPrompt,
    messages: callAContext.messages,
    expectedOutputFormat: 'structured',
    outputParser: extractGenerationContext,
    maxRetries: 1,
    retryPrompt: 'Please include a <generation_context> block with the complete product definition in YAML format.',
    timeoutMs: 60000,
    model: 'claude-opus-4-6',
    onStreamChunk: (chunk) => sseWriter.sendChunk(chunk), // Stream to UI
  };

  // Define Call B factory
  const callBFactory = (contextData: any): OperationDefinition => {
    const genContext = contextBuilder.buildDocumentGeneratorContextSync(contextData);
    return {
      operationId: 'op-1-1',
      systemPrompt: genContext.systemPrompt,
      messages: genContext.messages,
      expectedOutputFormat: 'markdown',
      outputParser: (text) => parseMarkdownSections(text, ['Goal Statement', 'Personas', 'Entity Map', 'Boundaries']),
      maxRetries: 1,
      retryPrompt: 'Produce a markdown document with exactly four sections: ## Goal Statement, ## Personas, ## Entity Map, ## Boundaries.',
      timeoutMs: 60000,
      model: 'claude-sonnet-4-6',
    };
  };

  // Execute Two-AI Pattern
  const result = await executeTwoAIPattern(
    executor,
    callADef,
    callBFactory,
    (output) => ({
      contextData: output.data.generationContextRaw,
      isClarifyingQuestion: output.data.isClarifyingQuestion,
    })
  );

  // Store user message
  await storage.addMessage({
    id: generateId(),
    sessionId,
    phaseId: 'phase-1',
    role: 'user',
    type: 'chat',
    content: userMessage,
    metadata: { screenReference: null, generationContext: null, operationId: 'op-1-1', stale: false },
    createdAt: now(),
  });

  // Store assistant response
  await storage.addMessage({
    id: generateId(),
    sessionId,
    phaseId: 'phase-1',
    role: 'assistant',
    type: 'chat',
    content: result.visibleResponse,
    metadata: {
      screenReference: null,
      generationContext: result.structuredData ? JSON.stringify(result.structuredData) : null,
      operationId: 'op-1-1',
      stale: false,
    },
    createdAt: now(),
  });

  // If document was generated, store it
  if (result.generatedDocument) {
    await storage.createDocument({
      id: generateId(),
      sessionId,
      phaseId: 'phase-1',
      type: 'project_contract',
      content: result.generatedDocument,
      structuredData: result.structuredData ? JSON.stringify(result.structuredData) : '',
      version: 0, // Will be auto-incremented by storage
      status: 'active',
      createdAt: now(),
      lastModifiedAt: now(),
    });

    sseWriter.sendDocument({
      type: 'project_contract',
      content: result.generatedDocument,
      version: 1,
    });
  }

  sseWriter.sendComplete();

  return {
    visibleResponse: result.visibleResponse,
    documentGenerated: !result.isClarifyingQuestion,
  };
}
```

**`src/core/operations/phase1/op-1-2-iteration.ts`**: Identical to 1.1 except uses `buildPhase1Iteration` (includes chat history) instead of `buildPhase1FirstMessage`. The generation_context is always a COMPLETE snapshot.

**`src/core/operations/phase1/op-1-3-validation.ts`**:

```typescript
export async function validatePhase1(
  executor: OperationExecutor,
  contextBuilder: ContextBuilder,
  sessionId: string
): Promise<{ status: 'PASS' | 'FAIL'; issues: string[]; suggestions: string[] }> {
  const context = await contextBuilder.buildPhase1Validation(sessionId);

  const result = await executor.execute({
    operationId: 'op-1-3',
    systemPrompt: context.systemPrompt,
    messages: context.messages,
    expectedOutputFormat: 'structured',
    outputParser: parseValidationResult,
    maxRetries: 1,
    retryPrompt: 'Respond in the exact format: STATUS: PASS or FAIL, then ISSUES: and SUGGESTIONS: sections.',
    timeoutMs: 30000,
    model: 'claude-sonnet-4-6',
  });

  if (result.status === 'failed') {
    throw new Error(`Validation call failed: ${result.error}`);
  }

  return result.output!.data;
}
```

#### 11.4.2 Phase 1 Prompts

**`src/core/prompts/phase1-prompts.ts`**:

Contains all 4 prompts from spec sections 17.1-17.4, exported as functions. These are copied verbatim from the reference document.

```typescript
export function sessionTitle(): string {
  return `Respond with ONLY a project title between 3 and 5 words. No punctuation, no quotes, no explanation, no formatting. Just the title.

Example input: "I want to build an app where people can track their daily water intake and get reminders"
Example output: Water Intake Tracker`;
}

export function phase1Conversational(): string {
  return `You are a product definition advisor helping a user define what they want to build. You are in Phase 1: Goal Definition.
// ... (full prompt from spec §17.2)
`;
}

export function projectContractGenerator(): string {
  return `You are a document generator. Produce a Project Contract in markdown with exactly four sections: Goal Statement, Personas, Entity Map, and Boundaries.
// ... (full prompt from spec §17.3)
`;
}

export function phase1Validation(): string {
  return `You are a product definition validator. Your job is to check whether a Project Contract is complete and internally consistent enough to move to the next phase of development.
// ... (full prompt from spec §17.4)
`;
}
```

#### 11.4.3 API Routes

**`src/app/api/chat/route.ts`**: The main chat endpoint. POST with `{ sessionId?, message, screenRef? }`. If no sessionId, creates a new session. Returns SSE stream.

**`src/app/api/session/route.ts`**: GET returns all sessions. POST creates a new session (alternative to first chat message).

**`src/app/api/phase/route.ts`**: POST with `{ sessionId }` triggers phase completion validation. Returns SSE stream with validation result.

#### 11.4.4 UI Components

Full specifications in [§27](#27-complete-ui-component-specifications).

Key components for Sprint 5:
- **AppShell**: Three-zone layout (sidebar 240px | chat 40% | document 60%)
- **SessionSidebar**: List of sessions sorted by updatedAt, "New Chat" button
- **PhaseIndicator**: Horizontal flow showing Phase 1 (active) → Phase 2 (locked)
- **ChatPanel**: Scrollable message list + ChatInput at bottom
- **ChatInput**: Text input + "Previous Phase" button (disabled in Phase 1) + "Done" button
- **DocumentPanel**: Renders markdown with react-markdown when document exists

#### 11.4.5 Zustand Stores

Full specifications in [§26](#26-complete-zustand-store-specifications).

### 11.5 Verification Steps

1. **New session flow**: Type "I want to build an e-commerce marketplace" → session appears in sidebar with title → chat shows AI response → document panel shows Project Contract with 4 sections
2. **Iteration**: Send "Add an admin persona who manages product listings" → contract updates with Admin persona → version increments to 2
3. **Clarifying question**: Send something ambiguous like "payments" → AI asks clarifying question → no document update
4. **Validation FAIL**: Click "Done" with a contract missing boundaries → "FAIL" with issues listed in chat
5. **Validation PASS**: Fix issues, click "Done" again → "PASS" → phase indicator shows Phase 1 complete
6. **Streaming**: Visible word-by-word response in chat
7. **Session switching**: Create second session → switch between them → state restores correctly
8. **Token display**: Some indicator of tokens/cost used

---

## 12. Sprint 6 — Auto-Generation Chain

This is the biggest and most complex sprint. After Phase 1 completes, the auto-generation chain runs ~30 operations to produce all Phase 2 artifacts.

### 12.1 Goal

The full auto-generation chain (Operations 2.1a through 2.5e) runs automatically when Phase 1 completes. Produces: Workflow Map document, Test Suite document, Screen Inventory document, HTML wireframe files (shell + screens + data), test harness, and executable test definitions.

### 12.2 What Becomes Testable

Everything listed in Sprint 6 of the earlier plan, plus the ability to view all generated documents and see the wireframe shell load in an iframe.

### 12.3 Implementation

Each operation file follows the same pattern: build context → execute via Operation Executor → parse output → store result → report progress.

**Batch operations (2.1b, 2.2a, 2.4c, 2.5b)** use a semaphore pattern:

```typescript
async function executeBatch<T>(
  items: T[],
  maxConcurrency: number,
  executor: (item: T) => Promise<void>
): Promise<{ succeeded: T[]; failed: { item: T; error: string }[] }> {
  const succeeded: T[] = [];
  const failed: { item: T; error: string }[] = [];
  const semaphore = new Semaphore(maxConcurrency);

  await Promise.allSettled(
    items.map(async (item) => {
      await semaphore.acquire();
      try {
        await executor(item);
        succeeded.push(item);
      } catch (err: any) {
        failed.push({ item, error: err.message });
      } finally {
        semaphore.release();
      }
    })
  );

  return { succeeded, failed };
}
```

**Wireframe file serving** via `src/app/api/wireframe/[sessionId]/[...path]/route.ts`:

```typescript
export async function GET(
  request: Request,
  { params }: { params: { sessionId: string; path: string[] } }
) {
  const { sessionId, path } = params;
  const filename = path.join('/');
  const manager = new WireframeManager('./data');

  try {
    const content = await manager.readFile(sessionId, filename);
    const contentType = manager.getContentType(filename);
    return new Response(content, {
      headers: { 'Content-Type': contentType },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
```

The full auto-generation chain graph from [§10.4.4](#1044-dependency-graph-executor) is wired up and executed.

### 12.4 Verification Steps

See Sprint 6 verification in the earlier plan section. Additionally:
- Verify the dependency graph executes operations in correct order
- Verify 2.2 and 2.3 run in parallel (both depend only on 2.1c)
- Verify 2.4 waits for both 2.2 and 2.3 to complete
- Verify batch operations handle partial failures

---

## 13. Sprint 7 — Drift Detection and Cascade Engine

### 13.1 Goal

Phase 2 user interaction: chat, drift detection, and cascade execution. The prototype becomes iteratively refinable.

### 13.2 Implementation

Three scope levels in the cascade router:

1. **`data_only`** (~1 AI call): Regenerate dummy data → rebuild data.js → mark tests stale
2. **`screen_only`** (~4-8 AI calls): Update screen inventory → diff → regen screens → re-translate tests → rebuild bundle → dry run
3. **`workflow_change`** (~9-21 AI calls): Full cascade — workflows → tests → screens → shell → test translation → bundle → dry run → document regeneration

The cascade executor creates a CascadeSnapshot before starting, enabling undo.

### 13.3 Verification Steps

See Sprint 7 verification in the earlier plan section.

---

## 14. Sprint 8 — Wireframe Viewer and Test Execution

### 14.1 Goal

Wireframe viewer fully functional in the browser. Test execution, diagnosis, and fix application.

### 14.2 Wireframe Communication Protocol

The wireframe shell (index.html) must fire BOTH `CustomEvent` AND `postMessage` for cross-frame communication:

```javascript
// In the wireframe shell's navigateTo function:
window.navigateTo = function(screenId) {
  // ... load screen HTML ...

  // Fire CustomEvent (for internal use by test harness)
  window.dispatchEvent(new CustomEvent('screenChanged', { detail: { screenId } }));

  // Fire postMessage (for communication with parent app)
  window.parent.postMessage({ type: 'screenChanged', screenId }, '*');
};
```

The parent app listens:
```typescript
// In WireframeViewer.tsx
useEffect(() => {
  const handler = (event: MessageEvent) => {
    if (event.data?.type === 'screenChanged') {
      setCurrentScreenId(event.data.screenId);
    }
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}, []);
```

### 14.3 Test Execution

**Server-side (Playwright)** for dry runs (2.5d) and automated execution:
```typescript
import { chromium } from 'playwright';

async function executeTestsDryRun(sessionId: string): Promise<TestRunResult> {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Load the test harness
  await page.goto(`http://localhost:3000/api/wireframe/${sessionId}/test-harness.html`);

  // Wait for iframe to load
  await page.waitForFunction(() => (window as any).runTests !== undefined);

  // Execute tests
  const results = await page.evaluate(async () => {
    return new Promise((resolve) => {
      window.addEventListener('testsComplete', (e: any) => resolve(e.detail));
      (window as any).runTests((window as any).TEST_DEFINITIONS);
    });
  });

  await browser.close();
  return formatResults(results);
}
```

### 14.4 Verification Steps

See Sprint 8 verification in the earlier plan section.

---

## 15. Sprint 9 — Rollback and Checkpoint System

### 15.1 Goal

Full rollback per spec section 14. Go back to Phase 1, edit contract, restore or regenerate Phase 2.

### 15.2 Contract Comparison Logic

Programmatic comparison, NOT AI:

```typescript
function hasContractChanged(
  oldStructuredData: string,
  newStructuredData: string
): boolean {
  const oldData = parseYaml(oldStructuredData);
  const newData = parseYaml(newStructuredData);

  // Compare persona names as sets
  const oldPersonas = new Set(oldData.personas?.map((p: any) => p.name) ?? []);
  const newPersonas = new Set(newData.personas?.map((p: any) => p.name) ?? []);
  if (!setsEqual(oldPersonas, newPersonas)) return true;

  // Compare entity names as sets
  const oldEntities = new Set(oldData.entities?.map((e: any) => e.name) ?? []);
  const newEntities = new Set(newData.entities?.map((e: any) => e.name) ?? []);
  if (!setsEqual(oldEntities, newEntities)) return true;

  // Compare boundary statements
  const oldBoundaries = new Set(oldData.boundaries ?? []);
  const newBoundaries = new Set(newData.boundaries ?? []);
  if (!setsEqual(oldBoundaries, newBoundaries)) return true;

  return false; // Cosmetic changes only
}
```

### 15.3 Verification Steps

See Sprint 9 verification in the earlier plan section.

---

## 16. Sprint 10 — Polish, Errors, Session Management

### 16.1 Goal

Production quality. Error handling, session resumability, downloads, Phase 2 validation.

### 16.2 Session Resumability

On server restart:
1. Load all sessions from disk
2. For active session, scan OperationProgress records
3. Find any `in_progress` operations
4. Determine resume point (last completed sub-operation in dependency graph)
5. Resume from next sub-operation

### 16.3 Phase 2 Validation (Operation 2.10)

Step 1 — Code-level checks:
| Check | Failure message |
|-------|-----------------|
| Test run exists | "Please run the test suite at least once before completing this phase." |
| Test run is recent (not stale) | "The wireframe has changed since tests were last run. Please run tests again." |
| All tests pass or known issues | "N tests are still failing." |
| HTML file for every screen | "Missing wireframe files detected." |
| Test defs for every workflow | "Missing test definitions detected." |

Step 2 — AI validation: Same pattern as Operation 1.3 but with Phase 2 prompt from spec §17.22.

---

## 17. Sprint 11 — End-to-End Testing and Hardening

### 17.1 Goal

Comprehensive testing and edge case hardening.

### 17.2 E2E Test Scenarios

1. **Happy path**: Describe product → iterate 2x → complete Phase 1 → auto-gen chain → view wireframe → run tests → all pass → complete Phase 2
2. **Iteration in Phase 2**: After auto-gen → request screen change → cascade runs → verify only affected screens changed
3. **Drift detection**: Request new entity → DRIFT → rollback → add entity to Phase 1 → re-enter Phase 2
4. **Test failure**: Run tests → failure → diagnose → fix → re-run → pass
5. **Session restore**: Mid-operation → restart server → resume

### 17.3 Parser Hardening

Test each parser with:
- Output wrapped in triple backtick code fences
- Output with preamble text before the actual data
- Output with extra/unexpected fields
- Output missing required fields
- Output with malformed YAML/JSON
- Empty output

---

## 18. Cross-Cutting: Streaming Architecture

### 18.1 Flow

```
Browser → POST /api/chat (request body: { sessionId, message })
                ↓
       API Route creates SSEWriter
                ↓
       Calls SessionManager.handleMessage(sessionId, message, sseWriter)
                ↓
       SessionManager routes to correct operation
                ↓
       Operation calls executor.execute({ ..., onStreamChunk: sseWriter.sendChunk })
                ↓
       Executor streams from Claude API → pipes chunks to sseWriter
                ↓
       sseWriter encodes as SSE events → ReadableStream → Response
                ↓
Browser ← Receives SSE events (EventSource or fetch + ReadableStream)
                ↓
       sse-client.ts dispatches events to Zustand stores
```

### 18.2 SSE Event Types

| Event | Data | Dispatched to Store |
|-------|------|---------------------|
| `chunk` | `{ text: string }` | `chatStore.appendToCurrentResponse(text)` |
| `document` | `{ type, content, version }` | `documentStore.setDocument(type, content)` |
| `phase` | `{ phaseId, status }` | `sessionStore.updatePhase(phaseId, status)` |
| `progress` | `{ operationId, status, detail? }` | `sessionStore.updateProgress(operationId, status)` |
| `test-results` | `{ results: TestRunResult }` | `wireframeStore.setTestResults(results)` |
| `drift` | `{ classification, reason }` | `chatStore.showDriftWarning(classification, reason)` |
| `error` | `{ error: string }` | `chatStore.showError(error)` |
| `complete` | `{}` | `chatStore.setBlocked(false)` |

### 18.3 Client-Side SSE Consumer

**`src/lib/sse-client.ts`**:

```typescript
export function streamChat(
  sessionId: string | undefined,
  message: string,
  screenRef: string | null,
  handlers: {
    onChunk: (text: string) => void;
    onDocument: (doc: any) => void;
    onPhase: (phase: any) => void;
    onProgress: (progress: any) => void;
    onDrift: (drift: any) => void;
    onError: (error: string) => void;
    onComplete: () => void;
  }
): AbortController {
  const controller = new AbortController();

  fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message, screenRef }),
    signal: controller.signal,
  }).then(async (response) => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          const eventType = line.slice(7);
          // Next line should be data
          continue;
        }
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          // Dispatch to appropriate handler based on last event type
          // ... handler dispatch logic
        }
      }
    }

    handlers.onComplete();
  }).catch((err) => {
    if (err.name !== 'AbortError') {
      handlers.onError(err.message);
    }
  });

  return controller;
}
```

---

## 19. Cross-Cutting: Prompt Management System

### 19.1 Structure

All 23 prompts centralized in `src/core/prompts/`:

| File | Operations | Prompt Count |
|------|-----------|--------------|
| `phase1-prompts.ts` | 1.0, 1.1 (conv), 1.1 (gen), 1.3 | 4 |
| `phase2-autogen-prompts.ts` | 2.1a, 2.1b, 2.1c, 2.2a, 2.2b, 2.2c, 2.3a, 2.3b, 2.3c, 2.3d, 2.4a, 2.4b, 2.4c, 2.5a, 2.5b, 2.5e | 16 |
| `phase2-interaction-prompts.ts` | 2.6, 2.7a (conv), 2.7c, 2.7d, 2.9, 2.10 | 6 |

Note: Some operations share prompts with minor variations. The reference document sections 17.1-17.26 contain the exact text for each. All are implemented verbatim.

### 19.2 Prompt Registry

```typescript
export class PromptRegistry {
  private prompts: Map<string, (...args: any[]) => string> = new Map();

  register(key: string, fn: (...args: any[]) => string): void {
    this.prompts.set(key, fn);
  }

  get(key: string, ...args: any[]): string {
    const fn = this.prompts.get(key);
    if (!fn) throw new Error(`Prompt not found: ${key}`);
    return fn(...args);
  }
}
```

---

## 20. Cross-Cutting: Error Handling at Every Level

### 20.1 Three Levels

1. **Transport level**: `pi-ai` handles provider-specific transient failures (429 rate limits, 5xx errors) for hosted providers; for local models we catch connection errors and surface them as a clear "local model unreachable" message. Configure `maxRetries: 2` in the pi-ai client options.

2. **Operation level**: When the LLM responds but the parser can't extract valid data. The executor retries once with a correction prompt that includes the parse error.

3. **Batch level**: When one item in a batch fails (e.g., one workflow out of 10), the failure is isolated. Other items continue. The user is notified of the specific failure with retry/skip options.

### 20.2 User-Facing Error Messages

| Error Type | Message | Recovery |
|-----------|---------|----------|
| Rate limited | "The AI service is busy. Your request will retry automatically." | SDK auto-retry |
| Auth error (401) | "API key is invalid. Please check your .env.local file." | User fixes .env.local |
| Parse failure (after retries) | "Failed to generate [artifact]. Please try again." | User retries |
| Timeout | "The operation took too long. Please try again." | User retries |
| Batch item failure | "[N-1] of [N] generated. 1 failed: [name]. [Retry] [Skip]" | Retry or skip |
| Cascade failure | "Update partially completed. [completed] succeeded, [failed] encountered an error." | Retry from failure or undo all |

### 20.3 Cascade Failure Handling

Before every cascade, create a CascadeSnapshot:
```typescript
const snapshot = await storage.createCascadeSnapshot({
  id: generateId(),
  sessionId,
  triggeredBy: userMessage,
  createdAt: now(),
  documentSnapshots: await snapshotDocuments(sessionId),
  artifactSnapshots: await snapshotArtifacts(sessionId),
  status: 'active',
});
```

On cascade failure:
- Stop at the failed operation
- Already-completed operations are valid (NOT rolled back automatically)
- Show user: "Retry from failure point" | "Undo all changes"
- "Undo" restores from CascadeSnapshot

---

## 21. Cross-Cutting: Dependency Graph Executor

Full specification in [§10.4.4](#1044-dependency-graph-executor).

The same `DependencyGraphExecutor` class is used for:
1. **Auto-generation chain** (Sprint 6): 20+ nodes, static graph from spec §18.1
2. **Iteration cascades** (Sprint 7): 5-15 nodes, dynamically built by the cascade router based on change scope

The cascade router builds a sub-graph at runtime:
```typescript
function buildCascadeGraph(scope: string, affectedIds: string[]): GraphNode[] {
  switch (scope) {
    case 'data_only':
      return [
        { operationId: 'regen-data', dependencies: [], execute: ... },
        { operationId: 'rebuild-datajs', dependencies: ['regen-data'], execute: ... },
      ];
    case 'screen_only':
      return [
        { operationId: 'update-inventory', dependencies: [], execute: ... },
        ...affectedIds.map(id => ({
          operationId: `regen-screen-${id}`, dependencies: ['update-inventory'], execute: ...
        })),
        // ... test retranslation, bundle, dry run
      ];
    case 'workflow_change':
      // Full cascade graph per spec §18.2
      return [...]; // 10-20 nodes
  }
}
```

---

## 22. Cross-Cutting: Token Budget Management

### 22.1 Budget Allocation

| Context Type | System Prompt | Input Data | Chat History | Total Target |
|-------------|--------------|-----------|-------------|-------------|
| Phase 1 | ~500 tok | (user message) | 4000 tok budget | <8K |
| Phase 2 conversational | ~500 tok | 3-8K tok (contract + state) | 4K tok | <16K |
| Document generators | ~300-500 tok | Varies (500-10K) | NONE | <12K |
| Batch items (workflow detail) | ~500 tok | 1-3K tok (contract + stub) | NONE | <4K |

### 22.2 Token Estimation

Fast approximation: `Math.ceil(text.length / 4)`.

For critical decisions (whether to summarize chat history), this is sufficient. The worst case is we summarize slightly too early, which is acceptable.

### 22.3 Large Product Handling

If all workflow YAMLs concatenated exceed 80% of the model's context window (~80K tokens for Sonnet):
- Operation 2.3a (Screen Extraction): Split by persona
- Extract screens for each persona's workflows separately
- Run a deduplication call to merge overlapping screens

For most products (10-20 workflows), this won't be necessary.

---

## 23. Cross-Cutting: Wireframe Iframe Security

### 23.1 Sandbox Configuration

```html
<iframe
  src="/api/wireframe/{sessionId}/index.html"
  sandbox="allow-scripts allow-same-origin"
  style="width: 100%; height: 100%; border: none;"
/>
```

- `allow-scripts` — Needed for JavaScript in wireframes (data rendering, navigation)
- `allow-same-origin` — Needed for data.js loading and iframe communication
- NO `allow-top-navigation` — Prevents wireframe from navigating the parent app
- NO `allow-popups` — Prevents wireframe from opening new windows

### 23.2 Content Security Policy

The wireframe API route sets CSP headers:
```typescript
headers: {
  'Content-Type': 'text/html',
  'Content-Security-Policy': "default-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:;",
}
```

This allows inline scripts and styles (needed for wireframes) but blocks external requests.

---

## 24. Cross-Cutting: Two-AI Pattern as Infrastructure

### 24.1 Pattern

Every user-facing operation uses two separate AI calls:

**Call A (Conversational AI):** User-facing, maintains dialogue context, understands intent, produces structured context block.

**Call B (Document Generator):** System-facing, never sees chat history, receives ONLY the context block from Call A, produces formatted output.

### 24.2 Where It's Used

| Operation | Call A Purpose | Call B Purpose |
|-----------|---------------|---------------|
| 1.1 Goal Expansion | Understand product idea, produce `<generation_context>` | Generate Project Contract markdown |
| 1.2 Iteration | Process change request, produce updated `<generation_context>` | Regenerate complete Project Contract |
| 2.7a Phase 2 Chat | Process change request, produce `<change_context>` | (Cascade replaces Call B) |

### 24.3 Implementation

The `executeTwoAIPattern` function in `src/core/operation-executor/two-ai-pattern.ts` handles the full orchestration. See [§8.4.6](#846-two-ai-pattern).

---

## 25. Complete API Route Specifications

### 25.1 POST /api/chat

**Request:**
```json
{
  "sessionId": "uuid or null (null creates new session)",
  "message": "user message text",
  "screenRef": "screen-id or null"
}
```

**Response:** SSE stream. Events: chunk, document, phase, progress, drift, error, complete.

### 25.2 GET /api/session

**Response:**
```json
{
  "sessions": [
    {
      "id": "uuid",
      "title": "E-Commerce Marketplace",
      "currentPhaseId": "phase-2",
      "status": "active",
      "updatedAt": "ISO timestamp"
    }
  ]
}
```

### 25.3 GET /api/session/[id]

**Response:** Full session state including phase states, document summaries, operation progress.

### 25.4 POST /api/phase

**Request:** `{ "sessionId": "uuid" }`

**Response:** SSE stream with validation result (PASS/FAIL + issues/suggestions).

### 25.5 POST /api/rollback

**Request:** `{ "sessionId": "uuid" }`

**Response:** SSE stream with rollback progress.

### 25.6 POST /api/drift

**Request:** `{ "sessionId": "uuid", "action": "continue" | "rollback" }`

**Response:** SSE stream. "continue" triggers cascade. "rollback" triggers rollback.

### 25.7 POST /api/tests

**Request:** `{ "sessionId": "uuid" }`

**Response:** SSE stream with test execution progress and results.

### 25.8 POST /api/tests/diagnose

**Request:** `{ "sessionId": "uuid", "testId": "test-uuid" }`

**Response:** JSON diagnosis result.

### 25.9 GET /api/wireframe/[sessionId]/[...path]

Serves static wireframe files with appropriate Content-Type headers.

---

## 26. Complete Zustand Store Specifications

### 26.1 Session Store

```typescript
interface SessionStore {
  // State
  sessions: Session[];
  activeSessionId: string | null;
  phases: Record<string, PhaseState>;
  operationProgress: Record<string, OperationProgress>;

  // Actions
  loadSessions: () => Promise<void>;
  setActiveSession: (id: string) => void;
  createSession: (message: string) => Promise<string>;
  updatePhase: (phaseId: string, status: PhaseStatus) => void;
  updateProgress: (operationId: string, status: OperationStatus) => void;
}
```

### 26.2 Chat Store

```typescript
interface ChatStore {
  // State
  messages: ChatMessage[];
  currentResponse: string; // Accumulating streamed response
  isBlocked: boolean;
  driftWarning: { classification: string; reason: string } | null;

  // Actions
  loadMessages: (sessionId: string, phaseId: string) => Promise<void>;
  addMessage: (message: ChatMessage) => void;
  appendToCurrentResponse: (text: string) => void;
  finalizeCurrentResponse: () => void;
  setBlocked: (blocked: boolean) => void;
  showDriftWarning: (classification: string, reason: string) => void;
  dismissDriftWarning: () => void;
  showError: (error: string) => void;
}
```

### 26.3 Document Store

```typescript
interface DocumentStore {
  // State
  documents: Record<DocumentType, Document | null>;
  activeDocumentType: DocumentType | null;
  isPanelOpen: boolean;

  // Actions
  loadDocuments: (sessionId: string) => Promise<void>;
  setDocument: (type: DocumentType, content: string, version: number) => void;
  setActiveDocument: (type: DocumentType) => void;
  openPanel: () => void;
  closePanel: () => void;
}
```

### 26.4 Wireframe Store

```typescript
interface WireframeStore {
  // State
  currentScreenId: string | null;
  isWireframeOpen: boolean;
  testResults: TestRunResult | null;
  isTestResultsStale: boolean;
  selectedFailedTest: IndividualTestResult | null;
  diagnosisResult: any | null;

  // Actions
  setCurrentScreenId: (id: string) => void;
  openWireframe: () => void;
  closeWireframe: () => void;
  setTestResults: (results: TestRunResult) => void;
  markTestResultsStale: () => void;
  selectFailedTest: (test: IndividualTestResult) => void;
  setDiagnosisResult: (result: any) => void;
  markAsKnownIssue: (testId: string) => void;
}
```

---

## 27. Complete UI Component Specifications

### 27.1 AppShell

Three-zone layout:
- **Left**: Session sidebar (fixed 240px width, collapsible)
- **Center**: Chat panel (fills remaining space, or 40% when document panel open)
- **Right**: Document panel (60% width, slides in from right)

Phase indicator spans the top of center + right zones.

### 27.2 ChatInput

States:
- **Normal**: Text input enabled, blue submit button
- **Blocked**: Input grayed out, shows "Processing..." or specific progress text
- **With screen reference**: Shows `[Viewing: screen-id]` badge above input

Buttons at bottom:
- "Previous Phase" (left) — disabled in Phase 1, enabled in Phase 2 when idle
- "Done" (right) — triggers phase completion, disabled during operations

### 27.3 DocumentPanel

Tabs at top for switching between document types. Content area renders markdown via react-markdown. When wireframe is selected, renders WireframeViewer instead of markdown.

### 27.4 DriftWarning

- **FLAG**: Yellow banner with warning icon, reason text, "Continue anyway" (blue) and "Go back to Phase 1" (gray) buttons
- **DRIFT**: Red banner with stop icon, reason text, "Go back to Phase 1" (primary) button only

---

## 28. Operation-to-Sprint Mapping

| Operation | Sprint | Type |
|-----------|--------|------|
| Op 1.0 Title | 5 | Utility AI call |
| Op 1.1 Goal Expansion | 5 | Two-AI Pattern |
| Op 1.2 Iteration | 5 | Two-AI Pattern |
| Op 1.3 Validation | 5 | Direct AI call |
| Op 2.1a Workflow Discovery | 6 | Direct AI call |
| Op 2.1b Workflow Detail | 6 | Batch AI call |
| Op 2.1c Workflow Formatting | 6 | Doc Generator AI |
| Op 2.2a Test Case Gen | 6 | Batch AI call |
| Op 2.2b Entity Coverage | 6 | Direct AI call |
| Op 2.2c Test Suite Formatting | 6 | Doc Generator AI |
| Op 2.3a Screen Extraction | 6 | Direct AI call |
| Op 2.3b Nav Validation | 6 | Direct AI call |
| Op 2.3c Screen Correction | 6 | Conditional AI call |
| Op 2.3d Screen Inventory Formatting | 6 | Doc Generator AI |
| Op 2.4a Dummy Data | 6 | Direct AI call |
| Op 2.4b Wireframe Shell | 6 | Direct AI call |
| Op 2.4c Screen HTML | 6 | Batch AI call |
| Op 2.4d Smoke Test | 6 | Code only |
| Op 2.4e Data File Assembly | 6 | Code only |
| Op 2.5a Test Harness | 6 | Direct AI call |
| Op 2.5b Test Translation | 6 | Batch AI call |
| Op 2.5c Test Bundle Assembly | 6 | Code only |
| Op 2.5d Test Dry Run | 6 | Code only (Playwright) |
| Op 2.5e Test Repair | 6 | Conditional AI call |
| Op 2.6 Drift Check | 7 | Direct AI call |
| Op 2.7a Conversational AI | 7 | Two-AI Pattern (Call A only) |
| Op 2.7b Cascade Router | 7 | Code only |
| Op 2.7c Targeted Screen Update | 7 | Direct AI call |
| Op 2.7d Targeted Workflow Update | 7 | Direct AI call |
| Op 2.8 Test Execution | 8 | Code (Playwright) |
| Op 2.9 Diagnosis | 8 | Direct AI call |
| Op 2.10 Phase 2 Validation | 10 | Code checks + AI call |

---

## 29. Risk Register and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| LLM output format unreliable | High | High | Robust parsers with code fence stripping, retry with correction, fallback to raw text |
| API rate limits during batch operations | Medium | Medium | Semaphore concurrency limit (3), SDK auto-retry on 429, exponential backoff |
| Context window exceeded for large products | Low | High | Token budget enforcement, split-by-persona strategy, summarization |
| Prompt caching not effective | Low | Medium | Monitor cache hit rates, adjust TTL, consider system prompt consolidation |
| Wireframe iframe security issues | Low | Medium | Strict sandbox, CSP headers, no allow-top-navigation |
| File-based storage corruption | Low | Medium | Atomic writes (tmp + rename), backup before cascade |
| Test dry run flaky in CI | Medium | Low | Retry mechanism, configurable delays, mark as known issue |
| Phase 2 cascade takes too long | Medium | Medium | Progress indicators, allow cancellation, optimize parallelism |
| Cost runaway on large products | Low | High | Token tracking per session, configurable cost alerts, model tiering |

---

## 30. Verification Checklist — Full System

### Phase 1 Flow
- [ ] Describe product → session created + title + Project Contract
- [ ] Iterate 3 times → contract updates each time
- [ ] Clarifying question → no document update
- [ ] Validate with incomplete contract → FAIL with issues
- [ ] Fix issues → validate → PASS

### Phase 2 Auto-Generation
- [ ] Phase 1 completes → auto-gen chain starts
- [ ] Progress visible in UI for each operation
- [ ] Workflow Map generated with all workflows
- [ ] Test Suite covers all workflows
- [ ] Screen Inventory lists all screens with navigation
- [ ] Wireframe loads in iframe
- [ ] All screens accessible via navigation
- [ ] Dummy data renders in screens
- [ ] Test harness and definitions generated
- [ ] Dry run passes (or repairs applied)
- [ ] Chat unblocked after completion

### Phase 2 Interaction
- [ ] Request data change → only data.js updates
- [ ] Request screen change → affected screens regenerate
- [ ] Request workflow change → full cascade runs
- [ ] Drift (new entity) → blocked with rollback option
- [ ] Flag (borderline) → user choice: continue or rollback
- [ ] Cascade failure → retry/undo options
- [ ] Test results marked stale after changes

### Test Execution
- [ ] Run tests → results displayed with pass/fail counts
- [ ] Click failed test → wireframe navigates to failure screen + detail panel
- [ ] Diagnose → WIREFRAME_BUG/TEST_BUG/WORKFLOW_FLAW
- [ ] Fix wireframe bug → screen regenerates
- [ ] Fix test bug → test repaired
- [ ] Fix workflow flaw → user approval → cascade
- [ ] Mark as known issue → excluded from blocking

### Rollback
- [ ] Click "Previous Phase" → Phase 2 suspended
- [ ] Phase 1 reopens with original history
- [ ] Edit contract (unchanged) → Phase 2 restored as-is
- [ ] Edit contract (changed) → Phase 2 regenerated from scratch
- [ ] Pending messages replayed after re-entry

### Error Handling
- [ ] Invalid API key → clear error message
- [ ] Rate limited → auto-retry (invisible to user)
- [ ] Parse failure → retry with correction → success
- [ ] Parse failure (persistent) → error message to user
- [ ] Batch item failure → isolated, rest continue
- [ ] Cascade failure → partial completion preserved, undo available
- [ ] Server restart → session state preserved, operations resume

### Performance
- [ ] Phase 1 response: <5 seconds
- [ ] Auto-gen chain (10 workflows, 8 screens): <5 minutes
- [ ] Small cascade (data_only): <10 seconds
- [ ] Large cascade (workflow_change): <2 minutes

---

## Estimated Effort and Critical Path

| Sprint | Focus | Effort | Cumulative |
|--------|-------|--------|------------|
| 0 | Project setup | 1-2 days | 1-2 days |
| 1 | Storage layer | 2-3 days | 3-5 days |
| 2 | Operation Executor | 3-4 days | 6-9 days |
| 3 | Context Builder | 2-3 days | 8-12 days |
| 4 | Session Manager | 3-4 days | 11-16 days |
| **5** | **Phase 1 complete (FIRST DEMO)** | **4-5 days** | **15-21 days** |
| 6 | Auto-generation chain | 7-10 days | 22-31 days |
| 7 | Drift + cascade | 5-7 days | 27-38 days |
| 8 | Wireframe + tests | 3-4 days | 30-42 days |
| 9 | Rollback/checkpoints | 3-4 days | 33-46 days |
| 10 | Polish + errors | 3-4 days | 36-50 days |
| 11 | E2E testing | 3-5 days | 39-55 days |

**Total: ~8-11 weeks for a solo developer.**
**First usable demo: Sprint 5 (~3 weeks).**
**Full system with wireframes: Sprint 8 (~6-7 weeks).**

**Critical path:** Sprint 0 → 1 → 2 → 3 → 4 → 5 (linear, each depends on previous). After Sprint 5, Sprints 6-8 are also linear. Sprints 9-11 can overlap with polish on earlier sprints.

# Prompts Catalog

Every LLM prompt in the system lives in this directory. The hand-off contract is:

- **Prompts** (here) are strings that the Prompt Registry surfaces by slug.
- **Context Builders** (in `@core/context-builder`) assemble the user-side messages + history.
- **Operations** (in `@core/operations`) pair a system prompt with a parser and a retry strategy.
- **Parsers** (in `@core/operation-executor/parsers.ts`) turn raw LLM output into structured data.

If you want to iterate on a prompt, you only need to touch one file here. Everything downstream keys on the slug.

## Files

| File | What it holds |
|---|---|
| `phase1-prompts.ts` | 4 prompts covering Op 1.0, Op 1.1, Op 1.2, Op 1.3 (Phase 1 from first message through validation). |
| `phase2-autogen-prompts.ts` | 22 prompts covering Phase 2 auto-generation (2.1a–2.5e), interaction (2.6, 2.7a, 2.7c, 2.7d, 2.9), and validation (2.10). |
| `prompt-registry.ts` | `PromptRegistry` class + `IPromptRegistry` interface. Looks up prompts by slug at runtime. |

Slugs are exported as frozen const objects: `PHASE1_PROMPT_SLUGS` and `PHASE2_PROMPT_SLUGS`. Use these everywhere instead of string literals.

## Phase 1 Catalog

| Op | Slug | Purpose | Input | Parser | Output shape |
|---|---|---|---|---|---|
| **1.0** | `phase1-session-title` | Generate a 3-5 word session title from the user's first message. Fire-and-forget during `createSession`. | First user message (as a single user turn). | `parsePlainText` | `{text: string}` |
| **1.1 / 1.2** | `phase1-conversational` | Phase 1 conversational AI (Call A of the Two-AI pattern). Produces a visible 1-2 sentence reply + a `<generation_context>` block with the complete product definition. Handles three modes: initial definition, targeted edit, question/chat. | User message + chat history (via ContextBuilder.buildPhase1Iteration, or just the first message for op-1-1). | `extractGenerationContext` | `{visibleResponse, generationContext, generationContextRaw, isClarifyingQuestion}` |
| **1.1 / 1.2** | `project-contract-generator` | Phase 1 document generator (Call B of the Two-AI pattern). Takes the YAML from `<generation_context>` and renders a markdown Project Contract with four fixed sections. | YAML from Call A (as a user turn). | `parseMarkdownSections(raw, ["Goal Statement", "Personas", "Entity Map", "Boundaries"])` | `{sections, fullMarkdown}` |
| **1.3** | `phase1-validation` | Validates the Project Contract for structural completeness and internal consistency. Returns PASS/FAIL + issues + suggestions. Gates the Phase 1 → Phase 2 transition. | The active Project Contract markdown. | `parseValidationResult` | `{status: "PASS"\|"FAIL", issues, warnings, suggestions}` |

## Phase 2 Auto-Generation Catalog (Ops 2.1–2.5)

These run as a DAG after Phase 1 completes. See `@core/session-manager/auto-generation-graph.ts` for the dependency topology.

| Op | Slug | Purpose | Parser |
|---|---|---|---|
| **2.1a** | `workflow-discovery` | Given the Project Contract, produce a YAML list of every workflow (every persona action + system-initiated flows) — one entry per workflow with id, persona, name, description, trigger, category. | `parseYAML` |
| **2.1b** | `workflow-detail` | For each workflow stub from 2.1a, produce the full workflow definition (pre-conditions, steps, exit criteria, edge cases). Batch op (one call per workflow, semaphore=3). | `parseYAML` |
| **2.1c** | `workflow-map-formatting` | Takes all detailed workflows and produces the Workflow Map markdown document. | `parsePlainText` |
| **2.2a** | `test-case-generation` | For each detailed workflow, produce test cases covering happy path, edge cases, and error paths. Batch. | `parsePlainText` |
| **2.2b** | `entity-coverage-check` | Ensures every entity in the contract is exercised by at least one test case. Emits any gaps. | `parseYAML` |
| **2.2c** | `test-suite-formatting` | Renders the Test Suite markdown document from the test case blocks + coverage analysis. | `parsePlainText` |
| **2.3a** | `screen-extraction` | From the Workflow Map, extract every screen the UI needs (with id, purpose, key data shown). | `parseYAML` |
| **2.3b** | `screen-navigation-validation` | Checks that the screen inventory's navigation graph is connected — every workflow can reach the screens it needs. Returns PASS or issues. | `parseYAML` |
| **2.3c** | `screen-inventory-correction` | **Conditional** — only runs when 2.3b reported issues. Applies fixes to the screen inventory. | `parsePlainText` |
| **2.3d** | `screen-inventory-formatting` | Renders the Screen Inventory markdown document. | `parsePlainText` |
| **2.4a** | `dummy-data-generation` | Creates realistic dummy data (JSON) for every entity, so wireframes can render content. | `parseJSON` |
| **2.4b** | `wireframe-shell` | Generates the top-level `index.html` that holds the navigation and screen-switching logic. | `parsePlainText` (raw HTML) |
| **2.4c** | `screen-html-generation` | For each screen in the inventory, generates the HTML that renders it from the dummy data. Batch. | `parsePlainText` (raw HTML) |
| **2.4d** | *(no prompt — code-only smoke test)* | Verifies every screen ID in the inventory has a matching `.html` file and every nav link points somewhere. | n/a |
| **2.4e** | *(no prompt — code-only)* | Assembles `data.js` by stringifying the dummy-data JSON into `window.DATA = {...}`. | n/a |
| **2.5a** | `test-harness` | Generates the HTML harness that loads wireframe screens in an iframe and exposes hooks for test definitions. | `parsePlainText` (raw HTML) |
| **2.5b** | `test-translation` | For each test case, produces an executable test definition (click selectors, expected values). Batch. | `parsePlainText` |
| **2.5c** | *(no prompt — code-only)* | Assembles `tests.js` from all translated test definitions. | n/a |
| **2.5d** | *(no prompt — code-only dry run)* | Runs the generated tests once against the harness to detect broken selectors. | n/a |
| **2.5e** | `test-repair` | **Conditional** — only runs when 2.5d detected failures. Applies minimal test fixes. | `parsePlainText` |

## Phase 2 Interaction Catalog (Ops 2.6, 2.7, 2.9)

Triggered when the user sends a message after auto-gen completes.

| Op | Slug | Purpose | Parser |
|---|---|---|---|
| **2.6** | `drift-check` | Classifies a proposed change as COMPATIBLE (proceed), FLAG (warn user), or DRIFT (block + require rollback). Compares against the locked Phase 1 contract. | `parseDriftResult` |
| **2.7a** | `phase2-conversational` | Phase 2 chat AI. Same shape as Phase 1 but emits `<change_context>` instead of `<generation_context>`. The change_context has `scope` (data_only / screen_only / workflow_change) and `description` fields that drive the cascade router. | `extractChangeContext` |
| **2.7b** | *(no prompt — code-only router)* | Maps scope → which operations the CascadeExecutor should run. | n/a |
| **2.7c** | `targeted-screen-update` | When scope is `screen_only`, regenerates only the affected screen HTML. | `parsePlainText` |
| **2.7d** | `targeted-workflow-update` | When scope is `workflow_change`, partially re-runs the auto-gen chain (workflow + dependent screens + tests). | `parsePlainText` |
| **2.9** | `test-failure-diagnosis` | Given a failed test, classifies root cause as WIREFRAME_BUG / TEST_BUG / WORKFLOW_FLAW + proposes a fix. | `parseDiagnosisResult` |

## Phase 2 Completion

| Op | Slug | Purpose | Parser |
|---|---|---|---|
| **2.10 (Step 1)** | *(no prompt — code checks)* | Verifies test run recency, pass rate, file coverage. See `op-2-10-validation.ts:runCodeChecks`. | n/a |
| **2.10 (Step 2)** | `phase2-validation` | AI cross-references all Phase 2 artifacts (contract, workflows, tests, screens, wireframe files, test results) for completeness + consistency. Returns PASS/FAIL + issues + suggestions + warnings. | `parseValidationResult` |

## How to iterate on a prompt

1. **Identify the slug.** Look up the operation in the tables above. Grep the codebase for the slug to see every call site.
2. **Edit the function body.** All prompts are plain string-returning functions. Changing the return value is the only change needed.
3. **Test locally.** `npm test` won't catch prompt-quality regressions — most prompt tests use recorded fixtures or mocked executors. Run through the manual walkthrough in `C:\Users\samarth\.claude\plans\iterative-swimming-rabbit.md`.
4. **Watch the parser.** If you change the output shape, the parser will probably fail. Check the parser column in the tables and either update the parser's regex / YAML expectations or keep the output shape backward-compatible.
5. **Retry-prompt sanity.** Many operations have a `retryPrompt` in their OperationDefinition (search for `retryPrompt` in `@core/operations/`). If you change the format, update the retry hint too.

## Known prompt-quality issues

Tracked here so we don't rediscover them on every QA pass:

- **Op 2.1a over-generation.** For anything more complex than a 1-persona app, workflow discovery can emit 20+ workflows, which cascades into 20+ 2.1b calls — each one ~5-10s on Groq — producing 2-4 minute auto-gen runs for toy apps. Worth a "cap at 15 core workflows" instruction.
- **Op 2.1b flakiness.** Detail-per-workflow calls sometimes all fail as a batch (rate limiting, context window, or parse errors). Consider smaller concurrency (currently 3) or a simpler YAML output format.
- **Phase 1 iteration surgicality.** Even with the rewritten prompt (Mode 2 language), the LLM sometimes "cleans up" existing persona descriptions while applying a targeted edit. Hard to fully prevent without a diff-based post-check.

## Shell snippets for local debugging

```bash
# List every prompt function
rg '^export function \w+Prompt' app/src/core/prompts/

# Find every call site that uses a given slug
rg 'PHASE1_PROMPT_SLUGS\.phase1Conversational|"phase1-conversational"' app/src/

# Print the current Phase 1 conversational prompt (for pasting into a Groq playground)
node -e 'console.log(require("./app/src/core/prompts/phase1-prompts").phase1ConversationalPrompt())'
```

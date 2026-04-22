import type { IPromptRegistry } from "./prompt-registry";

// Prompt bodies for every Phase 2 auto-generation operation.
// Copied verbatim from spec §17.5-§17.21. Changing any of these
// changes the product's behavior — treat them like config, not code.
//
// See ./README.md for the full catalog — which op uses which prompt,
// expected input/output, and the parser each one pairs with.

export const PHASE2_PROMPT_SLUGS = {
  workflowDiscovery: "workflow-discovery",
  workflowDetail: "workflow-detail",
  workflowMapFormatting: "workflow-map-formatting",
  testCaseGeneration: "test-case-generation",
  entityCoverageCheck: "entity-coverage-check",
  testSuiteFormatting: "test-suite-formatting",
  screenExtraction: "screen-extraction",
  screenNavValidation: "screen-navigation-validation",
  screenCorrection: "screen-inventory-correction",
  screenInventoryFormatting: "screen-inventory-formatting",
  dummyDataGeneration: "dummy-data-generation",
  wireframeShell: "wireframe-shell",
  screenHtmlGeneration: "screen-html-generation",
  testHarness: "test-harness",
  testTranslation: "test-translation",
  testRepair: "test-repair",
  // Phase 2 interaction prompts (Sprint 7)
  phase2Conversational: "phase2-conversational",
  driftCheck: "drift-check",
  targetedScreenUpdate: "targeted-screen-update",
  targetedWorkflowUpdate: "targeted-workflow-update",
  diagnosis: "test-failure-diagnosis",
  // Phase 2 completion validation (Sprint 10)
  phase2Validation: "phase2-validation",
} as const;

/**
 * Op 2.1a — Workflow Discovery. Slug: `workflow-discovery`.
 *
 * Reads the Project Contract and emits a YAML list of every workflow
 * (one per persona action + system-initiated flows). Parser: `parseYAML`.
 *
 * **Watch-out:** for non-trivial contracts this can easily generate 20+
 * workflows, which causes Op 2.1b to run 20+ batched LLM calls and turns
 * auto-gen into a 5-10 minute ordeal. Consider capping at ~15 core
 * workflows in the prompt body if this becomes a pain point. Spec §17.5.
 */
export function workflowDiscoveryPrompt(): string {
  return `You are a product workflow analyst. Given a Project Contract, identify every distinct workflow that exists in the product.

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
    category: [one of: core, supporting, edge-case, system]`;
}

/**
 * Op 2.1b — Workflow Detail. Slug: `workflow-detail`.
 *
 * For each workflow stub from 2.1a, produces the full definition
 * (pre-conditions, steps, exit criteria, edge cases). Runs in batch
 * with semaphore=3 concurrency. Parser: `parseYAML`. Spec §17.6.
 */
export function workflowDetailPrompt(): string {
  return `You are a product workflow designer. You will be given a product description and a specific workflow to detail.

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
- Rate limits or resource constraints`;
}

/**
 * Op 2.1c — Workflow Map Formatting. Slug: `workflow-map-formatting`.
 *
 * Renders the Workflow Map markdown document from all detailed workflows.
 * Parser: `parsePlainText`. Spec §17.7.
 */
export function workflowMapFormattingPrompt(): string {
  return `You are a document formatter. Convert the structured workflow data below into a clean, readable markdown document.

Format:

# Workflow Map

## Summary
[Table listing all workflows: ID, Persona, Name, Category]

## [Persona Name] Workflows

### [Workflow Name]
**Trigger:** [what starts it]
**Category:** [core/supporting/edge-case/system]

**Happy Path:**
1. [Actor] -> [Action]. System: [Response]. Screen: [Screen name]
2. ...

**Outcome:** [end state]

**Edge Cases:**

**[Edge case condition]** (branches from step [N])
1. [Actor] -> [Action]. System: [Response]. Screen: [Screen name]
Outcome: [resolution]

---

Repeat for each workflow, grouped by persona. System workflows go in their own section at the end.`;
}

/**
 * Op 2.2a — Test Case Generation. Slug: `test-case-generation`.
 *
 * For each detailed workflow, produces test cases covering happy path,
 * edge cases, and error paths. Runs in batch. Parser: `parsePlainText`.
 * Spec §17.8.
 */
export function testCaseGenerationPrompt(): string {
  return `You are a test case writer. Given a product description and a single workflow definition, produce test cases that fully cover the workflow.

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
- For non-UI steps (background jobs, emails, webhooks), assertions check system state, not screen content.`;
}

/**
 * Op 2.2b — Entity Coverage Check. Slug: `entity-coverage-check`.
 *
 * Ensures every entity in the Project Contract is exercised by at least
 * one test case. Emits any coverage gaps. Parser: `parseYAML`. Spec §17.9.
 */
export function entityCoverageCheckPrompt(): string {
  return `You are a coverage analyst. Compare the entity list from the Project Contract against the workflows in the Workflow Map.

For each entity in the Project Contract, determine:
- Is it referenced in at least one workflow? If yes, which workflows?
- If no, flag it as unused.

Respond in this format:

coverage:
  - entity: [entity name]
    status: [used or unused]
    referenced_in: [list of workflow IDs, or empty if unused]

unused_entities:
  - [entity name]: [suggestion — should this entity be removed from the contract, or is a workflow missing?]`;
}

/**
 * Op 2.2c — Test Suite Formatting. Slug: `test-suite-formatting`.
 *
 * Renders the Test Suite markdown document from the test case blocks +
 * coverage analysis. Parser: `parsePlainText`. Spec §17.10.
 */
export function testSuiteFormattingPrompt(): string {
  return `You are a document formatter. Convert the structured test case data below into a clean, readable markdown document.

Format:

# Test Suite

## Coverage Summary
[Total test cases, broken down by workflow. Also include entity coverage status.]

## [Persona Name] Workflow Tests

### [Workflow Name] Tests

#### Happy Path: [Test name]
**Given:** [starting state]
**When:**
1. [Actor] -> [action] on [screen]
2. ...
**Then:**
- [assertion 1] on [screen]
- [assertion 2] on [screen]

#### Edge Case: [Edge case condition]
**Given:** [starting state]
**When:**
1. [Actor] -> [action] on [screen]
2. ...
**Then:**
- [assertion 1] on [screen]
- [assertion 2] on [screen]

---

Group tests by persona, then by workflow. System workflow tests at the end.
If there are unused entities, add a section: "## Entity Coverage Flags" listing them with suggestions.`;
}

/**
 * Op 2.3a — Screen Extraction. Slug: `screen-extraction`.
 *
 * From the Workflow Map, extracts every screen the UI needs (id, purpose,
 * key data shown, outgoing navigation). Parser: `parseYAML`. Spec §17.12.
 */
export function screenExtractionPrompt(): string {
  return `You are a UX analyst. Given a set of workflows, extract every distinct screen that the application needs.

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
    entry_point: [true or false]`;
}

/**
 * Op 2.3b — Screen Navigation Validation. Slug: `screen-navigation-validation`.
 *
 * Checks that the screen inventory's navigation graph is connected — every
 * workflow can reach the screens it needs. Returns PASS or an `issues` list.
 * The conditional Op 2.3c only runs if this emits issues. Parser: `parseYAML`.
 * Spec §17.13.
 */
export function screenNavValidationPrompt(): string {
  return `You are a UX consistency checker. Given a set of screens with their actions and navigation links, check for:

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
    suggested_fix: [what to add or change]`;
}

/**
 * Op 2.3c — Screen Inventory Correction (conditional). Slug: `screen-inventory-correction`.
 *
 * Only runs when 2.3b reported issues. Applies navigation fixes to the
 * screen inventory. Parser: `parsePlainText`. Spec §17.14.
 */
export function screenCorrectionPrompt(): string {
  return `You are a UX analyst. You previously generated a screen inventory that had some issues. Apply the fixes below and produce the corrected screen inventory in the same YAML format.

Only change what the fixes require. Do not alter screens that have no issues.`;
}

/**
 * Op 2.3d — Screen Inventory Formatting. Slug: `screen-inventory-formatting`.
 *
 * Renders the Screen Inventory markdown document. Parser: `parsePlainText`.
 * Spec §17.15.
 */
export function screenInventoryFormattingPrompt(): string {
  return `You are a document formatter. Convert the structured screen inventory data below into a clean, readable markdown document.

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
- [action] -> navigates to [Screen Name]
- [action] -> stays on this screen

---

Repeat for each screen. Group UI screens first, System Info screens at the end in their own section.`;
}

/**
 * Op 2.4a — Dummy Data Generation. Slug: `dummy-data-generation`.
 *
 * Produces realistic placeholder data (JSON) for every entity in the
 * Project Contract, so wireframes can render content instead of
 * lorem-ipsum. Parser: `parseJSON`. Spec §17.16.
 */
export function dummyDataGenerationPrompt(): string {
  return `You are a test data generator. Given a product's entity map and workflows, produce a set of realistic dummy data that can be used to populate a wireframe prototype.

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
}`;
}

/**
 * Op 2.4b — Wireframe Shell. Slug: `wireframe-shell`.
 *
 * Generates the top-level `index.html` that holds navigation and
 * screen-switching logic. Parser: `parsePlainText` (raw HTML). Spec §17.17.
 */
export function wireframeShellPrompt(): string {
  return `You are a wireframe developer. Generate an index.html file that serves as the shell for a clickable wireframe prototype.

Requirements:
- Load individual screen HTML files into a main content area (via iframe or dynamic content loading)
- Display the current screen name and screen ID prominently at the top
- Provide a navigation sidebar listing all screens grouped by type:
  - UI screens first
  - Divider
  - System Info screens at the bottom (labeled "System Processes")
- Clicking a screen name in the sidebar loads that screen
- Expose JavaScript function: window.getCurrentScreenId() -> returns current screen ID as string
- Expose JavaScript function: window.navigateTo(screenId) -> navigates to that screen
- Fire CustomEvent 'screenChanged' on window when navigation occurs, with detail: { screenId: string }
- Style: minimal wireframe aesthetic. Background: #f5f5f5. Borders: #333. Font: sans-serif. Interactive elements: #2563eb (blue).
- System Info screens in sidebar should have amber indicator
- Highlight currently active screen in sidebar

The shell must work with the following screens:
[list of screen IDs, names, and types]

The entry point screen is: [entry point screen ID]

No external dependencies. Plain HTML, CSS, JavaScript only.`;
}

/**
 * Op 2.4c — Screen HTML Generation. Slug: `screen-html-generation`.
 *
 * For each screen in the inventory, generates the HTML that renders it
 * from the dummy data. Batch op. Parser: `parsePlainText` (raw HTML).
 * Spec §17.18.
 */
export function screenHtmlGenerationPrompt(): string {
  return `You are a wireframe developer. Generate a single HTML file for one screen of a clickable wireframe prototype.

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
- For EACH action available on this screen, there MUST be a visible interactive element (button, link, or clickable area).`;
}

/**
 * Op 2.5a — Test Harness. Slug: `test-harness`.
 *
 * Generates `test-harness.html` that loads wireframe screens in an iframe
 * and exposes hooks for the translated test definitions to drive.
 * Parser: `parsePlainText` (raw HTML). Spec §17.19.
 */
export function testHarnessPrompt(): string {
  return `You are a test automation developer. Generate a test harness HTML file that can execute automated tests against a wireframe prototype.

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

No external dependencies. Plain HTML, CSS, JavaScript.`;
}

/**
 * Op 2.5b — Test Translation. Slug: `test-translation`.
 *
 * For each test case, produces an executable test definition (click
 * selectors, expected values) that the harness can run against the
 * wireframe. Batch op. Parser: `parsePlainText`. Spec §17.20.
 */
export function testTranslationPrompt(): string {
  return `You are a test automation developer. Convert human-readable test cases into executable test definitions that the test harness can run.

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
        [step params]`;
}

/**
 * Op 2.5e — Test Repair (conditional). Slug: `test-repair`.
 *
 * Only runs when the code-only dry run (Op 2.5d) detected broken test
 * selectors. Applies minimal fixes. Parser: `parsePlainText`. Spec §17.21.
 */
export function testRepairPrompt(): string {
  return `You are a test automation developer fixing a broken test. The test was generated but failed during execution.

You will be given:
1. The test definition with all steps
2. Which step failed and the error message
3. The HTML source of the screen where the failure occurred

Common issues:
- CSS selector doesn't match any element — read the HTML and find the correct selector
- Navigation to a screen ID that doesn't exist — check the screen inventory for the correct ID
- Text assertion doesn't match — check the actual text in the HTML or the dummy data

Produce the COMPLETE fixed test definition (all steps, not just the fixed one).`;
}

// ── Phase 2 Interaction Prompts (Sprint 7) ─────────────────────

/**
 * Op 2.7a — Phase 2 Conversational AI. Slug: `phase2-conversational`.
 *
 * Phase 2 chat handler. Same shape as Phase 1 conversational but emits
 * `<change_context>` instead of `<generation_context>`. The change_context
 * has `scope` (data_only / screen_only / workflow_change) and
 * `description` fields that drive the CascadeRouter. Parser:
 * `extractChangeContext`. Spec §17.26.
 */
export function phase2ConversationalPrompt(): string {
  return `You are a product prototype advisor helping a user refine their wireframe prototype. You are in Phase 2: Workflow and UX Definition.

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

Only ask a clarifying question if the request is genuinely ambiguous. Default to your best inference.`;
}

/**
 * Op 2.6 — Drift Check. Slug: `drift-check`.
 *
 * Classifies a proposed Phase 2 change against the locked Phase 1 contract.
 * Returns COMPATIBLE (proceed), FLAG (warn user, user chooses), or DRIFT
 * (block + require rollback). Parser: `parseDriftResult`. Spec §17.11.
 */
export function driftCheckPrompt(): string {
  return `You are a scope drift detector. You will receive a structured description of a proposed change to a product prototype, along with the locked project definition from a previous phase.

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
reason: [one sentence explaining your classification]`;
}

/**
 * Op 2.7c — Targeted Screen Update. Slug: `targeted-screen-update`.
 *
 * When the cascade router chose `screen_only` scope, this regenerates
 * only the affected screen HTML. Parser: `parsePlainText`. Spec §17.23.
 */
export function targetedScreenUpdatePrompt(): string {
  return `You are a UX analyst updating a screen inventory. Apply ONLY the specified changes. Do not modify unaffected screens.

If a new screen is needed, assign an ID following the existing naming convention.
If a screen is removed, note which workflows need screen reference updates.
If a screen is modified, update only the changed fields.

Produce the COMPLETE updated screen inventory in the same YAML format — including unchanged screens.`;
}

/**
 * Op 2.7d — Targeted Workflow Update. Slug: `targeted-workflow-update`.
 *
 * When the cascade router chose `workflow_change` scope, this partially
 * re-runs the auto-gen chain (workflow + dependent screens + tests).
 * Parser: `parsePlainText`. Spec §17.24.
 */
export function targetedWorkflowUpdatePrompt(): string {
  return `You are a product workflow designer updating an existing workflow. Apply the specified change while maintaining consistency.

If adding steps, ensure they connect logically to existing steps.
If removing steps, ensure the remaining flow still makes sense.
If modifying steps, update edge cases that branch from the modified step if affected.

Produce the COMPLETE updated workflow definition in the same YAML format — including unchanged steps.`;
}

/**
 * Op 2.9 — Test Failure Diagnosis. Slug: `test-failure-diagnosis`.
 *
 * Given a failed test, classifies root cause as WIREFRAME_BUG, TEST_BUG,
 * or WORKFLOW_FLAW + proposes a fix. Parser: `parseDiagnosisResult`.
 * Spec §17.25.
 */
export function diagnosisPrompt(): string {
  return `You are a test failure diagnostician. A test was run against a wireframe prototype and failed. Determine the root cause.

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
confidence: [high or medium or low]`;
}

/**
 * Op 2.10 (Step 2) — Phase 2 Validation. Slug: `phase2-validation`.
 *
 * AI step of Phase 2 completion validation. Cross-references contract,
 * workflows, tests, screens, wireframe files, and test results for
 * completeness + consistency. Returns PASS/FAIL + issues + suggestions +
 * warnings. Only runs if code-level checks (Step 1 in
 * `op-2-10-validation.ts`) pass. Parser: `parseValidationResult`.
 * Spec §17.22.
 */
export function phase2ValidationPrompt(): string {
  return `You are a product completeness validator for Phase 2 (artifact generation). Your job is to check whether the generated artifacts are complete, consistent, and ready for handoff.

You will receive:
1. The locked Project Contract (personas, entities, boundaries)
2. The Workflow Map (all workflows with steps)
3. The Test Suite (test cases per workflow)
4. The Screen Inventory (all screens with navigation)
5. A list of wireframe files that exist
6. The latest test run results (if any)

Check for:
- Every workflow in the Workflow Map has at least one test case in the Test Suite
- Every screen referenced in workflows exists in the Screen Inventory
- Every screen in the Screen Inventory has a corresponding wireframe HTML file
- Navigation paths in the Screen Inventory form a connected graph (no orphan screens)
- All personas from the Project Contract are represented in at least one workflow
- All entities from the Project Contract appear in at least one screen
- Test coverage: every workflow has test cases that cover the happy path at minimum

Respond in this exact format:

STATUS: PASS (or FAIL)

ISSUES:
- [list each problem found, one per line]

WARNINGS:
- [list non-blocking concerns, one per line]

SUGGESTIONS:
- [list improvement ideas, one per line]

If there are no items for a section, write "None" on the next line.`;
}

// Seed a PromptRegistry with all Phase 2 prompts.
export function registerPhase2Prompts(registry: IPromptRegistry): void {
  registry.register(PHASE2_PROMPT_SLUGS.workflowDiscovery, workflowDiscoveryPrompt());
  registry.register(PHASE2_PROMPT_SLUGS.workflowDetail, workflowDetailPrompt());
  registry.register(PHASE2_PROMPT_SLUGS.workflowMapFormatting, workflowMapFormattingPrompt());
  registry.register(PHASE2_PROMPT_SLUGS.testCaseGeneration, testCaseGenerationPrompt());
  registry.register(PHASE2_PROMPT_SLUGS.entityCoverageCheck, entityCoverageCheckPrompt());
  registry.register(PHASE2_PROMPT_SLUGS.testSuiteFormatting, testSuiteFormattingPrompt());
  registry.register(PHASE2_PROMPT_SLUGS.screenExtraction, screenExtractionPrompt());
  registry.register(PHASE2_PROMPT_SLUGS.screenNavValidation, screenNavValidationPrompt());
  registry.register(PHASE2_PROMPT_SLUGS.screenCorrection, screenCorrectionPrompt());
  registry.register(PHASE2_PROMPT_SLUGS.screenInventoryFormatting, screenInventoryFormattingPrompt());
  registry.register(PHASE2_PROMPT_SLUGS.dummyDataGeneration, dummyDataGenerationPrompt());
  registry.register(PHASE2_PROMPT_SLUGS.wireframeShell, wireframeShellPrompt());
  registry.register(PHASE2_PROMPT_SLUGS.screenHtmlGeneration, screenHtmlGenerationPrompt());
  registry.register(PHASE2_PROMPT_SLUGS.testHarness, testHarnessPrompt());
  registry.register(PHASE2_PROMPT_SLUGS.testTranslation, testTranslationPrompt());
  registry.register(PHASE2_PROMPT_SLUGS.testRepair, testRepairPrompt());
  // Phase 2 interaction (Sprint 7)
  registry.register(PHASE2_PROMPT_SLUGS.phase2Conversational, phase2ConversationalPrompt());
  registry.register(PHASE2_PROMPT_SLUGS.driftCheck, driftCheckPrompt());
  registry.register(PHASE2_PROMPT_SLUGS.targetedScreenUpdate, targetedScreenUpdatePrompt());
  registry.register(PHASE2_PROMPT_SLUGS.targetedWorkflowUpdate, targetedWorkflowUpdatePrompt());
  registry.register(PHASE2_PROMPT_SLUGS.diagnosis, diagnosisPrompt());
  // Phase 2 completion validation (Sprint 10)
  registry.register(PHASE2_PROMPT_SLUGS.phase2Validation, phase2ValidationPrompt());
}

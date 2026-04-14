import { ContextBuilder, Summarizer } from "@core/context-builder";
import { OperationExecutor } from "@core/operation-executor";
import { PromptRegistry, registerPhase1Prompts } from "@core/prompts";
import type { Phase1HandlerDeps } from "@core/session-manager";
import { Phase1HandlersImpl } from "@core/session-manager";
import { MemoryStorage } from "@core/storage";
import type {
  OperationDefinition,
  OperationResult,
  ParseResult,
} from "@core/types";

// Deterministic executor driven by a queue of response strings. Each
// call pulls the next string, runs it through the op's real parser, and
// returns a wired-up OperationResult. This lets tests exercise the
// Two-AI pattern, the validation parser, and the title parser end-to-end
// using synthetic LLM outputs without touching a real model.

export interface QueuedResponse {
  rawText: string;
  // Optional override so tests can force a specific status code path.
  // When absent, the executor runs the op's outputParser to decide
  // success vs. failure (mirroring real behavior).
  forceFailWith?: string;
}

export class QueueExecutor extends OperationExecutor {
  public callCount = 0;
  public readonly definitions: OperationDefinition<unknown>[] = [];

  constructor(private readonly responses: QueuedResponse[]) {
    super();
  }

  async execute<T>(
    definition: OperationDefinition<T>,
  ): Promise<OperationResult<T>> {
    const idx = this.callCount;
    this.callCount += 1;
    this.definitions.push(definition as OperationDefinition<unknown>);

    const queued = this.responses[idx];
    if (!queued) {
      throw new Error(
        `QueueExecutor: no response queued for call ${idx + 1} (op ${definition.operationId})`,
      );
    }

    if (queued.forceFailWith) {
      return {
        operationId: definition.operationId,
        status: "failed",
        output: null,
        error: queued.forceFailWith,
        tokenUsage: { input: 10, output: 0 },
        cost: 0,
        durationMs: 1,
      };
    }

    const parsed: ParseResult<T> = definition.outputParser(queued.rawText);
    if (!parsed.success) {
      return {
        operationId: definition.operationId,
        status: "failed",
        output: null,
        error: parsed.error,
        tokenUsage: { input: 10, output: 5 },
        cost: 0,
        durationMs: 1,
      };
    }

    return {
      operationId: definition.operationId,
      status: "success",
      output: parsed,
      error: null,
      tokenUsage: { input: 10, output: 20 },
      cost: 0.001,
      durationMs: 1,
    };
  }
}

export interface Phase1Harness extends Phase1HandlerDeps {
  handlers: Phase1HandlersImpl;
  storage: MemoryStorage;
  executor: QueueExecutor;
  summarizer: Summarizer;
}

export function makePhase1Harness(responses: QueuedResponse[]): Phase1Harness {
  const storage = new MemoryStorage();
  const executor = new QueueExecutor(responses);
  const promptRegistry = new PromptRegistry();
  registerPhase1Prompts(promptRegistry);
  const summarizer = new Summarizer(executor);
  const contextBuilder = new ContextBuilder(storage, promptRegistry, summarizer);
  const handlers = new Phase1HandlersImpl({
    storage,
    executor,
    contextBuilder,
    promptRegistry,
  });
  return {
    storage,
    executor,
    promptRegistry,
    summarizer,
    contextBuilder,
    handlers,
  };
}

// Sample LLM outputs used by multiple tests. Kept here so any tweak
// (e.g. changing the required markdown sections) ripples across the suite
// without hunting through individual test files.

export const SAMPLE_GENERATION_CONTEXT = `I've sketched out the product. Let me know if anything needs adjusting.

<generation_context>
goal: A simple task tracker where users create tasks and mark them complete
personas:
  - name: user
    definition: an individual who wants to manage their to-do list
    interaction: creates and completes tasks
entities:
  - name: task
    description: a single item to do
    persona_interactions:
      - persona: user
        action: creates, edits, marks complete
boundaries:
  - No collaboration / shared lists
  - No due-date reminders
</generation_context>`;

export const SAMPLE_CONTRACT_MARKDOWN = `## Goal Statement
A simple task tracker where users create tasks and mark them complete.

## Personas
**User**
An individual who wants to manage their to-do list. Interaction type: creates and completes tasks.

## Entity Map
**Task**: a single item to do. User creates, edits, and marks it complete.

## Boundaries
- No collaboration / shared lists
- No due-date reminders`;

export const CLARIFYING_QUESTION_OUTPUT = `Could you tell me a bit more about whether this is for personal use or a team?`;

export const VALIDATION_PASS_OUTPUT = `STATUS: PASS

ISSUES:

SUGGESTIONS:
- Consider adding a "completed tasks" history view
- None`;

export const VALIDATION_FAIL_OUTPUT = `STATUS: FAIL

ISSUES:
- Boundaries section is empty
- No persona defines what "completed" means

SUGGESTIONS:
- Add at least one boundary
- Define a task lifecycle`;

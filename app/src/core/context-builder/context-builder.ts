import type {
  ChatMessage,
  Document,
  LLMMessage,
  PhaseId,
} from "@core/types";
import type { IStorage } from "@core/storage/interface";
import type { IPromptRegistry } from "@core/prompts";
import { CHAT_HISTORY_TOKEN_BUDGET } from "@lib/constants";

import { buildPhase2SystemContext } from "./phase2-context";
import type { Summarizer } from "./summarizer";

export interface BuiltContext {
  systemPrompt: string;
  messages: LLMMessage[];
}

// The Context Builder is the bridge between the Session Manager (knows
// WHAT to do) and the Operation Executor (knows HOW to call the LLM). Each
// public method assembles the exact {systemPrompt, messages} pair that one
// operation needs. Operations never build prompts themselves — they ask
// the Context Builder for a ready-to-execute context.
//
// Design rules:
//   1. No direct LLM calls. The only AI dependency is the Summarizer, which
//      owns the executor and scopes its use to history compression. The
//      rest of the Context Builder is pure + I/O against storage.
//   2. No storage mutation except via the explicit
//      `updateConversationSummary` delegate. Every other method is read-only.
//   3. Document generators are ISOLATED (spec §6.1). They do NOT include
//      chat history — just a system prompt + a single user message wrapping
//      the generation_context string produced by the Conversational AI.
//      Keeping generators deterministic relative to their input is what
//      lets Sprint 7 run drift checks reliably.

export class ContextBuilder {
  constructor(
    private readonly storage: IStorage,
    private readonly promptRegistry: IPromptRegistry,
    private readonly summarizer: Summarizer,
  ) {}

  // --- Phase 1 ---

  async buildPhase1FirstMessage(userMessage: string): Promise<BuiltContext> {
    return {
      systemPrompt: this.promptRegistry.get("phase1-conversational"),
      messages: [{ role: "user", content: userMessage }],
    };
  }

  async buildPhase1Iteration(
    sessionId: string,
    userMessage: string,
  ): Promise<BuiltContext> {
    const history = await this.loadPhaseChatHistory(sessionId, "phase-1");
    const processedHistory = await this.summarizer.processHistory(
      history,
      CHAT_HISTORY_TOKEN_BUDGET,
    );

    return {
      systemPrompt: this.promptRegistry.get("phase1-conversational"),
      messages: [
        ...processedHistory,
        { role: "user", content: userMessage },
      ],
    };
  }

  async buildProjectContractGeneratorContext(
    generationContext: string,
  ): Promise<BuiltContext> {
    return {
      systemPrompt: this.promptRegistry.get("project-contract-generator"),
      messages: [
        {
          role: "user",
          content: `Generate the Project Contract from this context:\n\n${generationContext}`,
        },
      ],
    };
  }

  async buildPhase1Validation(sessionId: string): Promise<BuiltContext> {
    const contract = await this.requireContract(sessionId, "Phase 1 validation");
    return {
      systemPrompt: this.promptRegistry.get("phase1-validation"),
      messages: [{ role: "user", content: contract.content }],
    };
  }

  // --- Phase 2 Auto-Generation ---

  async buildWorkflowDiscovery(sessionId: string): Promise<BuiltContext> {
    const contract = await this.requireContract(sessionId, "Workflow discovery");
    return {
      systemPrompt: this.promptRegistry.get("workflow-discovery"),
      messages: [{ role: "user", content: contract.content }],
    };
  }

  async buildWorkflowDetail(
    sessionId: string,
    workflowStub: string,
  ): Promise<BuiltContext> {
    const contract = await this.requireContract(sessionId, "Workflow detail");
    return {
      systemPrompt: this.promptRegistry.get("workflow-detail"),
      messages: [
        {
          role: "user",
          content: `Project Contract:\n${contract.content}\n\nWorkflow to detail:\n${workflowStub}`,
        },
      ],
    };
  }

  async buildTestCaseGeneration(
    sessionId: string,
    workflowContent: string,
  ): Promise<BuiltContext> {
    const contract = await this.requireContract(
      sessionId,
      "Test case generation",
    );
    return {
      systemPrompt: this.promptRegistry.get("test-case-generation"),
      messages: [
        {
          role: "user",
          content: `Project Contract:\n${contract.content}\n\nWorkflow:\n${workflowContent}`,
        },
      ],
    };
  }

  async buildScreenExtraction(
    sessionId: string,
    workflowMapContent: string,
  ): Promise<BuiltContext> {
    const contract = await this.requireContract(sessionId, "Screen extraction");
    return {
      systemPrompt: this.promptRegistry.get("screen-extraction"),
      messages: [
        {
          role: "user",
          content: `Project Contract:\n${contract.content}\n\nWorkflow Map:\n${workflowMapContent}`,
        },
      ],
    };
  }

  async buildScreenHTMLGeneration(
    sessionId: string,
    screenSpec: string,
  ): Promise<BuiltContext> {
    const contract = await this.requireContract(
      sessionId,
      "Screen HTML generation",
    );
    return {
      systemPrompt: this.promptRegistry.get("screen-html-generation"),
      messages: [
        {
          role: "user",
          content: `Project Contract:\n${contract.content}\n\nScreen Specification:\n${screenSpec}`,
        },
      ],
    };
  }

  // --- Phase 2 Interaction ---

  async buildPhase2ConversationalContext(
    sessionId: string,
    userMessage: string,
    screenRef: string | null,
  ): Promise<BuiltContext> {
    const systemContext = await buildPhase2SystemContext(
      this.storage,
      sessionId,
      screenRef,
    );
    const history = await this.loadPhaseChatHistory(sessionId, "phase-2");
    const processedHistory = await this.summarizer.processHistory(
      history,
      CHAT_HISTORY_TOKEN_BUDGET,
    );

    const messageWithRef = screenRef
      ? `[Viewing: ${screenRef}]\n\n${userMessage}`
      : userMessage;

    return {
      systemPrompt: this.promptRegistry.get("phase2-conversational"),
      messages: [
        { role: "system", content: systemContext },
        ...processedHistory,
        { role: "user", content: messageWithRef },
      ],
    };
  }

  // --- Phase 2 Drift / Validation / Diagnosis ---

  async buildDriftCheck(
    sessionId: string,
    changeContext: string,
  ): Promise<BuiltContext> {
    const contract = await this.requireContract(sessionId, "Drift check");
    return {
      systemPrompt: this.promptRegistry.get("drift-check"),
      messages: [
        {
          role: "user",
          content: `Project Contract:\n${contract.content}\n\nProposed Change:\n${changeContext}`,
        },
      ],
    };
  }

  // --- Summary maintenance (delegated) ---

  async updateConversationSummary(
    sessionId: string,
    phaseId: PhaseId,
    iterationNumber: number,
    changeDescription: string,
    scope: string,
    affectedArtifacts: string[],
  ): Promise<void> {
    await this.summarizer.updateConversationSummary(
      this.storage,
      sessionId,
      phaseId,
      iterationNumber,
      changeDescription,
      scope,
      affectedArtifacts,
    );
  }

  // --- Private helpers ---

  private async requireContract(
    sessionId: string,
    opLabel: string,
  ): Promise<Document> {
    const contract = await this.storage.getActiveDocument(
      sessionId,
      "project_contract",
    );
    if (!contract) {
      throw new Error(
        `${opLabel} requires an active project contract for session ${sessionId}`,
      );
    }
    return contract;
  }

  private async loadPhaseChatHistory(
    sessionId: string,
    phaseId: PhaseId,
  ): Promise<ChatMessage[]> {
    const all = await this.storage.getMessagesByPhase(sessionId, phaseId);
    // Only `type === 'chat'` survives — the other types (system_notification,
    // drift_warning, validation_result, ...) are bookkeeping that the LLM
    // shouldn't see in its chat history window.
    return all.filter((m) => m.type === "chat");
  }
}

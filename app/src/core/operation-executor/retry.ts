import type { LLMMessage } from "@core/types";

// Build the message list for a parse-failure retry. We keep the original
// system + user messages, append the model's failed response as an assistant
// turn, then add a corrective user turn that includes the parser error and
// the operation-specific retry hint.
//
// Why this shape: the model sees its own output in context, knows what was
// wrong, and is asked to regenerate. This is more reliable than a blank
// "try again" because the model can self-correct against the actual error.

export function buildRetryMessages(
  originalMessages: LLMMessage[],
  failedOutput: string,
  parseError: string,
  retryPrompt: string,
): LLMMessage[] {
  return [
    ...originalMessages,
    { role: "assistant", content: failedOutput },
    {
      role: "user",
      content: [
        "The previous response could not be parsed correctly.",
        `Error: ${parseError}`,
        "",
        "Please regenerate your response following the exact format specified in the instructions.",
        retryPrompt,
      ].join("\n"),
    },
  ];
}

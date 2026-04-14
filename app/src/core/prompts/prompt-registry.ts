// Minimal registry the Context Builder can depend on.
//
// Sprint 3 needs a stable interface to inject into ContextBuilder — actual
// prompt bodies don't land until Sprint 5 (Phase 1 Complete). Until then,
// this class just holds whatever slug->body pairs are registered at boot.
//
// Tests seed fake prompts via `register(...)` before constructing the
// ContextBuilder so every assertion is against known content.

export interface IPromptRegistry {
  get(slug: string): string;
  has(slug: string): boolean;
  register(slug: string, content: string): void;
}

export class PromptRegistry implements IPromptRegistry {
  private readonly prompts = new Map<string, string>();

  register(slug: string, content: string): void {
    this.prompts.set(slug, content);
  }

  has(slug: string): boolean {
    return this.prompts.has(slug);
  }

  get(slug: string): string {
    const body = this.prompts.get(slug);
    if (body === undefined) {
      throw new Error(
        `Prompt "${slug}" not registered. Register it via PromptRegistry#register() before use.`,
      );
    }
    return body;
  }
}

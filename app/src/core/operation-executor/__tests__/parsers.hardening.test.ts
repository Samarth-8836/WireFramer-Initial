import { describe, expect, it } from "vitest";

import {
  extractChangeContext,
  extractGenerationContext,
  parseDiagnosisResult,
  parseDriftResult,
  parseJSON,
  parseMarkdownSections,
  parsePlainText,
  parseValidationResult,
  parseYAML,
} from "../parsers";

// Parser hardening — Sprint 11.
//
// For each parser, exercise the six LLM-output failure patterns:
//   1. Output wrapped in triple backtick code fences
//   2. Output with helpful preamble text before the data
//   3. Output with extra/unexpected fields or sections
//   4. Output missing required fields
//   5. Output with malformed YAML/JSON structure
//   6. Empty output
//
// These tests guard against regressions in stripCodeFences and the
// field-extraction regex handling. They are not redundant with
// parsers.test.ts — that file covers the golden paths; this one covers
// the long tail of LLM quirks.

// ---------- parseYAML hardening ----------

describe("parseYAML [hardening]", () => {
  it("strips fences with preamble (helpful LLM chatter before the data)", () => {
    const text = `Sure, here's the YAML you asked for:

\`\`\`yaml
name: Alice
role: admin
\`\`\``;
    const result = parseYAML(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: "Alice", role: "admin" });
    }
  });

  it("strips fences with postamble (LLM adds commentary after)", () => {
    const text = `\`\`\`yaml
name: Bob
\`\`\`

Let me know if you want any changes.`;
    const result = parseYAML(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: "Bob" });
    }
  });

  it("strips fences with both preamble and postamble", () => {
    const text = `Here you go:

\`\`\`yaml
key: value
\`\`\`

Happy to iterate.`;
    const result = parseYAML(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ key: "value" });
    }
  });

  it("accepts extra/unexpected fields (LLM added more than requested)", () => {
    const result = parseYAML(
      "name: Alice\nrole: admin\nbonus: unexpected",
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).bonus).toBe("unexpected");
    }
  });

  it("rejects entirely empty input", () => {
    expect(parseYAML("").success).toBe(false);
    expect(parseYAML("   ").success).toBe(false);
    expect(parseYAML("\n\n\n").success).toBe(false);
  });

  it("rejects input with only code fences and no body", () => {
    // stripCodeFences extracts "" from this, which then fails the empty check.
    const result = parseYAML("```yaml\n\n```");
    expect(result.success).toBe(false);
  });
});

// ---------- parseJSON hardening ----------

describe("parseJSON [hardening]", () => {
  it("strips fences with preamble", () => {
    const text = `Here's the JSON:

\`\`\`json
{"a":1,"b":2}
\`\`\``;
    const result = parseJSON(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ a: 1, b: 2 });
    }
  });

  it("rejects empty input", () => {
    expect(parseJSON("").success).toBe(false);
    expect(parseJSON("   ").success).toBe(false);
  });

  it("rejects malformed JSON with useful error", () => {
    const result = parseJSON("{not valid json}");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/JSON parse error/);
    }
  });

  it("accepts nested arrays and extra keys", () => {
    const result = parseJSON('{"a":[1,2,[3,[4]]],"extra":"ok"}');
    expect(result.success).toBe(true);
  });
});

// ---------- parseMarkdownSections hardening ----------

describe("parseMarkdownSections [hardening]", () => {
  it("accepts extra sections beyond the expected set", () => {
    const text = `## Goals

Build a thing.

## Personas

Users.

## Out of scope

Nothing.

## Extra Section

Not requested but present.`;
    const result = parseMarkdownSections(text, [
      "Goals",
      "Personas",
      "Out of scope",
    ]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sections["Extra Section"]).toContain("Not requested");
    }
  });

  it("fails cleanly on empty input with expected sections", () => {
    const result = parseMarkdownSections("", ["Goals", "Personas"]);
    expect(result.success).toBe(false);
  });

  it("fails when all expected sections are empty", () => {
    const text = `## Goals

## Personas

## Out of scope`;
    const result = parseMarkdownSections(text, [
      "Goals",
      "Personas",
      "Out of scope",
    ]);
    expect(result.success).toBe(false);
  });
});

// ---------- extractGenerationContext hardening ----------

describe("extractGenerationContext [hardening]", () => {
  it("handles generation_context wrapped in outer code fences", () => {
    const text = `Sure.

\`\`\`
Here's my analysis.

<generation_context>
goal: Do a thing
features:
  - a
\`\`\``;
    // Truncated closing tag simulates fence-heavy output. With no closing
    // </generation_context>, we treat this as a clarifying question.
    const result = extractGenerationContext(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isClarifyingQuestion).toBe(true);
    }
  });

  it("handles tag with only closing — treats as clarifying question", () => {
    const text = "No opening tag here </generation_context>";
    const result = extractGenerationContext(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isClarifyingQuestion).toBe(true);
    }
  });

  it("handles closing tag before opening — treats as clarifying", () => {
    // indexOf finds the close first; closeIdx < openIdx means we fall through
    // to the clarifying-question branch.
    const text = "</generation_context> ... <generation_context>";
    const result = extractGenerationContext(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isClarifyingQuestion).toBe(true);
    }
  });

  it("handles visible response with multiple paragraphs before tag", () => {
    const text = `First thought.

Second thought.

<generation_context>
goal: simple
</generation_context>`;
    const result = extractGenerationContext(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.visibleResponse).toContain("First thought");
      expect(result.data.visibleResponse).toContain("Second thought");
    }
  });

  it("handles empty input as clarifying question", () => {
    // No tag, so we treat it as the whole input being a visible response
    // (which happens to be empty).
    const result = extractGenerationContext("");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isClarifyingQuestion).toBe(true);
      expect(result.data.visibleResponse).toBe("");
    }
  });
});

// ---------- extractChangeContext hardening ----------

describe("extractChangeContext [hardening]", () => {
  it("accepts extra fields beyond scope + description", () => {
    const text = `Here it is.

<change_context>
scope: screen_only
description: Add a filter
target_screens:
  - product-list
priority: high
notes: extra field ok
</change_context>`;
    const result = extractChangeContext(text);
    expect(result.success).toBe(true);
    if (result.success && result.data.changeContext) {
      expect(result.data.changeContext.scope).toBe("screen_only");
      expect(result.data.changeContext.priority).toBe("high");
      expect(result.data.changeContext.notes).toBe("extra field ok");
    }
  });

  it("fails when scope is non-string (e.g. number)", () => {
    const text = `OK.

<change_context>
scope: 42
description: still bad
</change_context>`;
    const result = extractChangeContext(text);
    expect(result.success).toBe(false);
  });

  it("fails on malformed YAML inside the tag", () => {
    const text = `OK.

<change_context>
scope: : : bad
description: foo
</change_context>`;
    const result = extractChangeContext(text);
    expect(result.success).toBe(false);
  });
});

// ---------- parseValidationResult hardening ----------

describe("parseValidationResult [hardening]", () => {
  it("accepts lowercase status (case-insensitive)", () => {
    const text = `status: pass

ISSUES:

SUGGESTIONS:`;
    const result = parseValidationResult(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("PASS");
    }
  });

  it("accepts STATUS with surrounding prose (preamble)", () => {
    const text = `Here's my validation result:

STATUS: FAIL

ISSUES:
- Missing entities
- No personas

WARNINGS:

SUGGESTIONS:
- Add personas first`;
    const result = parseValidationResult(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("FAIL");
      expect(result.data.issues).toHaveLength(2);
      expect(result.data.suggestions).toHaveLength(1);
    }
  });

  it("handles missing sections gracefully — treats as empty arrays", () => {
    const text = `STATUS: PASS`;
    const result = parseValidationResult(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toEqual([]);
      expect(result.data.warnings).toEqual([]);
      expect(result.data.suggestions).toEqual([]);
    }
  });

  it('treats "None" placeholder in section as no items', () => {
    // "- None" would be parsed as a single bullet, but "None" without dash is ignored.
    const text = `STATUS: PASS

ISSUES:
None

WARNINGS:

SUGGESTIONS:
- Real suggestion`;
    const result = parseValidationResult(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toEqual([]);
      expect(result.data.suggestions).toEqual(["Real suggestion"]);
    }
  });

  it("rejects entirely empty input", () => {
    expect(parseValidationResult("").success).toBe(false);
  });
});

// ---------- parseDriftResult hardening ----------

describe("parseDriftResult [hardening]", () => {
  it("handles preamble before the fields", () => {
    const text = `Here's my assessment:

classification: FLAG
type: NEW_FEATURE
reason: introduces capability not in the contract`;
    const result = parseDriftResult(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.classification).toBe("FLAG");
      expect(result.data.type).toBe("NEW_FEATURE");
    }
  });

  it("handles code-fenced output", () => {
    // Parser doesn't strip fences, but the regex for classification/type/reason
    // matches anywhere in the text — so it should still work.
    const text = "```\nclassification: COMPATIBLE\ntype: NONE\nreason: ok\n```";
    const result = parseDriftResult(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.classification).toBe("COMPATIBLE");
    }
  });

  it("accepts multi-line reason (captures only first line)", () => {
    const text = `classification: DRIFT
type: REMOVED_FEATURE
reason: deletes a locked persona
  which cannot be restored without rollback`;
    const result = parseDriftResult(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe("deletes a locked persona");
    }
  });

  it("rejects entirely empty input", () => {
    expect(parseDriftResult("").success).toBe(false);
  });
});

// ---------- parseDiagnosisResult hardening ----------

describe("parseDiagnosisResult [hardening]", () => {
  it("handles multi-line field values (root_cause spans multiple lines)", () => {
    const text = `diagnosis: WIREFRAME_BUG
root_cause: The button onclick handler is missing.
It should set data-state="filtered" but does nothing.
affected_artifact: product-list.html
proposed_fix: Add the missing onclick.
confidence: high`;
    const result = parseDiagnosisResult(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rootCause).toContain("onclick handler is missing");
      expect(result.data.rootCause).toContain(
        'data-state="filtered"',
      );
    }
  });

  it("handles code-fenced output (regex matches fields anywhere)", () => {
    const text = `\`\`\`
diagnosis: TEST_BUG
root_cause: bad selector
affected_artifact: tests.js
proposed_fix: fix it
confidence: medium
\`\`\``;
    const result = parseDiagnosisResult(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.diagnosis).toBe("TEST_BUG");
    }
  });

  it("handles preamble before fields", () => {
    const text = `After reviewing, here is my diagnosis:

diagnosis: WORKFLOW_FLAW
root_cause: step order is wrong
affected_artifact: workflow_map
proposed_fix: swap steps 2 and 3
confidence: high`;
    const result = parseDiagnosisResult(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.diagnosis).toBe("WORKFLOW_FLAW");
    }
  });

  it("returns empty strings for missing optional fields", () => {
    const text = `diagnosis: WIREFRAME_BUG
confidence: medium`;
    const result = parseDiagnosisResult(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rootCause).toBe("");
      expect(result.data.affectedArtifact).toBe("");
      expect(result.data.proposedFix).toBe("");
    }
  });

  it("rejects entirely empty input", () => {
    expect(parseDiagnosisResult("").success).toBe(false);
  });
});

// ---------- parsePlainText hardening ----------

describe("parsePlainText [hardening]", () => {
  it("accepts multi-line plain text", () => {
    const result = parsePlainText("line one\nline two\n\nline three");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.text).toContain("line one");
      expect(result.data.text).toContain("line three");
    }
  });

  it("rejects empty and whitespace-only input", () => {
    expect(parsePlainText("").success).toBe(false);
    expect(parsePlainText("   ").success).toBe(false);
    expect(parsePlainText("\t\n \n").success).toBe(false);
  });

  it("preserves internal formatting when trimming outer whitespace", () => {
    const result = parsePlainText("  My Project Title  ");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.text).toBe("My Project Title");
    }
  });
});

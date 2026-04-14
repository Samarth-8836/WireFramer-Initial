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

// ---------- parseYAML ----------

describe("parseYAML", () => {
  it("parses a plain YAML object", () => {
    const result = parseYAML("name: Alice\nage: 30");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: "Alice", age: 30 });
    }
  });

  it("strips ```yaml fences", () => {
    const result = parseYAML("```yaml\nkey: value\n```");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ key: "value" });
    }
  });

  it("strips bare ``` fences", () => {
    const result = parseYAML("```\nkey: value\n```");
    expect(result.success).toBe(true);
  });

  it("returns ParseError on malformed YAML", () => {
    const result = parseYAML(": : :\n  -- bad");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/YAML parse error/);
    }
  });

  it("rejects empty input", () => {
    const result = parseYAML("   \n   ");
    expect(result.success).toBe(false);
  });

  it("rejects empty object output", () => {
    const result = parseYAML("{}");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/empty object/);
    }
  });
});

// ---------- parseJSON ----------

describe("parseJSON", () => {
  it("parses a plain JSON object", () => {
    const result = parseJSON('{"a":1,"b":[1,2]}');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ a: 1, b: [1, 2] });
    }
  });

  it("strips ```json fences", () => {
    const result = parseJSON('```json\n{"x":42}\n```');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ x: 42 });
    }
  });

  it("returns ParseError on malformed JSON", () => {
    const result = parseJSON("{not: 'json'}");
    expect(result.success).toBe(false);
  });
});

// ---------- parseMarkdownSections ----------

describe("parseMarkdownSections", () => {
  const sample = `# Title

Some intro.

## Goals

Build a recipe app.

## Personas

Home cooks.

## Out of scope

Restaurant management.`;

  it("extracts all expected sections", () => {
    const result = parseMarkdownSections(sample, [
      "Goals",
      "Personas",
      "Out of scope",
    ]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sections.Goals).toContain("Build a recipe app.");
      expect(result.data.sections.Personas).toContain("Home cooks.");
      expect(result.data.sections["Out of scope"]).toContain("Restaurant");
    }
  });

  it("fails when an expected section is missing", () => {
    const result = parseMarkdownSections(sample, ["Goals", "Risks"]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/Risks/);
    }
  });

  it("fails when an expected section is empty", () => {
    const empty = "## Goals\n\n## Personas\n\nFoo.";
    const result = parseMarkdownSections(empty, ["Goals", "Personas"]);
    expect(result.success).toBe(false);
  });

  it("preserves the original markdown", () => {
    const result = parseMarkdownSections(sample, ["Goals", "Personas", "Out of scope"]);
    if (result.success) {
      expect(result.data.fullMarkdown).toBe(sample);
    }
  });
});

// ---------- extractGenerationContext ----------

describe("extractGenerationContext", () => {
  it("extracts visible response and YAML context", () => {
    const text = `Sounds like a recipe app for home cooks.

<generation_context>
goal: Recipe app
audience: home cooks
features:
  - search
  - favorites
</generation_context>`;
    const result = extractGenerationContext(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.visibleResponse).toBe(
        "Sounds like a recipe app for home cooks.",
      );
      expect(result.data.isClarifyingQuestion).toBe(false);
      expect(result.data.generationContext).toEqual({
        goal: "Recipe app",
        audience: "home cooks",
        features: ["search", "favorites"],
      });
    }
  });

  it("treats absence of context tag as a clarifying question", () => {
    const text = "What kind of recipes? Vegetarian only or anything?";
    const result = extractGenerationContext(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isClarifyingQuestion).toBe(true);
      expect(result.data.generationContext).toBeNull();
      expect(result.data.visibleResponse).toBe(text);
    }
  });

  it("fails when context body has malformed YAML", () => {
    const text = `OK.

<generation_context>
key: : : bad
</generation_context>`;
    const result = extractGenerationContext(text);
    expect(result.success).toBe(false);
  });

  it("fails when context body is empty", () => {
    const text = `OK.

<generation_context>
</generation_context>`;
    const result = extractGenerationContext(text);
    expect(result.success).toBe(false);
  });
});

// ---------- extractChangeContext ----------

describe("extractChangeContext", () => {
  it("extracts visible response and validates required fields", () => {
    const text = `Adding a filter.

<change_context>
scope: screen_only
description: Add category filter to product list
target_screens:
  - product-list
</change_context>`;
    const result = extractChangeContext(text);
    expect(result.success).toBe(true);
    if (result.success && result.data.changeContext) {
      expect(result.data.isClarifyingQuestion).toBe(false);
      expect(result.data.changeContext.scope).toBe("screen_only");
      expect(result.data.changeContext.description).toContain("filter");
    }
  });

  it("fails when scope is missing", () => {
    const text = `OK.

<change_context>
description: Just text, no scope
</change_context>`;
    const result = extractChangeContext(text);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/scope/);
    }
  });

  it("fails when description is missing", () => {
    const text = `OK.

<change_context>
scope: screen_only
</change_context>`;
    const result = extractChangeContext(text);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/description/);
    }
  });

  it("treats absence of tag as clarifying question", () => {
    const result = extractChangeContext("Which screen should I update?");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isClarifyingQuestion).toBe(true);
      expect(result.data.changeContext).toBeNull();
    }
  });
});

// ---------- parseValidationResult ----------

describe("parseValidationResult", () => {
  it("parses a PASS result with empty lists", () => {
    const text = `STATUS: PASS

ISSUES:

WARNINGS:

SUGGESTIONS:`;
    const result = parseValidationResult(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("PASS");
      expect(result.data.issues).toEqual([]);
      expect(result.data.suggestions).toEqual([]);
    }
  });

  it("parses a FAIL result with bullet lists", () => {
    const text = `STATUS: FAIL

ISSUES:
- Personas not defined
- Goals too vague

WARNINGS:
- Some screens are speculative

SUGGESTIONS:
- Add 2 personas with names
- Tighten the goal statement`;
    const result = parseValidationResult(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("FAIL");
      expect(result.data.issues).toHaveLength(2);
      expect(result.data.issues[0]).toBe("Personas not defined");
      expect(result.data.warnings).toHaveLength(1);
      expect(result.data.suggestions).toHaveLength(2);
    }
  });

  it("fails when STATUS is missing", () => {
    const result = parseValidationResult("ISSUES:\n- Stuff");
    expect(result.success).toBe(false);
  });
});

// ---------- parseDriftResult ----------

describe("parseDriftResult", () => {
  it("parses COMPATIBLE classification", () => {
    const result = parseDriftResult(
      "classification: COMPATIBLE\ntype: NONE\nreason: change is purely cosmetic",
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.classification).toBe("COMPATIBLE");
      expect(result.data.reason).toContain("cosmetic");
    }
  });

  it("parses FLAG classification", () => {
    const result = parseDriftResult(
      "classification: FLAG\ntype: SCOPE_CREEP\nreason: introduces a new persona",
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.classification).toBe("FLAG");
      expect(result.data.type).toBe("SCOPE_CREEP");
    }
  });

  it("parses DRIFT classification", () => {
    const result = parseDriftResult(
      "classification: DRIFT\ntype: CONTRACT_VIOLATION\nreason: removes a locked feature",
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.classification).toBe("DRIFT");
    }
  });

  it("fails when classification is missing", () => {
    const result = parseDriftResult("type: SCOPE_CREEP\nreason: foo");
    expect(result.success).toBe(false);
  });

  it("defaults type to NONE when missing", () => {
    const result = parseDriftResult("classification: COMPATIBLE");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("NONE");
    }
  });
});

// ---------- parseDiagnosisResult ----------

describe("parseDiagnosisResult", () => {
  it("parses a WIREFRAME_BUG diagnosis", () => {
    const text = `diagnosis: WIREFRAME_BUG
root_cause: Button onclick handler missing
affected_artifact: product-list.html
proposed_fix: Add onclick that sets data-state="filtered"
confidence: high`;
    const result = parseDiagnosisResult(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.diagnosis).toBe("WIREFRAME_BUG");
      expect(result.data.rootCause).toContain("onclick handler missing");
      expect(result.data.affectedArtifact).toBe("product-list.html");
      expect(result.data.proposedFix).toContain("onclick");
      expect(result.data.confidence).toBe("high");
    }
  });

  it("parses a TEST_BUG diagnosis", () => {
    const text = `diagnosis: TEST_BUG
root_cause: Selector targets old element id
affected_artifact: tests.js
proposed_fix: Update selector to data-test-id
confidence: medium`;
    const result = parseDiagnosisResult(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.diagnosis).toBe("TEST_BUG");
    }
  });

  it("parses a WORKFLOW_FLAW diagnosis", () => {
    const text = `diagnosis: WORKFLOW_FLAW
root_cause: Step 3 contradicts step 1
affected_artifact: workflow_map
proposed_fix: Reorder the workflow
confidence: low`;
    const result = parseDiagnosisResult(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.diagnosis).toBe("WORKFLOW_FLAW");
      expect(result.data.confidence).toBe("low");
    }
  });

  it("defaults confidence to medium when invalid", () => {
    const text = `diagnosis: WIREFRAME_BUG
root_cause: x
proposed_fix: y
confidence: somethingElse`;
    const result = parseDiagnosisResult(text);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.confidence).toBe("medium");
    }
  });

  it("fails when diagnosis field is missing", () => {
    const result = parseDiagnosisResult("root_cause: x\nproposed_fix: y");
    expect(result.success).toBe(false);
  });
});

// ---------- parsePlainText ----------

describe("parsePlainText", () => {
  it("returns trimmed text", () => {
    const result = parsePlainText("  hello world  \n");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.text).toBe("hello world");
    }
  });

  it("rejects empty input", () => {
    const result = parsePlainText("   \n   ");
    expect(result.success).toBe(false);
  });
});

import { parse as parseYamlLib } from "yaml";

import type { ParseResult } from "@core/types";

// Every parser in this file follows the same contract:
//   (rawText: string) => ParseResult<T>
//
// They are pure functions — no I/O, no globals — so they're trivially
// testable and reusable across operations.

// ---------- shared helpers ----------

// LLMs love wrapping output in fenced code blocks even when you ask them not to.
// Strip the leading and trailing fences but leave the body intact. Handles
// ```yaml ...```, ```json ...```, ```...``` (no language tag), and bare ```.
//
// Also handles the "helpful preamble" pattern: "Sure, here's the data:\n```yaml\n...\n```"
// by extracting the first complete fence block when full-string fencing fails.
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  // Match opening fence (with optional language tag) and closing fence.
  const fullRegex = /^```(?:\w+)?\s*\n?([\s\S]*?)\n?```$/;
  const fullMatch = trimmed.match(fullRegex);
  if (fullMatch) return fullMatch[1].trim();

  // Fallback: find the first fence pair anywhere in the text. Handles
  // preamble like "Here's the YAML:\n```yaml\n...\n```" and postamble
  // like "```yaml\n...\n```\nLet me know if you want changes."
  const anywhereRegex = /```(?:\w+)?\s*\n?([\s\S]*?)\n?```/;
  const anywhereMatch = trimmed.match(anywhereRegex);
  if (anywhereMatch) return anywhereMatch[1].trim();

  return trimmed;
}

// ---------- structured format parsers ----------

export function parseYAML(rawText: string): ParseResult {
  try {
    const cleaned = stripCodeFences(rawText);
    if (cleaned.length === 0) {
      return { success: false, error: "YAML input was empty", rawText };
    }
    const data = parseYamlLib(cleaned);
    if (data === null || data === undefined) {
      return { success: false, error: "YAML parsed to null/undefined", rawText };
    }
    if (typeof data === "object" && Object.keys(data).length === 0) {
      return { success: false, error: "YAML parsed to empty object", rawText };
    }
    return { success: true, data, rawText };
  } catch (err) {
    return {
      success: false,
      error: `YAML parse error: ${(err as Error).message}`,
      rawText,
    };
  }
}

export function parseJSON(rawText: string): ParseResult {
  try {
    const cleaned = stripCodeFences(rawText);
    if (cleaned.length === 0) {
      return { success: false, error: "JSON input was empty", rawText };
    }
    const data = JSON.parse(cleaned);
    return { success: true, data, rawText };
  } catch (err) {
    return {
      success: false,
      error: `JSON parse error: ${(err as Error).message}`,
      rawText,
    };
  }
}

// Parse markdown into a {sectionTitle: bodyText} map by splitting on `## ` headers.
// expectedSections is a soft requirement: missing sections fail the parse so the
// retry loop can ask the model to regenerate with all the headers present.
export interface MarkdownSectionsData {
  sections: Record<string, string>;
  fullMarkdown: string;
}

export function parseMarkdownSections(
  rawText: string,
  expectedSections: string[],
): ParseResult<MarkdownSectionsData> {
  const sections: Record<string, string> = {};
  const headerRegex = /^## (.+)$/gm;
  const positions: { title: string; headerEnd: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = headerRegex.exec(rawText)) !== null) {
    positions.push({
      title: match[1].trim(),
      // Where the header line ends — body content starts on the next line.
      headerEnd: match.index + match[0].length,
    });
  }

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].headerEnd;
    const end = i + 1 < positions.length ? positions[i + 1].headerEnd - positions[i + 1].title.length - 4 : rawText.length;
    sections[positions[i].title] = rawText.slice(start, end).trim();
  }

  const missing = expectedSections.filter(
    (s) => !sections[s] || sections[s].length === 0,
  );
  if (missing.length > 0) {
    return {
      success: false,
      error: `Missing or empty sections: ${missing.join(", ")}`,
      rawText,
    };
  }

  return {
    success: true,
    data: { sections, fullMarkdown: rawText },
    rawText,
  };
}

// ---------- context-block extraction ----------

// Phase 1: <generation_context> block holds the YAML the document generator
// will consume. If the LLM responded WITHOUT this block, that's a clarifying
// question — perfectly valid, just means we don't generate a document this turn.
export interface GenerationContextData {
  visibleResponse: string;
  generationContext: unknown | null;
  generationContextRaw: string | null;
  isClarifyingQuestion: boolean;
}

export function extractGenerationContext(
  rawText: string,
): ParseResult<GenerationContextData> {
  return extractTaggedContext(rawText, "generation_context");
}

// Phase 2: <change_context> block. Same shape as generation_context but with
// required fields (scope, description) that gate cascade routing.
export interface ChangeContextData {
  visibleResponse: string;
  changeContext: { scope: string; description: string; [k: string]: unknown } | null;
  changeContextRaw: string | null;
  isClarifyingQuestion: boolean;
}

export function extractChangeContext(
  rawText: string,
): ParseResult<ChangeContextData> {
  const result = extractTaggedContext(rawText, "change_context");
  if (!result.success) return result;

  const data = result.data;
  if (data.isClarifyingQuestion) {
    return {
      success: true,
      data: {
        visibleResponse: data.visibleResponse,
        changeContext: null,
        changeContextRaw: null,
        isClarifyingQuestion: true,
      },
      rawText,
    };
  }

  const ctx = data.generationContext as Record<string, unknown> | null;
  if (!ctx || typeof ctx.scope !== "string" || typeof ctx.description !== "string") {
    return {
      success: false,
      error: "change_context missing required fields: scope, description",
      rawText,
    };
  }

  return {
    success: true,
    data: {
      visibleResponse: data.visibleResponse,
      changeContext: ctx as ChangeContextData["changeContext"],
      changeContextRaw: data.generationContextRaw,
      isClarifyingQuestion: false,
    },
    rawText,
  };
}

// Shared internals — extracts <tag>...</tag> blocks where the body is YAML
// and the prefix is treated as the user-visible response.
function extractTaggedContext(
  rawText: string,
  tag: string,
): ParseResult<GenerationContextData> {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const openIdx = rawText.indexOf(open);
  const closeIdx = rawText.indexOf(close);

  if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) {
    // No tag present (or malformed) — treat as a clarifying question.
    return {
      success: true,
      data: {
        visibleResponse: rawText.trim(),
        generationContext: null,
        generationContextRaw: null,
        isClarifyingQuestion: true,
      },
      rawText,
    };
  }

  const visibleResponse = rawText.slice(0, openIdx).trim();
  const contextYaml = rawText.slice(openIdx + open.length, closeIdx).trim();

  if (contextYaml.length === 0) {
    return {
      success: false,
      error: `${tag} block is empty`,
      rawText,
    };
  }

  try {
    const contextData = parseYamlLib(contextYaml);
    if (contextData === null || contextData === undefined) {
      return {
        success: false,
        error: `${tag} body parsed to null`,
        rawText,
      };
    }
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
  } catch (err) {
    return {
      success: false,
      error: `Failed to parse YAML inside <${tag}>: ${(err as Error).message}`,
      rawText,
    };
  }
}

// ---------- structured-text parsers (op 1.3, 2.6, 2.9, 2.10) ----------

export type ValidationStatus = "PASS" | "FAIL";

export interface ValidationResultData {
  status: ValidationStatus;
  issues: string[];
  warnings: string[];
  suggestions: string[];
}

export function parseValidationResult(
  rawText: string,
): ParseResult<ValidationResultData> {
  const statusMatch = rawText.match(/STATUS:\s*(PASS|FAIL)/i);
  if (!statusMatch) {
    return {
      success: false,
      error: "Could not find STATUS: PASS or FAIL",
      rawText,
    };
  }

  return {
    success: true,
    data: {
      status: statusMatch[1].toUpperCase() as ValidationStatus,
      issues: extractBulletList(rawText, "ISSUES"),
      warnings: extractBulletList(rawText, "WARNINGS"),
      suggestions: extractBulletList(rawText, "SUGGESTIONS"),
    },
    rawText,
  };
}

// Extract a bullet list under a HEADER: line. Stops at the next header line
// (TOKEN: at start-of-line) or end of input.
function extractBulletList(text: string, header: string): string[] {
  const headerRegex = new RegExp(`^${header}:\\s*$`, "im");
  const headerMatch = headerRegex.exec(text);
  if (!headerMatch) return [];
  const start = headerMatch.index + headerMatch[0].length;
  const after = text.slice(start);
  // Stop at the next header (UPPERCASE_TOKEN:) at the start of a line.
  const nextHeader = after.match(/\n[A-Z][A-Z_]+:\s*$/m);
  const body = nextHeader ? after.slice(0, nextHeader.index) : after;
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

export type DriftClassification = "COMPATIBLE" | "FLAG" | "DRIFT";

export interface DriftResultData {
  classification: DriftClassification;
  type: string;
  reason: string;
}

export function parseDriftResult(rawText: string): ParseResult<DriftResultData> {
  const classMatch = rawText.match(/classification:\s*(COMPATIBLE|FLAG|DRIFT)/i);
  if (!classMatch) {
    return {
      success: false,
      error: "Could not find classification field",
      rawText,
    };
  }
  const typeMatch = rawText.match(/type:\s*([^\n]+)/i);
  const reasonMatch = rawText.match(/reason:\s*([^\n]+)/i);

  return {
    success: true,
    data: {
      classification: classMatch[1].toUpperCase() as DriftClassification,
      type: typeMatch?.[1]?.trim() ?? "NONE",
      reason: reasonMatch?.[1]?.trim() ?? "",
    },
    rawText,
  };
}

export type DiagnosisType = "WIREFRAME_BUG" | "TEST_BUG" | "WORKFLOW_FLAW";
export type DiagnosisConfidence = "high" | "medium" | "low";

export interface DiagnosisResultData {
  diagnosis: DiagnosisType;
  rootCause: string;
  affectedArtifact: string;
  proposedFix: string;
  confidence: DiagnosisConfidence;
}

export function parseDiagnosisResult(
  rawText: string,
): ParseResult<DiagnosisResultData> {
  const diagnosisMatch = rawText.match(
    /diagnosis:\s*(WIREFRAME_BUG|TEST_BUG|WORKFLOW_FLAW)/i,
  );
  if (!diagnosisMatch) {
    return {
      success: false,
      error: "Could not find diagnosis field",
      rawText,
    };
  }

  // Multi-line fields — capture until the next known field name or EOF.
  const fieldNames = [
    "diagnosis",
    "root_cause",
    "affected_artifact",
    "proposed_fix",
    "confidence",
  ];
  const stopPattern = `(?:${fieldNames.join("|")}):`;
  const captureField = (name: string): string | null => {
    const re = new RegExp(
      `${name}:\\s*([\\s\\S]*?)(?=\\n\\s*${stopPattern}|$)`,
      "i",
    );
    const m = rawText.match(re);
    return m ? m[1].trim() : null;
  };

  const confidenceRaw = captureField("confidence");
  const confidence: DiagnosisConfidence =
    confidenceRaw === "high" || confidenceRaw === "low" ? confidenceRaw : "medium";

  return {
    success: true,
    data: {
      diagnosis: diagnosisMatch[1].toUpperCase() as DiagnosisType,
      rootCause: captureField("root_cause") ?? "",
      affectedArtifact: captureField("affected_artifact") ?? "",
      proposedFix: captureField("proposed_fix") ?? "",
      confidence,
    },
    rawText,
  };
}

// ---------- trivial passthrough ----------

export function parsePlainText(rawText: string): ParseResult<{ text: string }> {
  const text = rawText.trim();
  if (text.length === 0) {
    return { success: false, error: "Empty plain text response", rawText };
  }
  return { success: true, data: { text }, rawText };
}

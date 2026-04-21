// Op 2.7b — Cascade Router (code-only).
//
// Determines which operations to execute based on the scope field
// in the parsed <change_context> from Op 2.7a.

export type CascadeScope = "data_only" | "screen_only" | "workflow_change";

export interface CascadeRoute {
  scope: CascadeScope;
  description: string;
  changeContext: Record<string, unknown>;
}

export function routeCascade(
  changeContext: Record<string, unknown>,
): CascadeRoute {
  const scope = (changeContext.scope as string) ?? "workflow_change";
  const description =
    (changeContext.description as string) ?? "Unspecified change";

  // Validate scope — default to workflow_change (the most thorough path)
  // if unrecognized.
  const validScopes: CascadeScope[] = [
    "data_only",
    "screen_only",
    "workflow_change",
  ];
  const resolvedScope = validScopes.includes(scope as CascadeScope)
    ? (scope as CascadeScope)
    : "workflow_change";

  return {
    scope: resolvedScope,
    description,
    changeContext,
  };
}

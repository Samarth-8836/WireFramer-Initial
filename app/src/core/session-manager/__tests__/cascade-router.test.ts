import { describe, expect, it } from "vitest";

import { routeCascade } from "../cascade-router";

describe("routeCascade", () => {
  it("routes data_only scope through", () => {
    const result = routeCascade({
      scope: "data_only",
      description: "Add 20 more dummy products",
    });
    expect(result.scope).toBe("data_only");
    expect(result.description).toBe("Add 20 more dummy products");
  });

  it("routes screen_only scope through", () => {
    const result = routeCascade({
      scope: "screen_only",
      description: "Add filter controls to product list",
      target_screens: ["product-list"],
    });
    expect(result.scope).toBe("screen_only");
    expect(result.changeContext.target_screens).toEqual(["product-list"]);
  });

  it("routes workflow_change scope through", () => {
    const result = routeCascade({
      scope: "workflow_change",
      description: "Add a return workflow",
    });
    expect(result.scope).toBe("workflow_change");
  });

  it("defaults to workflow_change for unknown scope values", () => {
    const result = routeCascade({
      scope: "frobnicate",
      description: "Something invalid",
    });
    expect(result.scope).toBe("workflow_change");
  });

  it("defaults to workflow_change when scope is missing", () => {
    const result = routeCascade({
      description: "Missing scope",
    });
    expect(result.scope).toBe("workflow_change");
  });

  it("defaults description to 'Unspecified change' when missing", () => {
    const result = routeCascade({ scope: "data_only" });
    expect(result.description).toBe("Unspecified change");
  });

  it("preserves the full changeContext for downstream consumers", () => {
    const ctx = {
      scope: "screen_only",
      description: "Add filter",
      target_screens: ["product-list"],
      priority: "high",
      notes: "don't break existing nav",
    };
    const result = routeCascade(ctx);
    expect(result.changeContext).toEqual(ctx);
  });

  it("treats scope of wrong type (number) as unknown and defaults", () => {
    const result = routeCascade({
      scope: 42 as unknown as string,
      description: "bad scope type",
    });
    expect(result.scope).toBe("workflow_change");
  });

  it("handles an empty object by returning safe defaults", () => {
    const result = routeCascade({});
    expect(result.scope).toBe("workflow_change");
    expect(result.description).toBe("Unspecified change");
    expect(result.changeContext).toEqual({});
  });
});

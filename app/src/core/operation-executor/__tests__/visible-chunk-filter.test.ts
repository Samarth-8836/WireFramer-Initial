import { describe, expect, it } from "vitest";

import { createVisibleChunkFilter } from "../visible-chunk-filter";

// Tests the stream filter that hides <generation_context> / <change_context>
// from the user-visible chat bubble during streaming.

function collect(chunks: string[]): { forward: (t: string) => void } {
  return { forward: (t: string) => chunks.push(t) };
}

describe("createVisibleChunkFilter", () => {
  it("forwards everything when no stop tag appears", () => {
    const emitted: string[] = [];
    const { forward } = collect(emitted);
    const filter = createVisibleChunkFilter(forward);

    filter.push("Hello ");
    filter.push("world, ");
    filter.push("this is a message.");
    filter.flush();

    expect(emitted.join("")).toBe("Hello world, this is a message.");
    expect(filter.wasStopped()).toBe(false);
  });

  it("stops forwarding at <generation_context>", () => {
    const emitted: string[] = [];
    const filter = createVisibleChunkFilter((t) => emitted.push(t));

    filter.push("Here is the contract:\n\n");
    filter.push("<generation_context>\n");
    filter.push("goal: build a thing\n");
    filter.push("</generation_context>");
    filter.flush();

    expect(emitted.join("")).toBe("Here is the contract:\n\n");
    expect(filter.wasStopped()).toBe(true);
  });

  it("stops forwarding at <change_context>", () => {
    const emitted: string[] = [];
    const filter = createVisibleChunkFilter((t) => emitted.push(t));

    filter.push("Adding a filter. ");
    filter.push("<change_context>\n");
    filter.push("scope: screen_only");
    filter.push("\n</change_context>");
    filter.flush();

    expect(emitted.join("")).toBe("Adding a filter. ");
    expect(filter.wasStopped()).toBe(true);
  });

  it("handles a tag split across many small chunks", () => {
    const emitted: string[] = [];
    const filter = createVisibleChunkFilter((t) => emitted.push(t));

    filter.push("OK! ");
    // Simulate character-by-character streaming — the tag is split across
    // 20+ individual chunks. The filter must buffer enough to catch it.
    for (const c of "<generation_context>") filter.push(c);
    filter.push("\ngoal: x\n</generation_context>");
    filter.flush();

    expect(emitted.join("")).toBe("OK! ");
    expect(filter.wasStopped()).toBe(true);
  });

  it("does not emit the uncertain tail until flush when no tag seen", () => {
    const emitted: string[] = [];
    const filter = createVisibleChunkFilter((t) => emitted.push(t));

    // First push is long enough that some is emitted immediately, tail held.
    filter.push("A".repeat(30));
    // Held-back tail should still be under the filter's internal buffer.
    expect(emitted.join("").length).toBeLessThan(30);

    // Flush releases the rest.
    filter.flush();
    expect(emitted.join("")).toBe("A".repeat(30));
  });

  it("treats text after the tag as dropped (never emitted even on flush)", () => {
    const emitted: string[] = [];
    const filter = createVisibleChunkFilter((t) => emitted.push(t));

    filter.push("Visible. <generation_context>\nhidden\n</generation_context>\nmore hidden");
    filter.flush();

    expect(emitted.join("")).toBe("Visible. ");
  });

  it("accumulates the full raw text regardless of forwarding state", () => {
    const emitted: string[] = [];
    const filter = createVisibleChunkFilter((t) => emitted.push(t));

    const full = "Visible. <generation_context>\nhidden\n</generation_context>";
    for (const c of full) filter.push(c);

    expect(filter.getAccumulated()).toBe(full);
    expect(emitted.join("")).toBe("Visible. ");
  });

  it("picks the earliest tag when both appear (shouldn't happen, but is handled)", () => {
    const emitted: string[] = [];
    const filter = createVisibleChunkFilter((t) => emitted.push(t));

    // Hypothetical pathological case — only the earliest tag matters.
    filter.push("First part ");
    filter.push("<change_context>a</change_context> ");
    filter.push("<generation_context>b</generation_context>");
    filter.flush();

    expect(emitted.join("")).toBe("First part ");
  });

  it("idempotent: push after flush is a no-op when stopped", () => {
    const emitted: string[] = [];
    const filter = createVisibleChunkFilter((t) => emitted.push(t));

    filter.push("Hi. <generation_context>x</generation_context>");
    filter.flush();
    filter.push("should be ignored");
    filter.flush();

    expect(emitted.join("")).toBe("Hi. ");
  });
});

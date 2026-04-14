import { v4 as uuidv4 } from "uuid";

export function generateId(): string {
  return uuidv4();
}

export function now(): string {
  return new Date().toISOString();
}

// Cheap heuristic — chars/4 is the standard rule of thumb for English text.
// Replace with a proper tokenizer if/when we need precise budgeting.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

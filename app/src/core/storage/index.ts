import { FileStorage } from "./file-storage";
import { MemoryStorage } from "./memory-storage";
import type { IStorage } from "./interface";

// Singleton factory. Tests should bypass this and construct FileStorage /
// MemoryStorage directly with their own temp dirs — calling resetStorage()
// between tests is also an option but not required if tests use direct
// constructors.

let instance: IStorage | null = null;

export function getStorage(
  type: "file" | "memory" = "file",
  dataDir = "./data",
): IStorage {
  if (!instance) {
    instance = type === "file" ? new FileStorage(dataDir) : new MemoryStorage();
  }
  return instance;
}

export function resetStorage(): void {
  instance = null;
}

export { FileStorage, MemoryStorage };
export type { IStorage };
export type { ConversationSummary, PendingMessage } from "./interface";

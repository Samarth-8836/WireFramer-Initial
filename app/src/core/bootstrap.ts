import path from "node:path";

import { ContextBuilder, Summarizer } from "@core/context-builder";
import { OperationExecutor } from "@core/operation-executor";
import {
  PromptRegistry,
  registerPhase1Prompts,
  registerPhase2Prompts,
} from "@core/prompts";
import {
  Phase1HandlersImpl,
  Phase2HandlersImpl,
  SessionManager,
} from "@core/session-manager";
import { FileStorage } from "@core/storage";
import type { IStorage } from "@core/storage";

// Application bootstrap + singleton DI container.
//
// Next.js route handlers call `getSessionManager()` to get a shared
// SessionManager instance. Using a module-level singleton instead of
// per-request construction matters for two reasons:
//
//   1. Chat blocking lives on the SessionManager instance (Map<sessionId,
//      boolean>). Per-request instances would give every API call a fresh
//      empty map and defeat the point of the lock.
//
//   2. TokenTracker and Summarizer allocations are also per-instance.
//      Sharing them across requests keeps per-session totals coherent
//      across turns.
//
// The singleton is lazy so test suites that want a fresh container can
// call `resetBootstrapForTests()` between runs.

export interface BootstrapOptions {
  storage?: IStorage;
  dataDir?: string;
}

interface Bootstrapped {
  storage: IStorage;
  executor: OperationExecutor;
  promptRegistry: PromptRegistry;
  summarizer: Summarizer;
  contextBuilder: ContextBuilder;
  sessionManager: SessionManager;
}

let cached: Bootstrapped | null = null;

export function getSessionManager(options: BootstrapOptions = {}): SessionManager {
  return getBootstrap(options).sessionManager;
}

export function getBootstrap(options: BootstrapOptions = {}): Bootstrapped {
  if (cached) return cached;

  const dataDir = options.dataDir ?? path.resolve(process.cwd(), "data");
  const storage = options.storage ?? new FileStorage(dataDir);

  const executor = new OperationExecutor();

  const promptRegistry = new PromptRegistry();
  registerPhase1Prompts(promptRegistry);
  registerPhase2Prompts(promptRegistry);

  const summarizer = new Summarizer(executor);
  const contextBuilder = new ContextBuilder(
    storage,
    promptRegistry,
    summarizer,
  );

  const phase1Handlers = new Phase1HandlersImpl({
    storage,
    executor,
    contextBuilder,
    promptRegistry,
  });
  const phase2Handlers = new Phase2HandlersImpl({
    storage,
    executor,
    promptRegistry,
    dataDir,
  });

  const sessionManager = new SessionManager(storage, {
    phase1: phase1Handlers,
    phase2: phase2Handlers,
  });

  cached = {
    storage,
    executor,
    promptRegistry,
    summarizer,
    contextBuilder,
    sessionManager,
  };

  return cached;
}

// Drop the cached singleton. Only tests should call this; in production
// the singleton is shared for the lifetime of the process.
export function resetBootstrapForTests(): void {
  cached = null;
}

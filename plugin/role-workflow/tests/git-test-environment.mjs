import { devNull } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Isolate fixture Git subprocesses, preserving the parent agent's guard and user settings. */
export function gitTestEnvironment(base = process.env, overrides = {}) {
  const env = { ...base };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    // Guard/config integration tests deliberately install their own temporary configuration.
    ...overrides,
  };
}

// Python fixtures consume the same policy through this JSON boundary.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.stdout.write(JSON.stringify(gitTestEnvironment()));

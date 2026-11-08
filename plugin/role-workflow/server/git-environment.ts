/** Read remote refs without enabling Git's command-based ext transport. */
export const GIT_REMOTE_READ_OPTIONS = ["-c", "protocol.ext.allow=never"] as const;
export const GIT_REMOTE_QUERY_TIMEOUT_MS = 20_000;

/** The daemon's own environment must not point git at another repository or config. */
export function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of Object.keys(env)) {
    if (
      /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG(?:_.*)?)$/.test(
        key,
      )
    )
      delete env[key];
  }
  return env;
}

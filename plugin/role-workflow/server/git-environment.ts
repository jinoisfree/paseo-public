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

/** Bound a daemon response without changing its result or cancelling the underlying request. */
export function withBudget<T>(name: string, ms: number, response: T | PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Paseo 응답 시간 초과(${name}, ${Math.round(ms / 1000)}초)`)),
      ms,
    );
  });
  return Promise.race([Promise.resolve(response), expired]).finally(() => clearTimeout(timer));
}

/** Persisted contracts are capabilities, never a reason to migrate an existing conversation. */
export function capabilities(w: { contract?: number; mode: string }) {
  const current = (w.contract ?? 1) >= 4;
  const splitGeneral = w.contract === 3 && w.mode === "general";
  return {
    current,
    splitGeneral,
    automatic: w.mode === "federated" || splitGeneral,
    standalone: current && w.mode === "general",
    executorSelection: current && w.mode === "federated",
  };
}

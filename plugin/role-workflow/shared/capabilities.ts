export const CURRENT_CONTRACT = 7;

/** Persisted contracts are capabilities, never a reason to migrate an existing conversation. */
export function capabilities(w: { contract?: number; mode: string }) {
  const current = (w.contract ?? 1) >= 4;
  const splitGeneral = w.contract === 3 && w.mode === "general";
  return {
    current,
    planReview: (w.contract ?? 1) >= 7 && w.mode === "federated",
    brainstorm: (w.contract ?? 1) >= 6 && w.mode === "undecided",
    firstPlanGate: (w.contract ?? 1) >= 6 && w.mode === "federated",
    splitGeneral,
    automatic: w.mode === "federated" || splitGeneral,
    standalone: current && w.mode === "general",
    executorSelection: current && w.mode === "federated",
    // Contract 5 picks the executor on the plugin screen and holds an early plan until then.
    screenSelection: (w.contract ?? 1) >= 5 && w.mode === "federated",
  };
}

import { useSyncExternalStore } from "react";

let feedback = "";
const listeners = new Set<() => void>();
export function reportControl(message: string) {
  feedback = message;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useControlFeedback() {
  return useSyncExternalStore(subscribe, () => feedback);
}

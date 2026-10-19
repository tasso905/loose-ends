"use client";
import { useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/**
 * False in the server render and until React hydrates. Forms whose action is a client function
 * cannot submit before then (React ignores the submit), so their buttons wait for this instead of
 * swallowing a click silently.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(noSubscribe, () => true, () => false);
}

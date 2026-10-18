import type { ItemType, Owner } from "@/lib/ai/schema";
import type { ThreadKind, ThreadStatus } from "@/lib/schemas";

/**
 * Item type → thread kind mapping (PRD "Item type → thread kind mapping", Decision D5).
 * Returns null for `key_fact`, which never becomes a thread.
 */
export function threadKindFor(type: ItemType, owner: Owner): { kind: ThreadKind; status: ThreadStatus } | null {
  switch (type) {
    case "commitment":
      // owner = other: someone else promised it, so the user is waiting on them.
      return owner === "other" ? { kind: "waiting_on", status: "waiting" } : { kind: "commitment", status: "open" };
    case "request":
      return { kind: "request", status: "open" };
    case "waiting_on":
      return { kind: "waiting_on", status: "waiting" };
    case "deadline":
      return { kind: "admin", status: "open" };
    case "intention":
      return { kind: "commitment", status: "open" };
    case "decision":
      return { kind: "decision", status: "open" };
    case "key_fact":
      return null;
  }
}

/** Initial status for a thread of a given kind created from a proposal. */
export function initialStatusForKind(kind: ThreadKind): ThreadStatus {
  return kind === "waiting_on" ? "waiting" : "open";
}

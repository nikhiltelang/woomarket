import type { WorkKind } from "@shared/queue";

/** Asks a worker to look for new work now, instead of at its next tick (set by the queue manager). */
let impl: (kind: WorkKind) => void = () => {};
export const wakeWork = (kind: WorkKind) => impl(kind);
export const setWakeImpl = (fn: (kind: WorkKind) => void) => {
  impl = fn;
};

import { AsyncLocalStorage } from "node:async_hooks";

interface ChildLoadContainer {
  readonly storage: AsyncLocalStorage<boolean>;
}

const CHILD_LOAD_CONTEXT_KEY = Symbol.for("pi-subagents-lite.child-extension-load.v1");
const realm = globalThis as typeof globalThis & { [key: symbol]: unknown };
const existing = realm[CHILD_LOAD_CONTEXT_KEY];
const container: ChildLoadContainer =
  existing && typeof existing === "object" && "storage" in existing
    ? (existing as ChildLoadContainer)
    : { storage: new AsyncLocalStorage<boolean>() };

if (container !== existing) {
  realm[CHILD_LOAD_CONTEXT_KEY] = container;
}

/** True only while this extension's own child resource loading is marked. */
export function isChildExtensionLoad(): boolean {
  return container.storage.getStore() === true;
}

/** Run a loader boundary with an explicit child/parent marker. */
export function withChildExtensionLoad<T>(marked: boolean, fn: () => T): T {
  return container.storage.run(marked, fn);
}

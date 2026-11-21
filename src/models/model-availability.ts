import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findModelInRegistry } from "../utils.ts";

export function findAvailableModel(name: string, registry: ExtensionContext["modelRegistry"]) {
  const model = findModelInRegistry(name, registry, undefined);
  return model && registry.getAvailable().some((entry) => entry.provider === model.provider && entry.id === model.id)
    ? model
    : undefined;
}

export interface ConfiguredModelResolution {
  model: ExtensionContext["model"];
  unavailable: boolean;
}

/** A configured choice may fall back to the current parent; an explicit choice may not. */
export function resolveConfiguredModel(
  name: string | undefined,
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
): ConfiguredModelResolution {
  const parent = ctx.model;
  if (!name) return { model: parent, unavailable: false };
  const model = findAvailableModel(name, ctx.modelRegistry);
  // Keep the active parent object even if the registry has a different object for the same ID.
  return {
    model: parent && name === `${parent.provider}/${parent.id}` ? parent : (model ?? parent),
    unavailable: !model,
  };
}

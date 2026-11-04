import { describe, expect, it } from "vite-plus/test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { prepareSpawnIntent } from "../../src/spawn/spawn-preparation.js";

describe("prepareSpawnIntent", () => {
  const model = { provider: "test-provider", id: "test-model" } as Model<Api>;

  it("builds invocation metadata from the resolved run values", () => {
    const signal = new AbortController().signal;
    const intent = prepareSpawnIntent({
      type: "builder",
      prompt: "Inspect the project",
      description: "Inspect the project",
      model,
      modelKey: "test-provider/test-model",
      maxTurns: 4,
      maxTokens: 256,
      thinkingLevel: "high",
      graceTurns: 1,
      worktreePath: "/tmp/project",
      worktreeLabel: "project",
      projectTrusted: true,
      runInBackground: false,
      signal,
    });

    expect(intent).toMatchObject({
      type: "builder",
      prompt: "Inspect the project",
      description: "Inspect the project",
      model,
      modelKey: "test-provider/test-model",
      maxTurns: 4,
      maxTokens: 256,
      thinkingLevel: "high",
      graceTurns: 1,
      worktreePath: "/tmp/project",
      worktreeLabel: "project",
      projectTrusted: true,
      runInBackground: false,
      signal,
    });
    expect(intent.invocation).toEqual({
      modelName: "test-model",
      thinkingLevel: "high",
      maxTurns: 4,
    });
  });

  it("preserves menu run-mode metadata when requested", () => {
    const background = prepareSpawnIntent({
      type: "builder",
      prompt: "Run in the background",
      description: "Run in the background",
      model,
      maxTurns: undefined,
      thinkingLevel: undefined,
      graceTurns: 0,
      runInBackground: true,
      includeRunModeInInvocation: true,
    });

    expect(background.invocation).toEqual({
      modelName: "test-model",
      thinkingLevel: undefined,
      maxTurns: undefined,
      runInBackground: true,
    });
  });

  it("does not mutate the preparation input", () => {
    const input = {
      type: "builder",
      prompt: "Keep the input unchanged",
      description: "Keep the input unchanged",
      model,
      maxTurns: 2,
      thinkingLevel: "low" as const,
      graceTurns: 0,
      runInBackground: true,
    };
    const snapshot = { ...input };

    prepareSpawnIntent(input);

    expect(input).toEqual(snapshot);
  });
});

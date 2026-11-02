import { parent, emit, spawn } from "./instance-fixtures.js";
import { scanAgentFilesInDir } from "../src/agents/agent-discovery.js";
import { describe, expect, it, vi } from "vite-plus/test";
import { fakeCtx, createMockExtensionAPI } from "./fixtures.js";
import factory from "../src/index.js";
import { withChildExtensionLoad } from "../src/child-load-context.js";
import { asExtensionAPI } from "./pi-boundaries.js";

function expectResult(api: ReturnType<typeof parent>["api"], deliverAs: "followUp" | "steer") {
  expect(api.api.sendMessage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ customType: "subagent-result", content: expect.stringContaining("A finished work") }),
    { deliverAs, triggerTurn: true },
  );
}

describe("session-bound completion notifications", () => {
  it.each([
    { idle: true, deliverAs: "followUp" as const },
    { idle: false, deliverAs: "steer" as const },
  ])("keeps the bound parent after an unbound factory reload ($deliverAs)", async ({ idle, deliverAs }) => {
    const a = parent();
    const ctx = await emit(a, "session_start", fakeCtx({ hasUI: false, isIdle: () => idle }));
    await spawn(a, ctx);

    const b = parent();
    b.api.api.sendMessage.mockImplementation(() => {
      throw new Error("Extension runtime not initialized");
    });
    await vi.advanceTimersByTimeAsync(200);

    expectResult(a.api, deliverAs);
    expect(b.api.api.sendMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("keeps A's queued notification on A while B awaits discovery", async () => {
    const a = parent();
    const ctx = await emit(a, "session_start", fakeCtx({ hasUI: false, isIdle: () => true }));
    await spawn(a, ctx);

    const b = parent();
    let releaseScan!: (value: Awaited<ReturnType<typeof scanAgentFilesInDir>>) => void;
    vi.mocked(scanAgentFilesInDir).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseScan = resolve;
      }),
    );
    const starting = emit(b, "session_start", fakeCtx({ hasUI: false, isIdle: () => false }));
    try {
      await vi.advanceTimersByTimeAsync(200);
      expectResult(a.api, "followUp");
      expect(b.api.api.sendMessage).not.toHaveBeenCalled();
    } finally {
      releaseScan([]);
      await starting;
    }
  });

  it("keeps child factories inert during marked child loading", async () => {
    const a = parent();
    const ctx = await emit(a, "session_start");
    await spawn(a, ctx);
    const child = createMockExtensionAPI();
    withChildExtensionLoad(true, () => factory(asExtensionAPI(child.api)));
    await vi.advanceTimersByTimeAsync(200);
    expect(child.listeners).toEqual([]);
    expectResult(a.api, "followUp");
    expect(child.api.sendMessage).not.toHaveBeenCalled();
  });
});

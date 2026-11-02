import { describe, expect, it } from "vite-plus/test";
import { isChildExtensionLoad, withChildExtensionLoad } from "../src/child-load-context.js";

describe("child extension load context", () => {
  it("is unmarked by default and restores after a synchronous scope", () => {
    expect(isChildExtensionLoad()).toBe(false);
    expect(withChildExtensionLoad(true, () => isChildExtensionLoad())).toBe(true);
    expect(isChildExtensionLoad()).toBe(false);
  });

  it("propagates through async work and restores after rejection", async () => {
    await expect(
      withChildExtensionLoad(true, async () => {
        await Promise.resolve();
        expect(isChildExtensionLoad()).toBe(true);
        throw new Error("load failed");
      }),
    ).rejects.toThrow("load failed");
    expect(isChildExtensionLoad()).toBe(false);
  });

  it("allows an explicit unmarked parent callback inside a marked chain", () => {
    withChildExtensionLoad(true, () => {
      expect(isChildExtensionLoad()).toBe(true);
      withChildExtensionLoad(false, () => {
        expect(isChildExtensionLoad()).toBe(false);
      });
      expect(isChildExtensionLoad()).toBe(true);
    });
  });

  it("keeps concurrent marked and unmarked chains independent", async () => {
    let releaseMarked!: () => void;
    let releaseUnmarked!: () => void;
    const markedGate = new Promise<void>((resolve) => {
      releaseMarked = resolve;
    });
    const unmarkedGate = new Promise<void>((resolve) => {
      releaseUnmarked = resolve;
    });

    const marked = withChildExtensionLoad(true, async () => {
      await markedGate;
      return isChildExtensionLoad();
    });
    const unmarked = withChildExtensionLoad(false, async () => {
      await unmarkedGate;
      return isChildExtensionLoad();
    });

    releaseUnmarked();
    await expect(unmarked).resolves.toBe(false);
    releaseMarked();
    await expect(marked).resolves.toBe(true);
    expect(isChildExtensionLoad()).toBe(false);
  });
});

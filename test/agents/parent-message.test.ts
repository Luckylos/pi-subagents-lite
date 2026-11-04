/**
 * parent-message.test.ts — The MessageParent tool a background Subagent holds.
 */

import { describe, it, expect, vi } from "vite-plus/test";
import {
  PARENT_MESSAGE_LIMIT,
  PARENT_MESSAGE_TOOL_NAME,
  createParentMessageTool,
} from "../../src/agents/parent-message.js";

function makeTool(opts: { delivered?: boolean } = {}) {
  let run = 0;
  const deliver = vi.fn((_text: string) => opts.delivered ?? true);
  const tool = createParentMessageTool({ deliver, runKey: () => run });
  const send = (message: string) => tool.execute("call", { message }, undefined, undefined, undefined as never);
  return { tool, deliver, send, nextRun: () => run++ };
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((c) => c.text ?? "").join("");

describe("MessageParent tool", () => {
  it("is named MessageParent and takes only a message", () => {
    const { tool } = makeTool();
    expect(tool.name).toBe(PARENT_MESSAGE_TOOL_NAME);
    expect(tool.name).toBe("MessageParent");
    expect(Object.keys((tool.parameters as { properties: object }).properties)).toEqual(["message"]);
    expect(tool.description.length).toBeGreaterThan(1);
  });

  it("delivers the trimmed message and confirms delivery", async () => {
    const { deliver, send } = makeTool();
    const result = await send("  found the bug  \n");
    expect(deliver).toHaveBeenCalledWith("found the bug");
    expect(textOf(result)).toBe("Delivered to the parent session.");
  });

  it("rejects a blank message without delivering", async () => {
    const { deliver, send } = makeTool();
    await expect(send("  \n ")).rejects.toThrow("message is required");
    expect(deliver).not.toHaveBeenCalled();
  });

  it(`stops after ${PARENT_MESSAGE_LIMIT} delivered messages in one run`, async () => {
    const { deliver, send } = makeTool();
    for (let i = 0; i < PARENT_MESSAGE_LIMIT; i++) await send(`m${i}`);
    await expect(send("one more")).rejects.toThrow(
      `Parent message limit (${PARENT_MESSAGE_LIMIT}) reached for this run; put the rest in your final answer.`,
    );
    expect(deliver).toHaveBeenCalledTimes(PARENT_MESSAGE_LIMIT);
  });

  it("restores the allowance when a new run starts", async () => {
    const { deliver, send, nextRun } = makeTool();
    for (let i = 0; i < PARENT_MESSAGE_LIMIT; i++) await send(`m${i}`);
    nextRun();
    await send("after continuation");
    expect(deliver).toHaveBeenLastCalledWith("after continuation");
  });

  it("reports an undelivered message and does not count it", async () => {
    const failing = makeTool({ delivered: false });
    await expect(failing.send("hello")).rejects.toThrow("Not delivered: the parent session is unavailable.");

    let ok = false;
    const deliver = vi.fn(() => ok);
    const tool = createParentMessageTool({ deliver, runKey: () => 0 });
    const send = (m: string) => tool.execute("c", { message: m }, undefined, undefined, undefined as never);
    for (let i = 0; i < PARENT_MESSAGE_LIMIT; i++) await expect(send("x")).rejects.toThrow("Not delivered");
    ok = true;
    await expect(send("now it works")).resolves.toBeDefined();
  });
});

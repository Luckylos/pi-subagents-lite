/**
 * output-file.ts — Human-readable output logging for agent transcripts.
 *
 * Path: /tmp/pi-agent-outputs/<agentId>.log
 * Append-only, human-readable, supports `tail -f`.
 * Lines: [USER], [TOOL], [ASSISTANT], [DONE] with ISO timestamps.
 */

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join, resolve } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { formatTokens } from "./usage.ts";
import { summarizeToolArgs } from "../utils.ts";

/** Punctuation treated as a flush boundary when streaming thinking deltas. */
const SENTENCE_BOUNDARY_CHARS = ".!?,\n";

function findLastSentenceBoundary(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (SENTENCE_BOUNDARY_CHARS.includes(text[i])) {
      return i;
    }
  }
  return -1;
}

function formatDoneLine(stats: OutputFinalStats): string {
  const tokensStr = `${formatTokens(stats.totalTokens)} tokens`;
  return `${timestamp()} [DONE] ${stats.turnCount} turns, ${stats.toolUseCount} tool uses, ${tokensStr}\n`;
}
/** Max content length for full tool result display — longer results get a summary line. */
const MAX_TOOL_RESULT_DISPLAY_LENGTH = 500;

function timestamp(): string {
  return new Date().toISOString();
}

/** Fail closed before touching the filesystem when private POSIX I/O is unavailable. */
function privateOutputUid(): number {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const flags = [constants.O_NOFOLLOW, constants.O_DIRECTORY, constants.O_NONBLOCK];
  if (
    uid === undefined ||
    !Number.isInteger(uid) ||
    uid < 0 ||
    uid >= 0xffffffff ||
    flags.some((flag) => !Number.isInteger(flag) || flag <= 0 || flag > 0x7fffffff)
  ) {
    throw new Error(
      "Private output transcripts are unsupported on this platform: POSIX UID and nonzero O_NOFOLLOW/O_DIRECTORY/O_NONBLOCK flags are required.",
    );
  }
  return uid;
}

/** Validate the object actually opened before changing permissions or writing. */
function assertOwnedDirectory(stats: Stats, uid: number): void {
  if (!stats.isDirectory() || stats.uid !== uid) {
    throw new Error("Output directory must be a real directory owned by the current user.");
  }
}

function assertPrivateFile(stats: Stats, uid: number): void {
  if (!stats.isFile() || stats.uid !== uid || (stats.mode & 0o077) !== 0 || stats.nlink !== 1) {
    throw new Error("Output log must be a private, singly linked regular file owned by the current user.");
  }
}

/**
 * Create the output file path, ensuring the parent dir exists (0o700).
 * @param baseDir - Overrides the default /tmp/pi-agent-outputs; used for testability.
 */
export function createOutputFilePath(agentId: string, baseDir?: string): string {
  const uid = privateOutputUid();
  const dir = baseDir ?? "/tmp/pi-agent-outputs";
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Kernel flags reject directory symlinks and non-directories without chmod-ing their targets.
  // Resolve trailing separators/dot segments so NOFOLLOW applies to the final directory itself.
  const fd = openSync(resolve(dir), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    assertOwnedDirectory(fstatSync(fd), uid);
    fchmodSync(fd, 0o700);
    const stats = fstatSync(fd);
    assertOwnedDirectory(stats, uid);
    if ((stats.mode & 0o7777) !== 0o700) throw new Error("Output directory must have mode 0700.");
  } finally {
    closeSync(fd);
  }
  return join(dir, `${agentId}.log`);
}

export function writeInitialEntry(path: string, prompt: string): void {
  const uid = privateOutputUid();
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    assertPrivateFile(fstatSync(fd), uid);
    // Creation mode is filtered by umask. Later appends reopen this file for writing.
    fchmodSync(fd, 0o600);
    const ready = fstatSync(fd);
    assertPrivateFile(ready, uid);
    if ((ready.mode & 0o7777) !== 0o600) throw new Error("Output log must have mode 0600 at creation.");
    writeFileSync(fd, `${timestamp()} [USER] ${prompt}\n`, "utf-8");
  } finally {
    closeSync(fd);
  }
}

/** Best-effort append that never throws or recreates a missing log. */
function safeAppend(path: string, content: string): void {
  try {
    const uid = privateOutputUid();
    // Reject devices/FIFOs before opening; NONBLOCK also avoids hanging if replaced with a FIFO.
    const before = lstatSync(path);
    assertPrivateFile(before, uid);
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      assertPrivateFile(opened, uid);
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("Output log changed while opening.");
      writeFileSync(fd, content, "utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    /* ignore unsafe paths and write errors */
  }
}

/**
 * Live thinking-block streaming state for the output file.
 *
 * Thinking deltas accumulate in a buffer. Once the buffer reaches the
 * configured size it flushes at the nearest sentence boundary (or at the
 * limit when none exists). thinking_end carries the full block, so the
 * streamed character count deduplicates the tail. turn_end flushes the
 * tail and marks any in-progress block as streamed so the message replay
 * in flush() skips it.
 */
class ThinkingStreamer {
  private buffer = "";
  /** Total chars streamed for the current block; deduplicates thinking_end. */
  private streamedChars = 0;
  /** Thinking blocks written live; skipped in the final message replay. */
  private streamedBlocks = 0;
  private blockInProgress = false;

  constructor(
    private readonly path: string,
    private readonly bufferSize: number,
  ) {}

  onStart(): void {
    this.streamedChars = 0;
    this.blockInProgress = true;
  }

  onDelta(delta: string): void {
    this.buffer += delta;
    if (this.buffer.length < this.bufferSize) return;
    // Round down to nearest sentence boundary when possible
    const boundary = findLastSentenceBoundary(this.buffer);
    if (boundary >= 0) {
      const flushText = this.buffer.slice(0, boundary + 1);
      this.buffer = this.buffer.slice(boundary + 1);
      this.append(`${timestamp()} [THINKING] ${flushText}\n`);
      this.streamedChars += flushText.length;
    } else {
      // No sentence boundary found, flush at buffer limit
      this.flushTail();
    }
  }

  /**
   * Complete a block. thinking_end carries the full block: flush the
   * buffered tail first (counted in streamedChars), then stream whatever
   * remains.
   */
  onEnd(fullContent?: string): void {
    this.flushTail();
    if (fullContent && fullContent.length > this.streamedChars) {
      const remaining = fullContent.slice(this.streamedChars);
      this.append(`${timestamp()} [THINKING] ${remaining}\n`);
      this.streamedChars = fullContent.length;
    }
    this.streamedBlocks++;
    this.blockInProgress = false;
  }

  /**
   * End of turn: flush the tail, and if thinking_end never fired treat the
   * in-progress block as streamed so the message replay skips it.
   */
  endTurn(): void {
    this.flushTail();
    if (this.blockInProgress) {
      this.streamedBlocks++;
      this.blockInProgress = false;
    }
  }

  flushTail(): void {
    if (this.buffer.length === 0) return;
    this.append(`${timestamp()} [THINKING] ${this.buffer}\n`);
    this.streamedChars += this.buffer.length;
    this.buffer = "";
  }

  get blocksStreamed(): number {
    return this.streamedBlocks;
  }

  private append(content: string): void {
    safeAppend(this.path, content);
  }
}

function splitAndPrefix(text: string, role: string): string {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => `${timestamp()} [${role}] ${l}\n`)
    .join("");
}

function formatToolItem(item: Record<string, unknown>): string {
  const name = (item.name ?? item.toolName ?? "unknown") as string;
  // pi-ai ToolCall uses `arguments`, legacy/anthropic format uses `input`
  const rawArgs = (item.arguments ?? item.input) as Record<string, unknown> | undefined;
  const argsStr = summarizeToolArgs(name, rawArgs);
  return `${timestamp()} [TOOL] ${name}${argsStr}\n`;
}

function extractUserText(content: string | ReadonlyArray<Record<string, unknown>> | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => String(c.text ?? "")).join("\n");
  }
  return "";
}

function formatToolResult(toolName: string, content: ReadonlyArray<Record<string, unknown>> | undefined): string {
  if (!content || !Array.isArray(content)) return "";

  const text = content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");

  if (text.length > MAX_TOOL_RESULT_DISPLAY_LENGTH) {
    return `${timestamp()} [TOOL_RESULT] ${toolName}: ${text.length} chars\n`;
  }

  if (!text.trim()) return "";

  return splitAndPrefix(text, "TOOL_RESULT");
}

function formatMessageLine(
  content: string | ReadonlyArray<Record<string, unknown>> | undefined,
  skipStreamedThinkingBlocks: number = 0,
): string {
  if (typeof content === "string") {
    return splitAndPrefix(content, "ASSISTANT");
  }

  if (Array.isArray(content)) {
    let thinkingSkipped = 0;
    return content
      .map((item) => {
        if (item.type === "text" && typeof item.text === "string") {
          return splitAndPrefix(item.text, "ASSISTANT");
        }
        if (item.type === "toolUse" || item.type === "toolCall") {
          return formatToolItem(item);
        }
        if (item.type === "thinking" && typeof item.thinking === "string") {
          if (thinkingSkipped < skipStreamedThinkingBlocks) {
            thinkingSkipped++;
            return ""; // Already streamed, skip
          }
          const text = item.redacted ? "[redacted]" : item.thinking;
          return splitAndPrefix(text, "THINKING");
        }
        return "";
      })
      .join("");
  }

  return "";
}
/**
 * Stream session messages to the file on each turn_end. The returned cleanup
 * writes the DONE line and unsubscribes.
 */
export function streamToOutputFile(
  session: AgentSession,
  path: string,
  stats?: OutputFinalStats,
  bufferSize: number = 0,
): () => void {
  let writtenCount = 0;
  let lastWritten: AgentSession["messages"][number] | undefined;
  const written = new WeakSet<object>();
  const thinking = new ThinkingStreamer(path, bufferSize);

  const flush = () => {
    const messages = session.messages;
    if (messages.length === 0) return;
    if (!lastWritten) written.add(messages[0]); // initial user prompt already written
    // Compaction rebuilds the projection but keeps the retained message objects.
    if (messages[writtenCount - 1] !== lastWritten) writtenCount = 0;
    while (writtenCount < messages.length) {
      const msg = messages[writtenCount++];
      lastWritten = msg;
      if (written.has(msg)) continue;
      written.add(msg);
      if (msg.role === "assistant") {
        const lines = formatMessageLine(msg.content as any, thinking.blocksStreamed);
        if (lines) safeAppend(path, lines);
      } else if (msg.role === "user") {
        const text = extractUserText(msg.content as any);
        if (text.trim()) {
          safeAppend(path, `${timestamp()} [USER] ${text}\n`);
        }
      } else if (msg.role === "toolResult") {
        const msgAny = msg as unknown as Record<string, unknown>;
        const lines = formatToolResult(
          (msgAny.toolName ?? "unknown") as string,
          msgAny.content as ReadonlyArray<Record<string, unknown>> | undefined,
        );
        if (lines) safeAppend(path, lines);
      }
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      thinking.endTurn();
      flush();
    }

    // Flush before compaction runs so any not-yet-flushed tail still reaches the file
    if (event.type === "compaction_start") {
      flush();
    }

    if (bufferSize > 0 && event.type === "message_update") {
      const assistantEvent = event.assistantMessageEvent;
      if (assistantEvent.type === "thinking_start") {
        thinking.onStart();
      } else if (assistantEvent.type === "thinking_delta") {
        thinking.onDelta(assistantEvent.delta);
      } else if (assistantEvent.type === "thinking_end") {
        thinking.onEnd(assistantEvent.content);
      }
    }
  });

  return () => {
    thinking.flushTail();
    flush();

    const doneStats = stats ?? { turnCount: 0, toolUseCount: 0, totalTokens: 0 };
    safeAppend(path, formatDoneLine(doneStats));

    unsubscribe();
  };
}

// ---------------------------------------------------------------------------
//  AgentOutputLog — lifecycle wrapper for per-agent output streaming
// ---------------------------------------------------------------------------

/** Final stats written to the DONE line at agent completion. */
export interface OutputFinalStats {
  turnCount: number;
  toolUseCount: number;
  totalTokens: number;
}

/**
 * Manages a single agent's output log lifecycle: create path → write initial
 * entry → attach session stream → finalize with stats → close.
 *
 * The manager holds one instance per agent. At spawn time the constructor
 * creates the file and writes the [USER] entry. When the session is ready,
 * `attach()` subscribes to streaming events. At completion, `finalize()`
 * flushes remaining messages, writes the [DONE] line, and unsubscribes.
 */
export class AgentOutputLog {
  readonly path: string;
  private cleanup?: () => void;
  private statsRef?: OutputFinalStats;
  private bufferSize: number;

  constructor(agentId: string, prompt: string, baseDir?: string, bufferSize: number = 0) {
    this.path = createOutputFilePath(agentId, baseDir);
    writeInitialEntry(this.path, prompt);
    this.bufferSize = bufferSize;
  }

  /**
   * Subscribe to session events so messages stream to the output file.
   * Internally passes a mutable stats reference that `finalize()` populates
   * before the DONE line is written.
   */
  attach(session: AgentSession): void {
    this.statsRef = { turnCount: 0, toolUseCount: 0, totalTokens: 0 };
    this.cleanup = streamToOutputFile(session, this.path, this.statsRef, this.bufferSize);
  }

  /**
   * Flush remaining messages, write the [DONE] line with final stats,
   * and unsubscribe from session events.
   *
   * Safe to call without a prior `attach()` — writes the DONE line only.
   */
  finalize(stats: OutputFinalStats): void {
    if (this.cleanup && this.statsRef) {
      // Populate the mutable stats ref so streamToOutputFile's cleanup
      // writes the actual final values to the DONE line.
      this.statsRef.turnCount = stats.turnCount;
      this.statsRef.toolUseCount = stats.toolUseCount;
      this.statsRef.totalTokens = stats.totalTokens;
      this.cleanup();
      this.cleanup = undefined;
      this.statsRef = undefined;
    } else {
      // No attach was called — write DONE directly
      safeAppend(this.path, formatDoneLine(stats));
    }
  }
}

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionOwner } from "../shell.ts";
import { SHORT_ID_LENGTH, type AgentRecord } from "../types.ts";
import { getDisplayName } from "./format.ts";
import { plainText } from "./sanitize.ts";

export function summarizeRunText(text: string): string {
  const firstLine = plainText(text).trim().split("\n", 1)[0] ?? "";
  return truncateToWidth(firstLine, 60);
}

export async function showRunTextViewer(
  owner: ExtensionOwner,
  ui: Pick<ExtensionUIContext, "custom">,
  record: AgentRecord,
  kind: "result" | "error",
  text: string,
  runSequence: number | undefined,
  presentation: "editor" | "overlay" = "overlay",
): Promise<void> {
  const shortId = record.id.slice(0, SHORT_ID_LENGTH);
  const label = kind === "result" ? shortId : "Error";
  const titleSuffix = runSequence === undefined ? label : `${label} · Run ${runSequence}`;
  const content = plainText(text);
  let textLines: string[] = [];
  let wrappedWidth: number | undefined;
  const displayName = getDisplayName(owner, record.display.type);
  const chromeLines = 5; // top border + title + sep + footer + bottom border
  const MIN_VIEWPORT = 3;
  const VIEWPORT_HEIGHT_PCT = 70;
  let scrollOffset = 0;
  let autoScroll = presentation === "overlay";
  let closed = false;

  await ui.custom<void>(
    (tui, theme, _kb, done) => {
      const border = theme.fg("border", "│");

      const viewportHeight = () => {
        const maxRows = Math.floor((tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
        return Math.max(MIN_VIEWPORT, maxRows - chromeLines);
      };

      return {
        invalidate() {},
        render(width: number) {
          const innerW = width - 4;
          if (innerW !== wrappedWidth) {
            textLines = wrapTextWithAnsi(content, Math.max(1, innerW));
            wrappedWidth = innerW;
          }
          const out: string[] = [theme.fg("border", `\u256d${"\u2500".repeat(width - 2)}\u256e`)];

          // Title row: │ name · suffix pad │
          const titleStr = theme.bold(theme.fg("accent", `${displayName} \u00b7 ${titleSuffix}`));
          const titlePad = Math.max(0, innerW - visibleWidth(titleStr));
          out.push(`${border} ${truncateToWidth(titleStr + " ".repeat(titlePad), innerW, "...", true)} ${border}`);

          // Separator
          out.push(`${border} ${theme.fg("dim", "\u2500".repeat(innerW))} ${border}`);

          // Content with scrolling
          const vp = viewportHeight();
          const maxScroll = Math.max(0, textLines.length - vp);
          if (autoScroll) scrollOffset = maxScroll;
          const vs = Math.min(scrollOffset, maxScroll);
          const visible = textLines.slice(vs, vs + vp);

          for (let i = 0; i < vp; i++) {
            const line = visible[i] ?? "";
            const truncated = truncateToWidth(line, innerW, "...", true);
            const padLen = Math.max(0, innerW - visibleWidth(truncated));
            out.push(`${border} ${truncated}${" ".repeat(padLen)} ${border}`);
          }

          // Footer
          const scrollPct = textLines.length <= vp ? "100%" : `${Math.round(((vs + vp) / textLines.length) * 100)}%`;
          const count = theme.fg("dim", `${textLines.length} lines \u00b7 ${scrollPct}`);
          const footerText = theme.fg("dim", "q/Esc close");
          const gap = Math.max(1, innerW - visibleWidth(count) - visibleWidth(footerText));
          out.push(`${border} ${count}${" ".repeat(gap)}${footerText} ${border}`);

          out.push(theme.fg("border", `\u2570${"\u2500".repeat(width - 2)}\u256f`));
          return out;
        },
        handleMouse(event) {
          const vp = viewportHeight();
          const delta = event.wheelDelta ?? 0;
          if (closed || event.type !== "wheel" || !delta || event.y < 3 || event.y >= 3 + vp) return undefined;
          const maxScroll = Math.max(0, textLines.length - vp);
          const current = autoScroll ? maxScroll : Math.min(scrollOffset, maxScroll);
          scrollOffset = Math.max(0, Math.min(maxScroll, current + delta));
          autoScroll = scrollOffset === maxScroll;
          return { handled: true, render: scrollOffset !== current };
        },
        handleInput(data: string) {
          if (closed) return;
          if (matchesKey(data, "q") || matchesKey(data, "escape")) {
            closed = true;
            done();
            return;
          }

          const vp = viewportHeight();
          const maxScroll = Math.max(0, textLines.length - vp);

          if (matchesKey(data, "up")) {
            scrollOffset = Math.max(0, scrollOffset - 1);
            autoScroll = scrollOffset >= maxScroll;
          } else if (matchesKey(data, "down")) {
            scrollOffset = Math.min(maxScroll, scrollOffset + 1);
            autoScroll = scrollOffset >= maxScroll;
          } else if (matchesKey(data, "pageUp")) {
            scrollOffset = Math.max(0, scrollOffset - vp);
            autoScroll = false;
          } else if (matchesKey(data, "pageDown")) {
            scrollOffset = Math.min(maxScroll, scrollOffset + vp);
            autoScroll = scrollOffset >= maxScroll;
          } else if (matchesKey(data, "home") || data === "g") {
            scrollOffset = 0;
            autoScroll = false;
          } else if (data === "G") {
            scrollOffset = maxScroll;
            autoScroll = true;
          }
        },
      };
    },
    presentation === "overlay" ? { overlay: true } : undefined,
  );
}

/**
 * numeric-input-submenu.ts — Shared input submenu Components.
 *
 * - createNumericSubmenu: numeric input with validation
 * - createInputSubmenu: plain text input
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, type Component } from "@earendil-works/pi-tui";

import { errorMessage } from "../../../utils.ts";
import { plainText } from "../../sanitize.ts";
import { validateNumeric } from "../helpers.ts";

/**
 * Returns a `(initialValue, done) => submenu` function wired to
 * `ctx.ui.notify` for errors. When `required`, empty input errors;
 * otherwise empty input calls `done()` to clear.
 */
export function createNumericSubmenu(
  ctx: ExtensionCommandContext,
  optionsOrCallback?:
    | { min?: number; required?: boolean; default?: number; integer?: boolean }
    | ((parsed: number) => void),
  onValid?: (parsed: number) => void,
  onEmpty?: () => void,
): (initialValue: string, done: (selectedValue?: string) => void) => Component {
  const opts =
    typeof optionsOrCallback === "function" ? { onValid: optionsOrCallback } : { onValid, ...optionsOrCallback };
  const min = opts.min ?? 1;
  const required = opts.required ?? false;
  const fmtLabel = (n: number) => (n === 0 ? "\u2265 0" : `\u2265 ${n}`);
  const invalidValue = () =>
    ctx.ui.notify(`Invalid value \u2014 must be ${opts.integer ? "an integer" : "a number"} ${fmtLabel(min)}`, "error");

  return (initialValue, done) => {
    const input = new Input();
    input.setValue(initialValue === "(not set)" ? "" : initialValue);
    const commit = (save: () => void, label: string) => {
      try {
        save();
      } catch (error) {
        ctx.ui.notify(plainText(errorMessage(error)), "error");
        return;
      }
      done(label);
    };
    input.onSubmit = (value) => {
      const trimmed = value.trim();
      if (!trimmed || /^unlimited$/i.test(trimmed)) {
        if (required) {
          invalidValue();
          return;
        }
        const fallback = opts.default;
        if (fallback != null) commit(() => opts.onValid?.(fallback), String(fallback));
        else commit(() => onEmpty?.(), "(not set)");
        return;
      }
      const parsed = validateNumeric(trimmed, min);
      if (parsed === undefined || (opts.integer && (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(parsed)))) {
        invalidValue();
        return;
      }
      commit(() => opts.onValid?.(parsed), String(parsed));
    };
    input.onEscape = () => done();
    return input;
  };
}

/**
 * `(initialValue, done) => Input` for plain-text submenus. When `required`,
 * empty input errors; otherwise empty input calls `done()` to clear.
 */
export function createInputSubmenu(
  ctx: ExtensionCommandContext,
  options?: { required?: boolean },
): (initialValue: string, done: (value?: string) => void) => Input {
  return (initialValue, done) => {
    const input = new Input();
    input.setValue(initialValue);
    input.onSubmit = (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        if (options?.required) {
          ctx.ui.notify("Cannot be empty", "error");
          return;
        }
        done();
        return;
      }
      done(trimmed);
    };
    input.onEscape = () => done();
    return input;
  };
}

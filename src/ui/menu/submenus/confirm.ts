/**
 * confirm-submenu.ts — Yes/no confirm dialog for destructive actions.
 *
 * Creates a submenu factory for SettingsList items that need a confirmation
 * dialog (clear overrides, reset concurrency, etc.).
 */

import { SelectList, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../types.ts";
import { buildSelectListTheme } from "../helpers.ts";

export interface ConfirmSubmenuOptions {
  message: string;
  /** Theme from pi-coding-agent (fg, bold, italic) */
  theme: Theme;
  onConfirm: () => void;
  onError?: (error: unknown) => void;
}

export function createConfirmSubmenu(
  options: ConfirmSubmenuOptions,
): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  return (_currentValue: string, done: (selectedValue?: string) => void) => {
    const items = [
      { value: "Yes", label: "Yes", description: options.message },
      { value: "No", label: "No", description: options.message },
    ];

    const list = new SelectList(items, 5, buildSelectListTheme(options.theme));

    list.onSelect = (item) => {
      if (item.value === "Yes") {
        try {
          options.onConfirm();
        } catch (error) {
          if (!options.onError) throw error;
          options.onError(error);
          return;
        }
        done("Yes");
      } else {
        done();
      }
    };
    list.onCancel = () => done();

    return list;
  };
}

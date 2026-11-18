/** Display-only terminal sanitization, independent of mocked formatting modules. */

/**
 * Based on upstream plainText: consume strings before CSI and other ESC sequences.
 * Strings may span lines and contain ESC bytes; only BEL/ST ends their payload.
 * CSI may contain embedded C0 bytes, including newlines.
 * Recognized unfinished strings/CSI consume the tail, so streaming callers must
 * sanitize their accumulated raw text again when the next delta arrives.
 */
const CONTROL_SEQUENCE =
  // oxlint-disable-next-line no-control-regex -- matching terminal controls is the point
  /(?:\u001B[PX\]^_]|[\u0090\u0098\u009D-\u009F])[\s\S]*?(?:\u0007|\u001B\\|\u009C|$)|(?:\u001B\[|\u009B)[0-?\u0000-\u001A\u001C-\u001F\u007F]*(?:[ -/][\u0000-\u001A\u001C-\u001F\u007F]*)*(?:[@-~]|$)|\u001B(?:[!-/][ -/]*[0-~]|[0-~])?/g;

// Keep tab/LF, ordinary Unicode (including ZWJ/variation selectors) and literal escapes.
// oxlint-disable-next-line no-control-regex -- matching terminal controls is the point
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\p{Bidi_Control}\uFFF9-\uFFFB]/gu;

/** Sanitize the complete raw display copy before splitting, wrapping or styling. */
export function plainText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(CONTROL_SEQUENCE, "").replace(CONTROL_CHARACTER, "");
}

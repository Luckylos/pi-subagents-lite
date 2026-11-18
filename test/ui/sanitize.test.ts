import { describe, expect, it } from "vite-plus/test";
import { plainText } from "../../src/ui/sanitize.js";

// Adapted from upstream's hostile viewer fixture; CR is normalized by this fork's contract.
const hostile =
  "sgr \u001b[31mred\u001b[0m\n" +
  "altscreen \u001b[?1049h\n" +
  "hidecursor \u001b[?25l\n" +
  "query \u001b[6n\n" +
  "resize \u001b[8;40;120t\n" +
  "device \u001bPtm;#q1\u001b\\\n" +
  "graphics \u001b_Gk=q;7;1;2;0;0;1\u001b\\\n" +
  "c1 graphics \u001b_Gk=q;7\u009c\n" +
  "title \u001b]0;window-title\u009c\n" +
  "clipboard \u001b]52;c;aGVsbG8=\u0007\n" +
  "private \u001b_x\u001b\\\n" +
  "c1 sgr A\u009b31mredB\u009b0mC\n" +
  "c1 altscreen A\u009b?1049hB\n" +
  "c1 stop A\u009cB\n" +
  "lone \u001b end\n" +
  "carriage return before\r after\n" +
  "tabs\tin\toutput stay\n" +
  "nul\u0000 bell\u0007 format\uFFF9 del before\u007f after bidi \u2066isolate\u2069 rtl \u202eword";

describe("plainText display copies", () => {
  it("removes upstream hostile controls and their complete payloads", () => {
    expect(plainText(hostile)).toBe(
      "sgr red\naltscreen \nhidecursor \nquery \nresize \ndevice \ngraphics \nc1 graphics \ntitle \nclipboard \nprivate \nc1 sgr AredBC\nc1 altscreen AB\nc1 stop AB\nlone  end\ncarriage return before\n after\ntabs\tin\toutput stay\nnul bell format del before after bidi isolate rtl word",
    );
  });

  it.each(["\x1b]", "\x1bP", "\x1bX", "\x1b^", "\x1b_", "\u009d", "\u0090", "\u0098", "\u009e", "\u009f"])(
    "removes complete and unfinished multiline strings introduced by %j",
    (start) => {
      for (const end of ["\x07", "\x1b\\", "\u009c"]) {
        expect(plainText(`before${start}hidden\nsecret\r\nmore${end}after`)).toBe("beforeafter");
      }
      expect(plainText(`before${start}hidden\nsecret`)).toBe("before");
      expect(plainText(`before${start}hidden\n`)).toBe("before");
      expect(plainText(`before${start}hidden\x1b`)).toBe("before");
      expect(plainText(`before${start}hidden\x1bXsecret\u009cafter`)).toBe("beforeafter");
    },
  );

  it.each(["\x1b[", "\u009b"])("hides unfinished CSI %j, including its parameters", (start) => {
    expect(plainText(`before${start}?1049`)).toBe("before");
    expect(plainText(`before${start}?1049hafter`)).toBe("beforeafter");
    expect(plainText(`before${start}31;`)).toBe("before");
    expect(plainText(`before${start}31;\n`)).toBe("before");
    expect(plainText(`before${start}31;\n1mafter`)).toBe("beforeafter");
  });

  it.each([
    ["7-bit complete", "\x1b[?10\x7f49hafter", "beforeafter"],
    ["7-bit unfinished", "\x1b[?10\x7f49", "before"],
    ["C1 complete", "\u009b?10\x7f49hafter", "beforeafter"],
    ["C1 unfinished", "\u009b?10\x7f49", "before"],
  ])("ignores DEL inside %s CSI", (_name, sequence, expected) => {
    expect(plainText(`before${sequence}`)).toBe(expected);
  });

  it("removes general ESC sequences, standalone terminators and a trailing ESC", () => {
    expect(plainText("a\x1b7b\x1b(Bc\x1b\\d\u009ce\x1b")).toBe("abcde");
  });

  it("normalizes CRLF before CR, retaining tabs, LF and ordinary Unicode", () => {
    const text = "中文 e\u0301 👩‍💻 ❤️ \uFE0F \\x1b\tline\r\nnext\rlast\n";
    expect(plainText(text)).toBe("中文 e\u0301 👩‍💻 ❤️ \uFE0F \\x1b\tline\nnext\nlast\n");
    expect(
      plainText("\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\uFFF9\uFFFA\uFFFBok"),
    ).toBe("ok");
  });

  it("removes residual C0, DEL and C1 while preserving tab and LF", () => {
    const controls = Array.from({ length: 160 }, (_, i) => i)
      .filter((i) => i < 32 || i >= 127)
      .map((i) => String.fromCharCode(i))
      .join("");
    expect(plainText(controls)).toBe("\t\n\n");
  });
});

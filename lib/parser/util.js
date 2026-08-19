/** Little-endian scalar reads and Python-compatible formatting helpers. */

export const u8 = (buf, off) => buf[off];

export function u16(buf, off) {
  return buf[off] | (buf[off + 1] << 8);
}

export function u32(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

export function s16(buf, off) {
  return (u16(buf, off) << 16) >> 16;
}

export function s8(buf, off) {
  return (buf[off] << 24) >> 24;
}

/** Python "%X"-style hex (uppercase, no prefix), optionally zero-padded. */
export function hexU(n, width = 0) {
  return (n >>> 0).toString(16).toUpperCase().padStart(width, "0");
}

/** Python "%d"-style zero-padded decimal. */
export function pad0(n, width) {
  return String(n).padStart(width, "0");
}

/** Lowercase hex of a byte sequence, like Python's bytes.hex(). */
export function bytesHex(buf) {
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Python 3 repr() of a str: single quotes, switching to double quotes when the
 * string contains a single quote but no double quote. Backslashes and the
 * matching quote are escaped; control characters use the \xNN / \n / \t forms.
 */
export function pyRepr(s) {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += "\\x" + code.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + quote;
}

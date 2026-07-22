// Presentation of rule expressions. Lives next to the evaluator because it
// shares the tokenizer, but nothing here affects a verdict.

import { tokenize } from "./evaluate.js";

/**
 * Pretty-print a `rules: if:` expression: one comparison per line, `&&`/`||`
 * trailing, parenthesized groups indented. Falls back to the original
 * (whitespace-collapsed) when the expression doesn't tokenize.
 */
export function formatCondition(expr) {
  let tokens;
  try {
    tokens = tokenize(String(expr));
  } catch {
    return String(expr).replace(/\s+/g, " ").trim();
  }
  const tokText = (t) => {
    switch (t.type) {
      case "var": return "$" + t.value;
      case "str": return `'${t.value}'`;
      case "regex": return `/${t.value.source}/${t.value.flags}`;
      case "null": return "null";
      case "op": return t.value;
      case "and": return "&&";
      case "or": return "||";
      default: return "";
    }
  };
  const lines = [];
  let indent = 0;
  let cur = "";
  const flush = () => {
    if (cur.trim()) lines.push("  ".repeat(indent) + cur.trim());
    cur = "";
  };
  for (const t of tokens) {
    if (t.type === "lparen") {
      flush();
      lines.push("  ".repeat(indent) + "(");
      indent++;
    } else if (t.type === "rparen") {
      flush();
      indent = Math.max(0, indent - 1);
      cur = ")";
    } else if (t.type === "and" || t.type === "or") {
      cur += (cur ? " " : "") + tokText(t);
      flush();
    } else {
      cur += (cur ? " " : "") + tokText(t);
    }
  }
  flush();
  return lines.join("\n");
}

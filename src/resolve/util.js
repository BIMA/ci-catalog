export function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Keys that would hit the prototype chain instead of becoming plain data
// properties when assigned with `out[k] = v` on YAML-controlled input.
export const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

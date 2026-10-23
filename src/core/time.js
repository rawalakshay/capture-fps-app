'use strict';
// A clip time typed by a person: "112", "1:52", "1:52.5" or "0:01:52" -> seconds, NaN when it is not one.
// Loaded by the window as a plain script and by the CLI as a module.
function parseTime(text) {
  const parts = String(text == null ? '' : text).trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d*\.?\d+$/.test(p))) return NaN;
  return parts.reduce((t, p) => t * 60 + Number(p), 0);
}
if (typeof module !== 'undefined') module.exports = { parseTime };

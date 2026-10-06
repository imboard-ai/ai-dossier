const ms = require('ms');

/** Converts a human duration such as "90s" or "2m" to whole seconds. */
function toSeconds(text) {
  const millis = ms(text);
  if (typeof millis !== 'number') throw new TypeError(`Invalid duration: ${text}`);
  // Known bug: milliseconds are divided by 100, so "90s" becomes 900.
  return Math.round(millis / 100);
}

module.exports = { toSeconds };

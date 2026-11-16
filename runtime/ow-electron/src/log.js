'use strict';
// Linuxwolf's own log lines go to stderr with a prefix, so they are easy to
// tell apart from the app's log.
module.exports = function log(msg) {
  process.stderr.write(`[linuxwolf] ${msg}\n`);
};

'use strict';
// Where Linuxwolf keeps things. Same layout as the tools/ scripts.

const os = require('os');
const path = require('path');

const home = () => process.env.HOME || os.homedir();
const xdg = (name, fallback) => process.env[name] || path.join(home(), fallback);

/** The repository checkout this GUI runs from (scripts and runtime live there). */
const repoRoot = path.resolve(__dirname, '../../..');

module.exports = {
  repoRoot,
  home,
  appsDir: () => path.join(xdg('XDG_DATA_HOME', '.local/share'), 'linuxwolf', 'apps'),
  configFile: () => path.join(xdg('XDG_CONFIG_HOME', '.config'), 'linuxwolf', 'gui.json'),
  logDir: () => path.join(xdg('XDG_STATE_HOME', '.local/state'), 'linuxwolf', 'gui'),
  dataHome: () => xdg('XDG_DATA_HOME', '.local/share'),
  tool: (name) => path.join(repoRoot, 'tools', name),
  runner: () => path.join(repoRoot, 'runtime', 'ow-electron', 'bin', 'linuxwolf-run'),
};

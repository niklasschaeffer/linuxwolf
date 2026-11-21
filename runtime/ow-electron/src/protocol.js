'use strict';
// Custom URL schemes (deep links) for ow-electron apps on Linux.
//
// Apps register schemes such as metabotgg:// with
// app.setAsDefaultProtocolClient() and get the links back through
// process.argv (cold start) or the "second-instance" event (app already
// running). Sign-in flows depend on it: MetaBot's Discord login ends in the
// browser with a redirect to metabotgg://auth/discord?token=...
//
// On Linux, Electron implements setAsDefaultProtocolClient() with
// `xdg-settings set default-url-scheme-handler <scheme> <desktop file>`,
// where the desktop file is Electron's own (electron.desktop). That file
// does not exist for a Linuxwolf app, so the call fails and KDE/xdg-open
// have no handler for the link.
//
// Linuxwolf answers the call itself: it writes a hidden desktop entry for
// the app (linuxwolf-app-<uid>.desktop) whose Exec starts the app through
// linuxwolf-run with the link as argument, lists the schemes as
// x-scheme-handler MIME types and makes it their default with xdg-mime.
// The started process passes the link on to the running instance through
// Electron's single-instance lock, like on Windows.

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('./log');

// Variables the Linuxwolf GUI sets for an app; the link handler starts the
// app with the same ones.
const PASS_ENV = ['LINUXWOLF_BACKEND', 'LINUXWOLF_OSD', 'LINUXWOLF_DEBUG', 'LINUXWOLF_ELECTRON', 'LINUXWOLF_OW_PACKAGES', 'LINUXWOLF_STEAM_ROOT'];

function applicationsDir(env = process.env) {
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'applications');
}

function desktopFileName(uid, productName) {
  const id = String(uid || productName || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `linuxwolf-app-${id}.desktop`;
}

function quoteExecArg(arg) {
  const s = String(arg);
  if (/^[A-Za-z0-9_/.:=,+@-]+$/.test(s)) return s;
  // Inside double quotes `"`, `` ` ``, `$` and `\` are escaped with a
  // backslash; the string value escaping then doubles every backslash.
  return `"${s.replace(/(["`$\\])/g, '\\$1')}"`.replace(/\\/g, '\\\\');
}

function desktopEntry({ name, runner, launchPath, schemes, env = {}, icon }) {
  const envArgs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const exec = [...(envArgs.length ? ['env', ...envArgs] : []), runner, launchPath].map(quoteExecArg).join(' ');
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${name}`,
    'Comment=Opens links for this app (Linuxwolf)',
    `Exec=${exec} %u`,
    ...(icon ? [`Icon=${icon}`] : []),
    'Terminal=false',
    'NoDisplay=true',
    `MimeType=${schemes.map((s) => `x-scheme-handler/${s};`).join('')}`,
    'X-Linuxwolf-App=true',
  ];
  return `${lines.join('\n')}\n`;
}

function validScheme(s) {
  return typeof s === 'string' && /^[a-z][a-z0-9+.-]*$/i.test(s);
}

function deepLinks(argv) {
  return (argv || []).filter((a) => typeof a === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(a) && !/^(https?|file):/i.test(a));
}

function redact(link) {
  return link.replace(/([?&][^=&]*(?:token|code|secret|key)[^=&]*=)[^&]*/gi, '$1<redacted>');
}

function run(file, args) {
  return new Promise((resolve) => {
    childProcess.execFile(file, args, { timeout: 10000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

function install(app, { uid, appRoot, launchPath = appRoot, productName, env = process.env, runner = path.join(__dirname, '../bin/linuxwolf-run'), exec = run, linkLog = null, argv = process.argv } = {}) {
  const dir = applicationsDir(env);
  const fileName = desktopFileName(uid, productName);
  const file = path.join(dir, fileName);
  const schemes = new Set();
  const passEnv = Object.fromEntries(PASS_ENV.filter((k) => env[k]).map((k) => [k, env[k]]));
  let pending = Promise.resolve();

  function write() {
    if (!schemes.size) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    const icon = [path.join(path.dirname(appRoot), 'icon.png'), path.join(appRoot, 'icon.png')].find((p) => fs.existsSync(p));
    const text = desktopEntry({ name: productName, runner: path.resolve(runner), launchPath, schemes: [...schemes], env: passEnv, icon });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }

  function register(scheme) {
    pending = pending.then(async () => {
      await exec('xdg-mime', ['default', fileName, `x-scheme-handler/${scheme}`]);
      await exec('update-desktop-database', [dir]);
      const now = await exec('xdg-mime', ['query', 'default', `x-scheme-handler/${scheme}`]);
      log(now === fileName ? `[protocol] ${scheme}:// links open ${productName} (${file})` : `[protocol] ${scheme}:// registered in ${file}, but the default handler is ${now || 'unknown'}`);
    });
    return pending;
  }

  app.setAsDefaultProtocolClient = (scheme) => {
    if (!validScheme(scheme)) return false;
    schemes.add(scheme.toLowerCase());
    try {
      write();
    } catch (e) {
      log(`[protocol] cannot write ${file}: ${e.message}`);
      return false;
    }
    register(scheme.toLowerCase());
    return true;
  };
  app.removeAsDefaultProtocolClient = (scheme) => {
    if (!validScheme(scheme) || !schemes.delete(scheme.toLowerCase())) return false;
    try {
      write();
    } catch {}
    return true;
  };
  app.isDefaultProtocolClient = (scheme) => validScheme(scheme) && schemes.has(scheme.toLowerCase());

  // A process started by a link usually has no visible stderr (KDE starts
  // it), so links also go to a log file for diagnosing sign-in problems.
  function noteLinks(where, args) {
    for (const link of deepLinks(args)) {
      const line = `[protocol] ${where}: ${redact(link)}`;
      log(line);
      if (linkLog) {
        try {
          fs.appendFileSync(linkLog, `${new Date().toISOString()} pid ${process.pid} ${line}\n`);
        } catch {}
      }
    }
  }
  noteLinks('started with link', argv);
  if (typeof app.on === 'function') app.on('second-instance', (_e, args) => noteLinks('link from a second instance', args));

  return { file, schemes, settled: () => pending };
}

module.exports = { install, desktopEntry, desktopFileName, quoteExecArg, deepLinks, redact };

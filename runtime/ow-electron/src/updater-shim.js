'use strict';
// Stand-in for `electron-updater`. ow-electron apps update themselves from
// Overwolf's feed with a Windows installer. On Linux, Linuxwolf installs and
// updates the app files itself (tools/fetch-ow-electron-app.sh), so the
// in-app updater always reports "no update".

const { EventEmitter } = require('events');
const log = require('./log');

class AutoUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = true;
    this.autoInstallOnAppQuit = true;
    this.allowPrerelease = false;
    this.allowDowngrade = false;
    this.forceDevUpdateConfig = false;
    this.quitAndInstallCalled = false;
    this.channel = null;
    this.logger = null;
    this.currentVersion = null;
  }
  async checkForUpdates() {
    log('[updater] checkForUpdates -> not available (Linuxwolf manages updates)');
    setImmediate(() => {
      this.emit('checking-for-update');
      this.emit('update-not-available', { version: this.currentVersion });
    });
    return null;
  }
  checkForUpdatesAndNotify() {
    return this.checkForUpdates();
  }
  async downloadUpdate() {
    return [];
  }
  quitAndInstall() {}
  install() {
    return false;
  }
  setFeedURL() {}
  getFeedURL() {
    return null;
  }
  addAuthHeader() {}
  isUpdaterActive() {
    return false;
  }
}

const autoUpdater = new AutoUpdater();
module.exports = {
  autoUpdater,
  AppUpdater: AutoUpdater,
  NsisUpdater: AutoUpdater,
  AppImageUpdater: AutoUpdater,
  CancellationToken: class CancellationToken { cancel() {} },
  UpdaterSignal: class UpdaterSignal {},
};

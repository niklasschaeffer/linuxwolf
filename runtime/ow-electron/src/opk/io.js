'use strict';
// overwolf.io on Linux: Windows paths in, results in Overwolf's shapes out.
// Path mapping lives in winpath.js.

const fs = require('fs');
const path = require('path');

const BOM = '﻿';

function decode(buf, encoding) {
  const enc = String(encoding || 'UTF8').toUpperCase();
  let s;
  if (enc.startsWith('UNICODE')) s = buf.toString('utf16le');
  else if (enc === 'ASCII') s = buf.toString('latin1');
  else s = buf.toString('utf8');
  return s.startsWith(BOM) ? s.slice(1) : s;
}

function encode(content, encoding) {
  const enc = String(encoding || 'UTF8').toUpperCase();
  const text = String(content ?? '');
  if (enc === 'UNICODE') return Buffer.from(text, 'utf16le');
  if (enc === 'UNICODEBOM') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (enc === 'UTF8BOM') return Buffer.from(BOM + text, 'utf8');
  if (enc === 'ASCII') return Buffer.from(text, 'latin1');
  return Buffer.from(text, 'utf8');
}

class OpkIo {
  /** @param {import('./winpath').WinPaths} winPaths */
  constructor(winPaths, log = () => {}) {
    this.wp = winPaths;
    this.log = log;
  }

  resolve(p) {
    const real = this.wp.toLinux(p);
    if (!real) throw new Error(`Path not available on Linux: ${p}`);
    if (process.env.LINUXWOLF_DEBUG === '1') this.log(`[io] ${p} -> ${real}`);
    return real;
  }

  wrap(fn) {
    try {
      return fn();
    } catch (e) {
      return { success: false, status: 'error', error: e.code === 'ENOENT' ? 'File not found' : e.message, reason: e.message };
    }
  }

  fileExists(p) {
    return this.wrap(() => {
      let found = false;
      try {
        found = fs.statSync(this.resolve(p)).isFile();
      } catch {}
      return { success: true, status: 'success', found };
    });
  }

  exist(p) {
    return this.wrap(() => {
      let st = null;
      try {
        st = fs.statSync(this.resolve(p));
      } catch {}
      return { success: true, status: 'success', exist: Boolean(st), found: Boolean(st), type: st ? (st.isDirectory() ? 'dir' : 'file') : null };
    });
  }

  dir(p) {
    return this.wrap(() => {
      const real = this.resolve(p);
      const data = fs.readdirSync(real, { withFileTypes: true }).map((d) => {
        let isDir = d.isDirectory();
        if (d.isSymbolicLink()) {
          try {
            isDir = fs.statSync(path.join(real, d.name)).isDirectory();
          } catch {}
        }
        return { name: d.name, type: isDir ? 'dir' : 'file' };
      });
      return { success: true, status: 'success', data };
    });
  }

  readFileContents(p, encoding) {
    return this.wrap(() => ({ success: true, status: 'success', content: decode(fs.readFileSync(this.resolve(p)), encoding) }));
  }

  readTextFile(p, options = {}) {
    return this.wrap(() => {
      const real = this.resolve(p);
      const size = fs.statSync(real).size;
      const offset = Math.max(0, Number(options.offset) || 0);
      const max = Number(options.maxBytesToRead) > 0 ? Number(options.maxBytesToRead) : size - offset;
      const len = Math.max(0, Math.min(max, size - offset));
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(real, 'r');
      try {
        fs.readSync(fd, buf, 0, len, offset);
      } finally {
        fs.closeSync(fd);
      }
      const content = decode(buf, options.encoding);
      return {
        success: true,
        status: 'success',
        content,
        info: { eof: offset + len >= size, totalRead: len, position: offset + len, totalLines: content.split('\n').length },
      };
    });
  }

  writeFileContents(p, content, encoding) {
    return this.wrap(() => {
      const real = this.resolve(p);
      fs.mkdirSync(path.dirname(real), { recursive: true });
      fs.writeFileSync(real, encode(content, encoding));
      return { success: true, status: 'success' };
    });
  }
}

module.exports = { OpkIo, decode, encode };

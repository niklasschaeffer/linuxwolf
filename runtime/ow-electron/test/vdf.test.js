'use strict';
const test = require('node:test');
const assert = require('node:assert');
const vdf = require('../src/vdf');

test('parses nested KeyValues with comments and escapes', () => {
  const data = vdf.parse(`// comment
"Registry"
{
  "HKCU" { "Software" { "Valve" { "Steam" {
    "RunningAppID" "4126040"
    "apps" { "4126040" { "Running" "1" "name" "A \\"quoted\\" name" } }
  } } } }
}`);
  const steam = vdf.get(data, 'registry', 'hkcu', 'software', 'valve', 'steam');
  assert.equal(steam.RunningAppID, '4126040');
  assert.equal(vdf.get(steam, 'Apps', '4126040', 'running'), '1');
  assert.equal(vdf.get(steam, 'apps', '4126040', 'name'), 'A "quoted" name');
  assert.equal(vdf.get(steam, 'missing', 'x'), undefined);
});

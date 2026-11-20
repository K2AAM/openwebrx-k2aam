// Channel catalog and watchlist checks for the ALE plugin. Scanning itself runs on the
// server and is covered by test_server_scan.py.
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const path = require('node:path');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../htdocs/plugins/receiver/ale/ale.js'), 'utf8'), ctx);
const banks = JSON.parse(JSON.stringify(vm.runInContext('ALE_SCAN_BANKS', ctx)));
const catalog = require('../channels.json');
assert.deepEqual(banks.map(b => b.id), catalog.banks.map(b => b.id));
assert.deepEqual(banks.map(b => b.channels), catalog.banks.map(b => b.channels.map(c => c.frequency_hz)));
assert.equal(vm.runInContext('typeof AleScanController', ctx), 'undefined');
console.log('3 ALE catalog checks passed');

const matcher = vm.runInContext('aleWatchMatcher', ctx);
const watch = matcher('adw, jnr K2*;  *99');
assert.ok(watch('ADW') && watch('jnr') && watch('K2AAM') && watch('ABC99'));
assert.ok(!watch('ADWX') && !watch('XADW') && !watch('') && !watch(null) && !watch('K1AAM'));
const literal = matcher('A.B (x)+');
assert.ok(literal('A.B') && !literal('AXB') && literal('(X)+'));
assert.ok(!matcher('')('ADW') && !matcher(' , ')('ADW'));
console.log('9 ALE watchlist checks passed');

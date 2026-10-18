const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createDebug} = require('./debug.js');

(async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patcher-debug-'));
	const files = [];
	try {
		const disabled = createDebug(['list'], dir);
		disabled.write('ignored');
		assert.equal(disabled.enabled, false);
		assert.deepEqual(fs.readdirSync(dir), []);
		for (const args of [['-debug'], ['--debug', 'list'], ['apply', '2399830', '-debug']]) {
			const debug = createDebug(args, dir);
			files.push(debug.file);
			assert.deepEqual(debug.argv, args.filter(a => !a.endsWith('debug')));
			const compression = {unzip: async data => {
				if (data[0] === 0) throw new Error('bad frame');
				return data;
			}};
			debug.instrumentCompression(compression);
			await Promise.all(['first', 'second'].map(sha => debug.run({sha}, async () => {
				await assert.rejects(compression.unzip(Buffer.alloc(4)), /bad frame/);
			})));
			assert.deepEqual(await compression.unzip(Buffer.from('ok')), Buffer.from('ok'));
			const rows = fs.readFileSync(debug.file, 'utf8').trim().split('\n').slice(1).map(JSON.parse);
			assert.equal(rows.length, 2);
			assert.deepEqual(rows.map(r => r.sha), ['first', 'second']);
			assert.ok(rows.every(r => r.event === 'decompression-failed' && r.decryptedBytes === 4 && r.stack.includes('bad frame')));
		}
		console.log('Debug flag, logging, compression errors and concurrent chunk context OK');
	} finally {
		for (const file of files) fs.unlinkSync(file);
		fs.rmdirSync(dir);
	}
})().catch(err => { console.error(err); process.exitCode = 1; });

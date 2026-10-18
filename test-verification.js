const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {verifyFiles} = require('./verification.js');

(async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'patcher-verify-'));
	const filename = path.join(dir, 'game.bin');
	const chunks = [Buffer.from('first'), Buffer.from('second')];
	const ops = chunks.map((buf, i) => ({offset: i ? chunks[0].length : 0, len: buf.length,
		sha: crypto.createHash('sha1').update(buf).digest('hex')}));
	let skip = false, reads = 0, downloads = 0, bytes = 0, handle;
	const options = {directory: dir, files: [{filename: 'game.bin', size: 11, ops}],
		readAt: async (fh, offset, len) => {
			handle = fh; reads++;
			const buf = Buffer.alloc(len);
			const {bytesRead} = await fh.read(buf, 0, len, offset);
			return buf.subarray(0, bytesRead);
		},
		download: async sha => { downloads++; return chunks[ops.findIndex(o => o.sha === sha)]; },
		progress: {add: n => { bytes += n; }}, shouldSkip: () => skip};
	try {
		await fs.writeFile(filename, Buffer.concat(chunks));
		assert.deepEqual(await verifyFiles(options), {bad: 0, skipped: false});
		assert.equal(bytes, 11);
		assert.equal(downloads, 0);
		await fs.writeFile(filename, Buffer.alloc(11));
		assert.deepEqual(await verifyFiles(options), {bad: 2, skipped: false});
		assert.deepEqual(await fs.readFile(filename), Buffer.concat(chunks));
		skip = true; reads = 0;
		assert.deepEqual(await verifyFiles(options), {bad: 0, skipped: true});
		assert.equal(reads, 0);
		skip = false;
		await fs.writeFile(filename, Buffer.alloc(11));
		const download = options.download;
		options.download = async sha => { skip = true; return download(sha); };
		assert.deepEqual(await verifyFiles(options), {bad: 1, skipped: true});
		assert.equal(reads, 1);
		assert.deepEqual((await fs.readFile(filename)).subarray(0, 5), chunks[0]);
		assert.equal(handle.fd, -1, 'Skipped verification must close the file');
		skip = false;
		options.download = async () => { throw new Error('network failed'); };
		await assert.rejects(verifyFiles(options), /network failed/);
		assert.equal(handle.fd, -1, 'Repair errors must close the file');
		console.log('Verification, repair, skip and file cleanup checks OK');
	} finally {
		await fs.unlink(filename);
		await fs.rmdir(dir);
	}
})().catch(err => { console.error(err); process.exitCode = 1; });

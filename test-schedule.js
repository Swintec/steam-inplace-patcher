// Randomized check: executing schedule() in place on an old buffer must yield the new buffer.
const crypto = require('crypto');
const {buildPlan, schedule} = require('./plan.js');

const sha1 = b => crypto.createHash('sha1').update(b).digest('hex');
const rnd = n => Math.floor(Math.random() * n);

function chunked(buf, name) {
	const chunks = [];
	for (let off = 0; off < buf.length;) {
		const len = Math.min(buf.length - off, 50 + rnd(200));
		chunks.push({offset: off, cb_original: len, cb_compressed: len, sha: sha1(buf.subarray(off, off + len))});
		off += len;
	}
	return {filename: name, size: buf.length, flags: 0, sha_content: sha1(buf), chunks};
}

let failures = 0;
for (let t = 0; t < 300; t++) {
	// old content: blocks; new content: blocks reordered, some dropped, some new, some duplicated
	const blocks = Array.from({length: 5 + rnd(30)}, () => crypto.randomBytes(100 + rnd(2000)));
	const newBlocks = [];
	for (const b of blocks.slice().sort(() => Math.random() - 0.5)) {
		if (Math.random() < 0.1) continue;
		if (Math.random() < 0.15) newBlocks.push(crypto.randomBytes(50 + rnd(1000)));
		newBlocks.push(b);
		if (Math.random() < 0.05) newBlocks.push(b);
	}
	const oldBuf = Buffer.concat(blocks), newBuf = Buffer.concat(newBlocks);
	// chunk the old file with the boundaries the new file would produce where content matches
	const oldF = chunkedLike(oldBuf, blocks), newF = chunkedLike(newBuf, newBlocks);
	const plan = buildPlan({files: [oldF]}, {files: [newF]});
	const {steps} = schedule(plan);

	const file = Buffer.alloc(Math.max(oldBuf.length, newBuf.length));
	oldBuf.copy(file);
	const mem = new Map();
	for (const s of steps) {
		const op = s.op;
		if (s.stash) { mem.set(op.id, Buffer.from(file.subarray(op.src.offset, op.src.offset + op.len))); continue; }
		const data = op.type === 'download' ? newBuf.subarray(op.offset, op.offset + op.len)
			: s.fromStash ? mem.get(op.id) : Buffer.from(file.subarray(op.src.offset, op.src.offset + op.len));
		if (sha1(data) !== op.sha) { failures++; break; }
		data.copy(file, op.offset);
	}
	if (!file.subarray(0, newBuf.length).equals(newBuf)) failures++;
}
console.log(failures ? `FAILED ${failures}` : 'all 300 random cases OK');

// Steam chunks content per file; matching blocks give matching chunks, like a real rebuild
function chunkedLike(buf, blocks) {
	const chunks = [];
	let off = 0;
	for (const b of blocks) {
		for (let i = 0; i < b.length;) {
			const len = Math.min(b.length - i, 64 + (b[i] % 300));
			chunks.push({offset: off + i, cb_original: len, cb_compressed: len, sha: sha1(b.subarray(i, i + len))});
			i += len;
		}
		off += b.length;
	}
	return {filename: 'f', size: buf.length, flags: 0, sha_content: sha1(buf), chunks};
}

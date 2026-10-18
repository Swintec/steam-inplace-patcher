const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Skip between chunks; finish and flush any repair already in progress.
async function verifyFiles({directory, files, readAt, download, progress, shouldSkip}) {
	let bad = 0;
	for (const file of files) {
		if (shouldSkip()) return {bad, skipped: true};
		const fh = await fs.open(path.join(directory, file.filename), 'r+');
		try {
			const {size} = await fh.stat();
			if (size !== file.size) await fh.truncate(file.size);
			for (const op of file.ops) {
				if (shouldSkip()) return {bad, skipped: true};
				const buf = await readAt(fh, op.offset, op.len);
				if (shouldSkip()) return {bad, skipped: true};
				if (crypto.createHash('sha1').update(buf).digest('hex') !== op.sha) {
					bad++;
					const data = await download(op.sha);
					await fh.write(data, 0, data.length, op.offset);
				}
				progress.add(op.len);
			}
		} finally {
			try { await fh.sync(); } finally { await fh.close(); }
		}
	}
	return {bad, skipped: shouldSkip()};
}

module.exports = {verifyFiles};

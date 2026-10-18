const fs = require('fs');
const path = require('path');
const {AsyncLocalStorage} = require('node:async_hooks');

function createDebug(args, directory) {
	const enabled = args.includes('-debug') || args.includes('--debug');
	const argv = args.filter(a => a !== '-debug' && a !== '--debug');
	const context = new AsyncLocalStorage();
	let file = null;
	if (enabled) {
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		file = path.join(directory, `debug-${stamp}-${process.pid}.log`);
		fs.writeFileSync(file, 'Steam in-place patcher debug log\n', {flag: 'wx'});
	}
	function write(event, details = {}) {
		if (!enabled) return;
		fs.appendFileSync(file, JSON.stringify({time: new Date().toISOString(), event, ...context.getStore(), ...details}) + '\n');
	}
	function error(event, err, details = {}) {
		write(event, {...details, error: err.message, stack: err.stack, code: err.code});
	}
	function instrumentCompression(compression) {
		if (!enabled) return;
		const unzip = compression.unzip;
		compression.unzip = async function(data) {
			const details = {
				decryptedBytes: data.length,
				magicHex: data.subarray(0, 4).toString('hex'),
				footerHex: data.subarray(Math.max(0, data.length - 15)).toString('hex'),
			};
			try {
				return await unzip.call(this, data);
			} catch (err) {
				error('decompression-failed', err, details);
				throw err;
			}
		};
	}
	return {enabled, argv, file, write, error, instrumentCompression,
		run: (details, action) => enabled ? context.run(details, action) : action()};
}

module.exports = {createDebug};

// In-place updater for ARK: Survival Ascended (app 2399830, depot 2399831).
// Rewrites changed files in place instead of staging a full copy, so it needs ~10 GB free instead of ~210 GB.
//
//   node patcher.js plan      offline: what would change
//   node patcher.js apply     log in, download new chunks, patch in place, verify (Steam must be closed)
//   node patcher.js verify    log in, check every changed file chunk by chunk and repair mismatches
//   node patcher.js fixacf    tell Steam the game is on the new build (Steam must be closed)
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const {execSync} = require('child_process');
const {loadManifest, buildPlan, schedule} = require('./plan.js');
const gui = require('./gui.js');

const APP = 2399830;
const DEPOT = 2399831;
const STEAM = findSteam();
const LIB = findLibrary();   // the Steam library folder that holds ASA
const ACF = `${LIB}\\steamapps\\appmanifest_${APP}.acf`;
const GAME = `${LIB}\\steamapps\\common\\ARK Survival Ascended`;
// as a single .exe, keep state next to the exe
const HERE = require('node:sea').isSea() ? path.dirname(process.execPath) : __dirname;

function findSteam() {
	try {
		const out = execSync('reg query HKCU\\Software\\Valve\\Steam /v SteamPath', {encoding: 'utf8'});
		const p = out.match(/SteamPath\s+REG_SZ\s+(.+)/)[1].trim().replace(/\//g, '\\');
		if (fs.existsSync(p)) return p;
	} catch (e) {}
	return 'C:\\Program Files (x86)\\Steam';
}

function findLibrary() {
	const vdf = `${STEAM}\\steamapps\\libraryfolders.vdf`;
	const libs = fs.existsSync(vdf) ? [...fs.readFileSync(vdf, 'utf8').matchAll(/"path"\s+"([^"]+)"/g)].map(m => m[1].replace(/\\\\/g, '\\')) : [];
	return [STEAM, ...libs].find(l => fs.existsSync(`${l}\\steamapps\\appmanifest_${APP}.acf`)) || STEAM;
}
const STATE = path.join(HERE, 'state');
const STASH = path.join(STATE, 'stash.bin');
const STASH_INDEX = path.join(STATE, 'stash-index.json');
const CHECKPOINT = path.join(STATE, 'checkpoint.json');
const TOKEN = path.join(STATE, 'refresh-token.txt');

const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex');
const gib = n => (n / 2 ** 30).toFixed(2) + ' GiB';
const log = (...a) => {
	console.log(new Date().toLocaleTimeString(), ...a);
	gui.set({message: a.join(' ')});
};

function readAcf() {
	const text = fs.readFileSync(ACF, 'utf8');
	const field = name => (text.match(new RegExp(`"${name}"\\s+"([^"]*)"`)) || [])[1];
	const depotBlock = text.match(new RegExp(`"${DEPOT}"\\s*\\{\\s*"manifest"\\s+"(\\d+)"`));
	return {text, buildid: field('buildid'), target: field('TargetBuildID'), manifest: depotBlock && depotBlock[1]};
}

function steamRunning() {
	try {
		return /steam\.exe/i.test(execSync('tasklist /FI "IMAGENAME eq steam.exe" /NH', {encoding: 'utf8'}));
	} catch (e) {
		return false;
	}
}

function progress(label, total) {
	let doneBytes = 0, last = 0;
	const start = Date.now();
	return {
		add(n) {
			doneBytes += n;
			gui.progress(label, doneBytes);
			const now = Date.now();
			if (now - last < 3000 && doneBytes < total) return;
			last = now;
			const rate = doneBytes / Math.max(1, (now - start) / 1000);
			const eta = rate > 0 ? Math.round((total - doneBytes) / rate / 60) : '?';
			log(`${label}: ${gib(doneBytes)} / ${gib(total)} (${(100 * doneBytes / total).toFixed(1)}%), ${(rate / 2 ** 20).toFixed(0)} MiB/s, ~${eta} min left`);
		},
	};
}

// ---------- Steam login ----------

async function login() {
	const SteamUser = require('steam-user');
	const client = new SteamUser({enablePicsCache: false, autoRelogin: true});
	client.on('error', e => log('Steam error:', e.message));

	let refreshToken = fs.existsSync(TOKEN) ? fs.readFileSync(TOKEN, 'utf8').trim() : null;
	if (!refreshToken) refreshToken = await qrLogin();

	await new Promise((resolve, reject) => {
		client.once('loggedOn', resolve);
		client.once('error', reject);
		client.logOn({refreshToken, logonID: 0x41524B});
	});
	client.on('refreshToken', t => fs.writeFileSync(TOKEN, t));
	log('Logged in to Steam as', client.steamID.getSteamID64());
	return client;
}

async function qrLogin() {
	const {LoginSession, EAuthTokenPlatformType} = require('steam-session');
	const qrcode = require('qrcode-terminal');
	const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
	session.loginTimeout = 5 * 60 * 1000;
	const {qrChallengeUrl} = await session.startWithQR();
	console.log('\nScan this QR code with the Steam app on your phone (Steam Guard > scan QR code):\n');
	qrcode.generate(qrChallengeUrl, {small: true});
	await gui.showQr(qrChallengeUrl);
	gui.set({message: 'Log in: scan the QR code with the Steam app on your phone'});
	return new Promise((resolve, reject) => {
		session.on('remoteInteraction', () => log('QR scanned, confirm the login in the Steam app...'));
		session.on('authenticated', () => {
			gui.showQr(null);
			fs.writeFileSync(TOKEN, session.refreshToken);
			resolve(session.refreshToken);
		});
		session.on('timeout', () => reject(new Error('QR login timed out, run again')));
		session.on('error', reject);
	});
}

// ---------- manifests ----------

async function getManifests(client) {
	const acf = readAcf();
	let newId, buildid;
	if (client) {
		const {apps} = await client.getProductInfo([APP], [], true);
		const info = apps[APP].appinfo;
		const m = info.depots[DEPOT].manifests.public;
		newId = typeof m === 'object' ? m.gid : m;
		buildid = info.depots.branches.public.buildid;
		log(`Installed build ${acf.buildid} (manifest ${acf.manifest}), latest build ${buildid} (manifest ${newId})`);
	} else {
		// offline: assume the newest manifest Steam already fetched is the target
		const cands = fs.readdirSync(`${STEAM}\\depotcache`).filter(n => n.startsWith(`${DEPOT}_`));
		newId = cands.map(n => [n, fs.statSync(`${STEAM}\\depotcache\\${n}`).mtimeMs]).sort((a, b) => b[1] - a[1])[0][0].slice(String(DEPOT).length + 1, -9);
		buildid = acf.target;
	}
	if (newId === acf.manifest) throw new Error('Already on the latest manifest, nothing to do');

	const oldM = await fetchManifest(client, acf.manifest);
	const newM = await fetchManifest(client, newId);
	return {oldM, newM, newId, buildid};
}

// from Steam's depotcache when present, else from the CDN (cached in state\)
async function fetchManifest(client, id) {
	let file = `${STEAM}\\depotcache\\${DEPOT}_${id}.manifest`;
	if (!fs.existsSync(file)) {
		file = path.join(STATE, `${DEPOT}_${id}.manifest`);
		if (!fs.existsSync(file)) {
			if (!client) throw new Error(`Manifest ${id} not cached locally; run apply to download it`);
			log(`Downloading manifest ${id}...`);
			const {manifest} = await client.getRawManifest(APP, DEPOT, id, 'public');
			fs.writeFileSync(file, manifest);
		}
	}
	try {
		return loadManifest(file);
	} catch (e) {
		// downloaded manifests have encrypted filenames
		const ContentManifest = require('steam-user/components/content_manifest.js');
		const m = ContentManifest.parse(fs.readFileSync(file));
		ContentManifest.decryptFilenames(m, (await client.getDepotDecryptionKey(APP, DEPOT)).key);
		return normalize(m);
	}
}

function normalize(m) {
	for (const f of m.files) {
		f.filename = f.filename.replace(/\//g, '\\');
		f.size = Number(f.size);
		for (const c of f.chunks) c.offset = Number(c.offset);
		f.chunks.sort((a, b) => a.offset - b.offset);
	}
	return m;
}

function summary(plan, sched) {
	const t = plan.totals;
	log(`${t.changedFiles} changed files, ${t.unchangedFiles} unchanged`);
	log(`already in place ${gib(t.keep)}, to shift within the files ${gib(t.move)}, to download ${gib(t.download)} (${gib(t.downloadCompressed)} over the network)`);
	log(`extra space needed: ~${gib(t.download + sched.stashBytes)} for downloaded chunks`);
	if (plan.deleted.length) log('files to delete:', plan.deleted.join(', '));
}

// ---------- downloading ----------

class Downloader {
	constructor(client) {
		this.client = client;
		this.servers = null;
		this.next = 0;
	}
	async chunk(sha) {
		if (!this.servers) this.servers = (await this.client.getContentServers(APP)).servers;
		let lastErr;
		for (let attempt = 0; attempt < 8; attempt++) {
			const server = this.servers[this.next++ % this.servers.length];
			try {
				const {chunk} = await this.client.downloadChunk(APP, DEPOT, sha, server);
				return chunk;
			} catch (e) {
				lastErr = e;
				await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
			}
		}
		throw new Error(`chunk ${sha} failed: ${lastErr && lastErr.message}`);
	}
}

// Downloads every new chunk into the stash before the game files are touched. Resumable.
async function downloadAll(dl, ops) {
	let index = fs.existsSync(STASH_INDEX) ? JSON.parse(fs.readFileSync(STASH_INDEX, 'utf8')) : {};
	let end = Object.values(index).reduce((m, e) => Math.max(m, e.pos + e.len), 0);
	const fh = await fsp.open(STASH, fs.existsSync(STASH) ? 'r+' : 'w+');
	await fh.truncate(end);

	// the same chunk can be needed at several places; download it once
	const todo = [...new Map(ops.filter(o => o.type === 'download' && !index[o.sha]).map(o => [o.sha, o])).values()];
	const total = todo.reduce((s, o) => s + o.compressed, 0);
	log(`Downloading ${todo.length} chunks (${gib(total)}), ${Object.keys(index).length} already in the stash`);
	gui.set({dl: {done: 0, total}});
	const prog = progress('download', total);
	let i = 0, sinceSave = 0;
	const save = () => fs.writeFileSync(STASH_INDEX, JSON.stringify(index));
	const worker = async () => {
		while (i < todo.length) {
			const op = todo[i++];
			const data = await dl.chunk(op.sha);
			const pos = end;
			end += data.length;
			await fh.write(data, 0, data.length, pos);
			index[op.sha] = {pos, len: data.length};
			prog.add(op.compressed);
			if (++sinceSave >= 200) {
				sinceSave = 0;
				await fh.sync();
				save();
			}
		}
	};
	await Promise.all(Array.from({length: 16}, worker));
	await fh.sync();
	save();
	return {fh, index};
}

// ---------- patching ----------

async function openGameFile(name, handles) {
	const k = name.toLowerCase();
	if (handles.has(k)) return handles.get(k);
	const full = path.join(GAME, name);
	await fsp.mkdir(path.dirname(full), {recursive: true});
	const fh = await fsp.open(full, fs.existsSync(full) ? 'r+' : 'w+');
	handles.set(k, fh);
	return fh;
}

async function readAt(fh, pos, len) {
	const buf = Buffer.allocUnsafe(len);
	let got = 0;
	while (got < len) {
		const {bytesRead} = await fh.read(buf, got, len - got, pos + got);
		if (!bytesRead) break;
		got += bytesRead;
	}
	return got === len ? buf : buf.subarray(0, got);
}

async function apply(client) {
	if (steamRunning()) throw new Error('Close Steam completely first (Steam > Exit), then run again');
	fs.mkdirSync(STATE, {recursive: true});
	const {oldM, newM} = await getManifests(client);
	const plan = buildPlan(oldM, newM);
	const sched = schedule(plan);
	summary(plan, sched);
	const patchTotal = sched.steps.reduce((s, x) => s + (x.stash ? 0 : x.op.len), 0);
	gui.setInstallTotals(patchTotal, plan.files.reduce((s, f) => s + f.size, 0));

	const dl = new Downloader(client);
	const {fh: stash, index} = await downloadAll(dl, sched.ops);
	const fromStash = async sha => {
		const e = index[sha];
		const buf = e && await readAt(stash, e.pos, e.len);
		return buf && sha1(buf) === sha ? buf : dl.chunk(sha);
	};

	const handles = new Map();
	const fileByName = new Map(plan.files.map(f => [f.filename.toLowerCase(), f]));
	// grow files first so every destination exists
	for (const f of plan.files) {
		const fh = await openGameFile(f.filename, handles);
		const {size} = await fh.stat();
		if (size < f.size) await fh.truncate(f.size);
	}

	const start = fs.existsSync(CHECKPOINT) ? JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')).step : 0;
	if (start) log(`Resuming at step ${start} of ${sched.steps.length}`);
	const memStash = new Map();
	const total = sched.steps.reduce((s, x) => s + (x.stash ? 0 : x.op.len), 0);
	const prog = progress('patch', total);
	let fallbacks = 0;
	for (let n = start; n < sched.steps.length; n++) {
		const {op, stash: toStash, fromStash: useStash} = sched.steps[n];
		if (toStash) {
			const src = await openGameFile(op.src.file, handles);
			const buf = await readAt(src, op.src.offset, op.len);
			if (sha1(buf) === op.sha) memStash.set(op.id, buf);
			continue;
		}
		const dst = await openGameFile(op.file, handles);
		let data;
		if (op.type === 'download') {
			data = await fromStash(op.sha);
		} else if (useStash) {
			data = memStash.get(op.id);
			memStash.delete(op.id);
		} else {
			const src = await openGameFile(op.src.file, handles);
			data = await readAt(src, op.src.offset, op.len);
		}
		if (!data || sha1(data) !== op.sha) {
			// source no longer holds the expected data (old file differed, or resuming after a crash)
			const cur = await readAt(dst, op.offset, op.len);
			if (sha1(cur) === op.sha) data = null;
			else { data = await dl.chunk(op.sha); fallbacks++; }
		}
		if (data) await dst.write(data, 0, data.length, op.offset);
		prog.add(op.len);
		if (n % 2000 === 0) {
			for (const h of handles.values()) await h.sync();
			fs.writeFileSync(CHECKPOINT, JSON.stringify({step: n}));
		}
	}
	for (const f of plan.files) {
		const fh = await openGameFile(f.filename, handles);
		await fh.truncate(f.size);
	}
	for (const h of handles.values()) { await h.sync(); await h.close(); }
	fs.writeFileSync(CHECKPOINT, JSON.stringify({step: sched.steps.length}));
	for (const name of plan.deleted) {
		const full = path.join(GAME, name);
		if (fs.existsSync(full)) fs.unlinkSync(full);
	}
	await stash.close();
	log(`Patch written (${fallbacks} chunks had to be re-downloaded on the fly). Verifying...`);
	await verify(client, plan, dl);
}

async function verify(client, plan, dl) {
	if (!plan) {
		const {oldM, newM} = await getManifests(client);
		plan = buildPlan(oldM, newM);
	}
	dl = dl || new Downloader(client);
	const newFiles = plan.files;
	const total = newFiles.reduce((s, f) => s + f.size, 0);
	const prog = progress('verify', total);
	let bad = 0;
	for (const f of newFiles) {
		const fh = await fsp.open(path.join(GAME, f.filename), 'r+');
		const {size} = await fh.stat();
		if (size !== f.size) await fh.truncate(f.size);
		for (const op of f.ops) {
			const buf = await readAt(fh, op.offset, op.len);
			if (sha1(buf) !== op.sha) {
				bad++;
				const data = await dl.chunk(op.sha);
				await fh.write(data, 0, data.length, op.offset);
			}
			prog.add(op.len);
		}
		await fh.sync();
		await fh.close();
	}
	log(bad ? `Verify repaired ${bad} chunks; run "verify" once more to confirm.` : 'Verify OK: every changed file matches the new build.');
	return bad;
}

// ---------- Steam app manifest ----------

async function fixAcf(client) {
	if (steamRunning()) throw new Error('Close Steam completely first (Steam > Exit), then run again');
	const {newM, newId, buildid} = await getManifests(client);
	const acf = readAcf();
	fs.mkdirSync(STATE, {recursive: true});
	fs.writeFileSync(path.join(STATE, `appmanifest_${APP}.acf.bak`), acf.text);
	const size = String(newM.files.reduce((s, f) => s + (f.flags & 64 ? 0 : f.size), 0));
	const set = (t, k, v) => t.replace(new RegExp(`("${k}"\\s+")[^"]*(")`), `$1${v}$2`);
	let t = acf.text;
	for (const [k, v] of Object.entries({
		StateFlags: '4', buildid, TargetBuildID: buildid, UpdateResult: '0', SizeOnDisk: size,
		BytesToDownload: '0', BytesDownloaded: '0', BytesToStage: '0', BytesStaged: '0',
		LastUpdated: String(Math.floor(Date.now() / 1000)),
	})) t = set(t, k, v);
	t = t.replace(new RegExp(`("${DEPOT}"\\s*\\{\\s*"manifest"\\s+")\\d+("\\s*"size"\\s+")\\d+`), `$1${newId}$2${size}`);
	fs.writeFileSync(ACF, t);

	// park leftover staging folders of the failed update so Steam doesn't resume it
	const parked = path.join(STATE, 'parked-downloading');
	fs.mkdirSync(parked, {recursive: true});
	const dlDir = `${LIB}\\steamapps\\downloading`;
	for (const n of fs.existsSync(dlDir) ? fs.readdirSync(dlDir) : []) {
		if (n === String(APP) || n.startsWith(`depot_${DEPOT}_`) || n.startsWith(`state_${APP}_`)) {
			fs.renameSync(path.join(dlDir, n), path.join(parked, n));
		}
	}
	log(`appmanifest updated to build ${buildid} / manifest ${newId} (backup in state\\). Start Steam, then Properties > Installed Files > Verify integrity.`);
}

// ---------- main ----------

(async () => {
	// double-clicked exe: run everything in one go
	const cmd = process.argv[2] || 'all';
	fs.mkdirSync(STATE, {recursive: true});
	if (cmd === 'all') {
		gui.start();
		try {
			if (steamRunning()) throw new Error('Close Steam completely first (right-click the tray icon > Exit), then start again');
			const client = await login();
			await apply(client);
			await fixAcf(client);
			client.logOff();
			log('Done. Start Steam and run Properties > Installed Files > Verify integrity once.');
			gui.set({finished: true});
		} catch (e) {
			console.error('\nERROR:', e.message);
			gui.set({error: e.message});
		}
		console.log('\nPress Enter to close.');
		process.stdin.once('data', () => process.exit(0));
		return;
	}
	if (cmd === 'plan') {
		const {oldM, newM, newId} = await getManifests(null);
		log(`Comparing installed manifest ${readAcf().manifest} with ${newId} (newest in depotcache)`);
		const plan = buildPlan(oldM, newM);
		summary(plan, schedule(plan));
		return process.exit(0);
	}
	if (!['apply', 'verify', 'fixacf'].includes(cmd)) {
		console.log('usage: node patcher.js plan | apply | verify | fixacf');
		return process.exit(1);
	}
	if (cmd !== 'verify' && steamRunning()) throw new Error('Close Steam completely first (Steam > Exit), then run again');
	const client = await login();
	if (cmd === 'apply') await apply(client);
	if (cmd === 'verify') await verify(client);
	if (cmd === 'fixacf') await fixAcf(client);
	client.logOff();
	setTimeout(() => process.exit(0), 1000);
})().catch(e => {
	console.error('\nERROR:', e.message);
	process.exit(1);
});

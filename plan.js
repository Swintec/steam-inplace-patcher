// Builds the in-place patch plan from two depot manifests. Shared by patcher.js.
const fs = require('fs');
const path = require('path');
const ContentManifest = require('steam-user/components/content_manifest.js');

const DIR_FLAG = 64;

function loadManifest(file) {
	const m = ContentManifest.parse(fs.readFileSync(file));
	if (m.filenames_encrypted) throw new Error(`${file}: filenames are encrypted`);
	for (const f of m.files) {
		f.filename = f.filename.replace(/\//g, '\\');
		f.size = Number(f.size);
		for (const c of f.chunks) c.offset = Number(c.offset);
		f.chunks.sort((a, b) => a.offset - b.offset);
	}
	return m;
}

// ops per changed file: keep (already in place), move (copy from old data), download (new data)
function buildPlan(oldM, newM) {
	const key = n => n.toLowerCase();
	const oldFiles = new Map(oldM.files.filter(f => !(f.flags & DIR_FLAG)).map(f => [key(f.filename), f]));

	// sha -> first known location in the old build
	const oldChunks = new Map();
	for (const f of oldFiles.values()) {
		for (const c of f.chunks) {
			if (!oldChunks.has(c.sha)) oldChunks.set(c.sha, {file: f.filename, offset: c.offset, len: c.cb_original});
		}
	}

	const files = [];
	const totals = {keep: 0, move: 0, download: 0, downloadCompressed: 0, unchangedFiles: 0, changedFiles: 0};
	const newNames = new Set();
	for (const f of newM.files) {
		if (f.flags & DIR_FLAG) continue;
		newNames.add(key(f.filename));
		const old = oldFiles.get(key(f.filename));
		if (old && old.sha_content === f.sha_content && old.size === f.size) {
			totals.unchangedFiles++;
			continue;
		}
		totals.changedFiles++;
		const oldAt = new Map(old ? old.chunks.map(c => [c.offset, c.sha]) : []);
		const ops = f.chunks.map(c => {
			const op = {offset: c.offset, len: c.cb_original, sha: c.sha, compressed: c.cb_compressed};
			if (oldAt.get(c.offset) === c.sha) op.type = 'keep';
			else if (oldChunks.has(c.sha)) { op.type = 'move'; op.src = oldChunks.get(c.sha); }
			else op.type = 'download';
			totals[op.type] += op.len;
			if (op.type === 'download') totals.downloadCompressed += op.compressed;
			return op;
		});
		files.push({filename: f.filename, size: f.size, oldSize: old ? old.size : 0, ops});
	}
	const deleted = [...oldFiles.values()].filter(f => !newNames.has(key(f.filename))).map(f => f.filename);
	return {files, deleted, totals};
}

// Orders the writes so no region is overwritten before every move that reads it has read it.
// Where moves form a cycle, one of them is read into the stash first, which breaks the cycle.
// Returns steps: {op, stash: true} = read the move's source into the stash now;
//                {op} = write op (move: from its source or, if stashed, from the stash; download: from the stash).
function schedule(plan) {
	const ops = [];
	for (const f of plan.files) {
		for (const op of f.ops) {
			if (op.type === 'keep') continue;
			op.file = f.filename.toLowerCase();
			op.id = ops.length;
			ops.push(op);
		}
	}

	// moves that read from each file, sorted by source offset
	const readers = new Map();
	let maxLen = 0;
	for (const op of ops) {
		maxLen = Math.max(maxLen, op.len);
		if (op.type !== 'move') continue;
		const k = op.src.file.toLowerCase();
		if (!readers.has(k)) readers.set(k, []);
		readers.get(k).push(op);
	}
	for (const list of readers.values()) list.sort((a, b) => a.src.offset - b.src.offset);

	// blockedBy[W] = number of moves (other than W) that still have to read W's destination
	const blocks = ops.map(() => []);
	const blockedBy = new Int32Array(ops.length);
	for (const w of ops) {
		const list = readers.get(w.file);
		if (!list) continue;
		const lo = w.offset - maxLen, hi = w.offset + w.len;
		let a = 0, b = list.length;
		while (a < b) { const m = (a + b) >> 1; if (list[m].src.offset < lo) a = m + 1; else b = m; }
		for (let i = a; i < list.length && list[i].src.offset < hi; i++) {
			const r = list[i];
			if (r === w || r.src.offset + r.src.len <= w.offset) continue;
			blocks[r.id].push(w.id);
			blockedBy[w.id]++;
		}
	}

	const read = new Uint8Array(ops.length);   // source has been read (stashed or executed)
	const done = new Uint8Array(ops.length);
	const stashed = new Uint8Array(ops.length);
	const steps = [];
	const ready = [];
	const markRead = id => {
		if (read[id]) return;
		read[id] = 1;
		for (const w of blocks[id]) if (--blockedBy[w] === 0 && !done[w]) ready.push(w);
	};
	// process writes from the end of each file backwards: that matches data shifting towards the end
	const order = ops.slice().sort((a, b) => b.offset - a.offset).map(o => o.id);
	for (const id of order) if (blockedBy[id] === 0) ready.push(id);
	let cursor = 0, stashBytes = 0, finished = 0;
	while (finished < ops.length) {
		if (ready.length) {
			const id = ready.pop();
			if (done[id]) continue;
			done[id] = 1;
			finished++;
			steps.push({op: ops[id]});
			markRead(id);
			continue;
		}
		// stuck on a cycle: stash the next unread move in end-to-start order
		while (cursor < order.length && (read[order[cursor]] || ops[order[cursor]].type !== 'move')) cursor++;
		if (cursor >= order.length) throw new Error('scheduler stuck without a move to stash');
		const id = order[cursor];
		stashed[id] = 1;
		stashBytes += ops[id].len;
		steps.push({op: ops[id], stash: true});
		markRead(id);
	}
	for (const s of steps) if (!s.stash && stashed[s.op.id]) s.fromStash = true;
	return {steps, stashBytes, ops};
}

module.exports = {loadManifest, buildPlan, schedule};

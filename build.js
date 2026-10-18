// Builds dist/ark-patcher.exe (Node single executable application).
const fs = require('fs');
const {execSync} = require('child_process');

require('esbuild').buildSync({
	entryPoints: ['patcher.js'],
	bundle: true,
	platform: 'node',
	target: 'node24',
	outfile: 'dist/bundle.js',
	logLevel: 'warning',
	plugins: [],
});
// steam-crypto reads its public key from disk at load time; inline it
const pem = fs.readFileSync('node_modules/@doctormckay/steam-crypto/system.pem', 'utf8');
let js = fs.readFileSync('dist/bundle.js', 'utf8');
const needle = /require\("fs"\)\.readFileSync\(__dirname \+ "\/system\.pem"\)/;
if (!needle.test(js)) throw new Error('system.pem read not found in bundle');
js = js.replace(needle, `Buffer.from(${JSON.stringify(pem)})`);
fs.writeFileSync('dist/bundle.js', js);

fs.writeFileSync('sea-config.json', JSON.stringify({main: 'dist/bundle.js', output: 'dist/sea.blob', disableExperimentalSEAWarning: true}));
execSync('node --experimental-sea-config sea-config.json', {stdio: 'inherit'});
fs.copyFileSync(process.execPath, 'dist/ark-patcher.exe');
execSync('npx postject dist/ark-patcher.exe NODE_SEA_BLOB dist/sea.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', {stdio: 'inherit'});

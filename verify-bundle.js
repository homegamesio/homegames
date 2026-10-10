#!/usr/bin/env node
// Release gate: inspect the extracted product, then optionally start it using
// its own runtime with empty user data and internet connections disabled.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const vm = require('vm');
const { spawn } = require('child_process');

const TARGETS = ['darwin-arm64', 'darwin-x64', 'win-x64', 'linux-x64'];
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

// Resolve on disk without ever falling back to the build machine's packages.
const packageRoot = (name, from, root) => {
    for (let dir = from; inside(root, dir); dir = path.dirname(dir)) {
        const candidate = path.join(dir, 'node_modules', name);
        if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
        if (dir === root) break;
    }
    throw new Error(`Missing production dependency ${name} (from ${path.relative(root, from)})`);
};

const verifyBundle = (bundleDir, { platforms = TARGETS } = {}) => {
    const root = fs.realpathSync(bundleDir);
    const core = path.join(root, 'homegames-core');
    const errors = [];
    let packages = 0, assets = 0;
    const check = (fn) => { try { return fn(); } catch (err) { errors.push(err.message); } };
    const required = (relative, executable = false) => {
        const file = path.join(root, relative);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile() || !fs.statSync(file).size) {
            throw new Error(`Missing or empty file: ${relative}`);
        }
        if (executable && process.platform !== 'win32' && !(fs.statSync(file).mode & 0o111)) {
            throw new Error(`File is not executable: ${relative}`);
        }
        return file;
    };
    for (const file of [
        'README.txt', 'homegames/index.js', 'homegames-core/index.js',
        'homegames-core/config.json', 'homegames-core/src/web/index.html',
        'homegames-core/src/web/bootstrap.js', 'homegames-core/src/child_game_server.js',
        'homegames-core/node_modules/homegames-client/dist/homegames-client.js',
        'homegames-core/node_modules/homegames-client/src/socket-worker.js',
    ]) check(() => required(file));
    for (const target of platforms) check(() => {
        if (!TARGETS.includes(target)) throw new Error(`Unsupported target: ${target}`);
        required(`runtimes/${target}/${target.startsWith('win-') ? 'node.exe' : 'node'}`, true);
    });
    if (platforms.some(p => p.startsWith('darwin-'))) {
        check(() => required('Play Mac.app/Contents/MacOS/Play Mac', true));
        check(() => required('Play Mac.app/Contents/Info.plist'));
    }
    if (platforms.includes('win-x64')) check(() => required('Play Windows.bat'));
    if (platforms.includes('linux-x64')) check(() => required('play-linux.sh', true));

    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name), relative = path.relative(root, file);
            if (entry.isSymbolicLink()) { errors.push(`Bundle contains a symlink: ${relative}`); continue; }
            if (['.git', '.hg_auth', 'hg-certs', '.save-data', '.env'].includes(entry.name)) {
                errors.push(`Bundle contains development or private state: ${relative}`);
                continue;
            }
            if (/\.(node|dylib|so|dll)$/.test(entry.name)) errors.push(`Platform-specific native dependency in shared bundle: ${relative}`);
            if (entry.isDirectory()) walk(file);
        }
    };
    check(() => walk(root));

    const visited = new Set();
    const dependencies = (dir) => {
        if (visited.has(dir)) return;
        visited.add(dir);
        const metadata = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        packages++;
        for (const name of Object.keys(metadata.dependencies || {})) {
            if (metadata.optionalDependencies?.[name]) continue;
            check(() => dependencies(packageRoot(name, dir, root)));
        }
    };
    check(() => dependencies(core));
    check(() => {
        const common = packageRoot('homegames-common', core, root);
        const source = fs.readFileSync(path.join(common, 'game-loader.js'), 'utf8');
        for (const alias of new Set(source.match(/squish-\d+/g) || [])) {
            const dependency = packageRoot(alias, core, root);
            dependencies(dependency);
        }
    });
    check(() => {
        const config = JSON.parse(fs.readFileSync(path.join(core, 'config.json'), 'utf8'));
        if (config.START_PATH) {
            const startPath = path.resolve(core, config.START_PATH);
            if (!inside(core, startPath) || !fs.existsSync(startPath)) throw new Error('START_PATH is missing or points outside the bundle');
        }
        const assetDir = path.resolve(core, config.BUNDLED_ASSET_PATH || '');
        if (!inside(root, assetDir) || assetDir === core) throw new Error('BUNDLED_ASSET_PATH must point inside the bundle');
        const manifest = JSON.parse(fs.readFileSync(path.join(assetDir, 'manifest.json'), 'utf8'));
        if (!Array.isArray(manifest) || !manifest.length) throw new Error('Bundled asset manifest is empty or invalid');
        const ids = new Set();
        for (const asset of manifest) {
            if (typeof asset.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(asset.id)) throw new Error('Invalid bundled asset id');
            if (ids.has(asset.id)) throw new Error(`Duplicate bundled asset: ${asset.id}`);
            ids.add(asset.id);
            required(path.relative(root, path.join(assetDir, asset.id)));
        }
        const { collectAssetDeclarations } = require('./build-bundle');
        const gameKey = config.START_PATH ? path.basename(config.START_PATH.replace(/[/\\]index\.js$/, '')) : null;
        const declarations = collectAssetDeclarations(core, gameKey).assets;
        for (const declaration of declarations) {
            if (!ids.has(declaration.id)) throw new Error(`Missing declared asset in bundle manifest: ${declaration.key} (${declaration.id})`);
        }
        assets = ids.size;
    });
    for (const relative of ['homegames/index.js', 'homegames-core/src/web/bootstrap.js',
        'homegames-core/node_modules/homegames-client/dist/homegames-client.js',
        'homegames-core/node_modules/homegames-client/src/socket-worker.js']) {
        check(() => new vm.Script(fs.readFileSync(path.join(root, relative), 'utf8'), { filename: relative }));
    }
    if (errors.length) throw new Error(`Bundle verification failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    return { root, packages, assets, platforms };
};

const get = (url, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error(`Timed out: ${url}`)));
    req.end(body);
});
const freePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(err => err ? reject(err) : resolve(port));
    });
});

// Test-only isolation: published Squish versions have their own state-path
// helper. Redirect those to the same temporary data root, disable external
// network access, and fail any attempted write into the supplied bundle.
const preloadSource = `
const fs = require('fs'), path = require('path'), net = require('net'), Module = require('module'), cp = require('child_process');
const root = process.env.HG_VERIFY_BUNDLE_ROOT;
const fork = cp.fork;
cp.fork = function(file, args, options = {}) {
    if (!path.resolve(file).startsWith(root + path.sep)) throw new Error('Bundle attempted to start an external package: ' + file);
    return fork.call(this, file, args, { ...options,
        execArgv: [...(options.execArgv || process.execArgv), '--require', __filename],
        env: { ...(options.env || process.env), HG_VERIFY_BUNDLE_ROOT: root, HG_APP_DATA_DIR: process.env.HG_APP_DATA_DIR },
    });
};
const load = Module._load;
Module._load = function(request, parent, ...rest) {
    const result = load.call(this, request, parent, ...rest);
    if (request === './utils' && parent?.filename?.startsWith(root + path.sep)
        && /[/\\\\]squish-[^/\\\\]+[/\\\\]src[/\\\\]/.test(parent.filename) && result.getAppDataPath) {
        result.getAppDataPath = () => process.env.HG_APP_DATA_DIR;
    }
    return result;
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
    let options = args[0];
    if (Array.isArray(options)) options = options[0];
    const host = options && typeof options === 'object' ? options.host : typeof args[1] === 'string' ? args[1] : undefined;
    if (options?.path || (host && !['localhost', '127.0.0.1', '::1'].includes(host))) {
        queueMicrotask(() => this.destroy(Object.assign(new Error('Internet disabled by bundle verifier'), { code: 'ENETUNREACH' })));
        return this;
    }
    return connect.apply(this, args);
};
const guard = file => {
    if (typeof file !== 'string' && !Buffer.isBuffer(file) && !(file instanceof URL)) return;
    const filename = path.resolve(file instanceof URL ? require('url').fileURLToPath(file) : String(file));
    if (filename === root || filename.startsWith(root + path.sep)) {
        console.error('[bundle-smoke-write] ' + filename);
        throw Object.assign(new Error('Bundle is read-only during verification: ' + filename), { code: 'EROFS' });
    }
};
for (const name of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'truncate', 'truncateSync']) {
    const original = fs[name];
    fs[name] = function(file, ...args) { guard(file); return original.call(this, file, ...args); };
}
for (const name of ['copyFile', 'copyFileSync', 'rename', 'renameSync']) {
    const original = fs[name];
    fs[name] = function(source, target, ...args) { guard(target); if (name.startsWith('rename')) guard(source); return original.call(this, source, target, ...args); };
}
for (const name of ['open', 'openSync']) {
    const original = fs[name];
    fs[name] = function(file, flags, ...args) {
        if (typeof flags === 'number' ? !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) : /[wa+]/.test(flags)) guard(file);
        return original.call(this, file, flags, ...args);
    };
}
`;

const smokeBundle = async (bundleDir, { runtime = null, inspect = null, macLauncher = false } = {}) => {
    if (macLauncher && process.platform !== 'darwin') throw new Error('--mac-launcher requires macOS');
    const root = fs.realpathSync(bundleDir), core = path.join(root, 'homegames-core');
    const target = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
    const executable = macLauncher ? path.join(root, 'Play Mac.app', 'Contents', 'MacOS', 'Play Mac')
        : runtime || path.join(root, 'runtimes', target, process.platform === 'win32' ? 'node.exe' : 'node');
    if (!fs.existsSync(executable)) throw new Error(`Smoke test needs its launcher/runtime: ${executable}`);
    const [homePort, namesPort, gamePort] = await Promise.all([freePort(), freePort(), freePort()]);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'homegames-verify-'));
    const preload = path.join(temp, 'isolate.cjs');
    fs.writeFileSync(preload, preloadSource);
    const env = {
        PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR,
        TMPDIR: temp, TMP: temp, TEMP: temp,
        HG_APP_DATA_DIR: path.join(temp, 'state'), HG_VERIFY_BUNDLE_ROOT: root,
        HG_NO_OPEN: 'true', NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
        HOME_PORT: String(homePort), HOMENAMES_PORT: String(namesPort),
        GAME_SERVER_PORT_RANGE_MIN: String(gamePort), GAME_SERVER_PORT_RANGE_MAX: String(gamePort),
        FORK_SESSIONS_ENABLED: 'true', LINK_ENABLED: 'false', HTTPS_ENABLED: 'false',
        ERROR_REPORTING: 'false', PUBLIC_GAMES: 'false', API_URL: 'http://127.0.0.1:1',
    };
    const child = spawn(executable, macLauncher ? [] : [path.join(root, 'homegames', 'index.js'), '--no-open'], {
        cwd: temp, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '', spawnError = null, exited = false;
    child.on('error', error => { spawnError = error; });
    child.on('exit', () => { exited = true; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes.toString()).slice(-200000); });
    // The actual SEA app sends supervisor output to a user-data log file.
    // Read appended bytes only, keeping the same bounded diagnostic tail.
    const logOffsets = new Map();
    const readLauncherLogs = () => {
        if (!macLauncher) return;
        const logDirectory = path.join(env.HG_APP_DATA_DIR, 'logs');
        if (!fs.existsSync(logDirectory)) return;
        for (const name of fs.readdirSync(logDirectory).filter(name => /^launcher-\d+\.log$/.test(name))) {
            const file = path.join(logDirectory, name), size = fs.statSync(file).size;
            const offset = Math.max(logOffsets.get(file) || 0, size - 200000);
            if (size <= offset) continue;
            const data = Buffer.alloc(size - offset), fd = fs.openSync(file, 'r');
            try {
                const read = fs.readSync(fd, data, 0, data.length, offset);
                logs = (logs + data.subarray(0, read).toString()).slice(-200000);
                logOffsets.set(file, offset + read);
            } finally { fs.closeSync(fd); }
        }
    };
    const stop = async () => {
        if (process.platform === 'win32') {
            if (child.pid) await new Promise(resolve => {
                const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
                taskkill.on('error', resolve); taskkill.on('exit', resolve);
            });
        } else if (child.pid) {
            try { process.kill(-child.pid, 'SIGTERM'); } catch (_) {}
            if (macLauncher) {
                // The app owns a separate supervisor process group and grants
                // it three seconds to stop before it kills any stragglers.
                const deadline = Date.now() + 4000;
                while (!exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
            } else await new Promise(resolve => setTimeout(resolve, 200));
            try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
        }
    };
    try {
        const started = Date.now();
        for (;;) {
            readLauncherLogs();
            if (logs.includes('[homegames] Homegames is ready')) break;
            if (spawnError) throw spawnError;
            if (exited) throw new Error('Launcher exited before it was ready');
            if (/\[FATAL\]|\[bundle-smoke-write\]|MODULE_NOT_FOUND|EADDRINUSE/.test(logs)) throw new Error('Runtime failed before reporting readiness');
            if (Date.now() - started > 45000) throw new Error('Launcher did not report readiness within 45 seconds');
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!logs.includes('[homegames] Using homegames-core at ' + path.join(core, 'index.js'))) {
            throw new Error('Launcher did not use the extracted bundle core');
        }
        const base = `http://127.0.0.1:${homePort}`;
        for (const route of ['/', '/bootstrap.js', '/homegames-client.js', '/socket-worker.js']) {
            const response = await get(base + route);
            if (response.status !== 200 || !response.body.length) throw new Error(`Required browser route failed: ${route} (${response.status})`);
            if (route.endsWith('.js')) new vm.Script(response.body.toString(), { filename: route });
        }
        const bootResponse = await get(base + '/boot.json');
        const boot = bootResponse.status === 200 ? JSON.parse(bootResponse.body) : null;
        let manifests = 0;
        if (boot?.mode === 'browser') {
            await checkManifest(base, boot.manifestUrl); manifests++;
        } else {
            const WebSocket = require(path.join(packageRoot('ws', core, root), 'index.js'));
            await socketFrames(WebSocket, `ws://127.0.0.1:${homePort}`, true);
            // A representative built-in game's real browser manifest and asset
            // bundle exercise source collection beyond the dashboard itself.
            const gamePath = path.join(core, 'src', 'games', 'tic-tac-toe', 'index.js');
            if (!fs.existsSync(gamePath)) throw new Error('Missing representative built-in game tic-tac-toe');
            const localPlay = require(path.join(packageRoot('homegames-common', core, root), 'local-play.js'));
            const metadata = localPlay.parseGameSourceMetadata(fs.readFileSync(gamePath, 'utf8'));
            const key = metadata.className || fs.readFileSync(gamePath, 'utf8').match(/class\s+(\w+)\s+extends/)?.[1];
            if (!key) throw new Error('Cannot resolve representative game class');
            await checkManifest(base, `/games/${encodeURIComponent(key)}/local-manifest`); manifests++;
            const created = await get(`http://127.0.0.1:${namesPort}/sessions`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ gamePath, noFrame: true }),
            });
            if (![200, 201].includes(created.status)) throw new Error(`Cannot start bundled game: ${created.body}`);
            const game = JSON.parse(created.body);
            await socketFrames(WebSocket, `ws://127.0.0.1:${game.port}`, false);
        }
        readLauncherLogs();
        if (/\[FATAL\]|\[bundle-smoke-write\]|MODULE_NOT_FOUND|ENOENT|EADDRINUSE/.test(logs)) throw new Error('Runtime emitted a fatal, missing-file, port, or read-only violation');
        // Optional manual browser inspection shares this run's isolated state,
        // offline policy, and process cleanup. The CLI never waits for input.
        if (inspect) await inspect({ url: base, root, logs });
        return { target, launcher: macLauncher ? 'mac-app' : 'supervisor', browserRoutes: 4, manifests, dashboard: !boot, gameSession: !boot };
    } catch (error) {
        readLauncherLogs();
        throw new Error(`${error.message}\nRecent bundle output:\n${logs.slice(-16000)}`);
    } finally {
        await stop();
        fs.rmSync(temp, { recursive: true, force: true });
    }
};

const checkManifest = async (base, route) => {
    const response = await get(new URL(route, base));
    if (response.status !== 200) throw new Error(`Game manifest failed: ${route} (${response.status})`);
    const manifest = JSON.parse(response.body);
    if (!manifest.files?.[manifest.entryPoint] || !manifest.localPlayable) throw new Error(`Game is not locally playable: ${route}`);
    for (const [name, source] of Object.entries(manifest.files)) new vm.Script(source, { filename: name });
    if (manifest.assetBundleUrl) {
        const assetResponse = await get(new URL(manifest.assetBundleUrl, base));
        if (assetResponse.status !== 200) throw new Error(`Game asset bundle failed: ${manifest.assetBundleUrl}`);
    }
};

const socketFrames = (WebSocket, url, expectAssets) => new Promise((resolve, reject) => {
    const socket = new WebSocket(url), seen = new Set();
    const finish = error => { clearTimeout(timer); socket.terminate(); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => finish(new Error(`WebSocket did not deliver init${expectAssets ? ', assets' : ''}, and a frame: ${url} (received ${[...seen]})`)), 15000);
    socket.on('error', finish);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'ready', clientInfo: { clientInfo: { aspectRatio: { x: 16, y: 9 }, deviceType: 'desktop' } } })));
    socket.on('message', data => {
        seen.add(data[0]);
        if (seen.has(2) && seen.has(3) && (!expectAssets || seen.has(1))) finish();
    });
});

const parseVerificationArgs = (argv) => {
    const args = [...argv];
    if (!args[0] || args[0].startsWith('--')) throw new Error('Usage: node verify-bundle.js <bundleDir> [--platforms darwin-arm64,...|none] [--smoke] [--mac-launcher]');
    const bundleDir = args.shift();
    let platforms = TARGETS, smoke = false, macLauncher = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--smoke') smoke = true;
        else if (args[i] === '--mac-launcher') { macLauncher = true; smoke = true; }
        else if (args[i] === '--platforms' && args[i + 1]) platforms = args[++i] === 'none' ? [] : args[i].split(',');
        else throw new Error(`Unknown verification argument: ${args[i]}`);
    }
    return { bundleDir, platforms, smoke, macLauncher };
};

const main = async () => {
    const { bundleDir, platforms, smoke, macLauncher } = parseVerificationArgs(process.argv.slice(2));
    const result = verifyBundle(bundleDir, { platforms });
    console.log(`[verify] Layout complete: ${result.packages} production packages, ${result.assets} assets, ${platforms.length} runtimes`);
    if (smoke) console.log(`[verify] Offline runtime smoke passed: ${JSON.stringify(await smokeBundle(bundleDir, { macLauncher }))}`);
};

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { verifyBundle, smokeBundle, packageRoot, parseVerificationArgs, TARGETS };

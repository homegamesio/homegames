// Copy the installed production dependency graph without shipping the developer's
// checkout state, dev dependencies, or links back to sibling repositories.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const PRIVATE_NAMES = new Set(['.git', '.hg_auth', '.hg_certs', 'hg-certs', '.asset_cache',
    '.save-data', '.claude', '.cursor', '.codex', '.agents', '.DS_Store', '.npmrc', '.netrc', '.git-credentials', '.ssh',
    'node_modules', 'hg-games', 'homegames_log.txt']);
const packageNames = new Map();

function packageDirectory(name, from) {
    const req = createRequire(path.join(from, 'package.json'));
    for (const base of req.resolve.paths(`${name}/package.json`) || []) {
        const dir = path.join(base, name);
        if (fs.existsSync(path.join(dir, 'package.json'))) return fs.realpathSync(dir);
    }
    throw new Error(`Missing production dependency ${name} required by ${from}; install dependencies first.`);
}

function includeFile(src, root) {
    const rel = path.relative(root, src);
    if (!rel) return true;
    const parts = rel.split(path.sep);
    if (parts.some(p => PRIVATE_NAMES.has(p) || p === '.env' || p.startsWith('.env.') || p.endsWith('.env'))) return false;
    if (/^probe.*\.tmp\.js$/.test(path.basename(src))) return false;
    if (/\.(pem|key|p12|pfx)$/.test(src)) return false;
    // Both are optional accelerators with tested JS fallbacks in ssh2. A
    // developer's native build is unusable on the other bundled platforms.
    if (!packageNames.has(root)) packageNames.set(root, fs.existsSync(path.join(root, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).name : null);
    const name = packageNames.get(root);
    if (name === 'cpu-features' && parts[0] === 'build') return false;
    if (name === 'ssh2' && rel.split(path.sep).join('/').startsWith('lib/protocol/crypto/build')) return false;
    if (/\.(node|dylib|so|dll)$/.test(src)) throw new Error(`Platform-specific dependency cannot ship in a universal bundle: ${src}`);
    return true;
}

function copyProductionTree(source, destination) {
    const installed = new Map();
    const rootModules = path.join(destination, 'node_modules');
    function copyPackage(src, dest) {
        installed.set(dest, fs.realpathSync(src));
        fs.cpSync(src, dest, { recursive: true, dereference: true, filter: file => {
            if (!includeFile(file, src)) return false;
            const rel = path.relative(src, file).split(path.sep).join('/');
            if (src === source && ['dist', 'hg-games', 'wip', 'tools', 'homegames_log.txt'].includes(rel.split('/')[0])) return false;
            if (src === source && rel.startsWith('src/games/') && Object.hasOwn(require('./release-games.json').excluded, rel.split('/')[2])) return false;
            return true;
        }});
        const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json')));
        const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
        // postinstall creates these aliases in source checkouts; reproduce them
        // as real packages so game imports work after extraction on Windows.
        if (src === source && pkg.name === 'homegames-core') {
            const common = packageDirectory('homegames-common', src);
            Object.assign(deps, Object.fromEntries(Object.values(require(path.join(common, 'game-loader')).squishMap).map(n => [n, '*'])));
        }
        const pending = [];
        for (const name of Object.keys(deps)) {
            let dep;
            try { dep = packageDirectory(name, src); }
            catch (err) { if (pkg.optionalDependencies?.[name]) continue; throw err; }
            let current = dest;
            let found;
            while (current.startsWith(destination)) {
                const candidate = path.join(current, 'node_modules', name);
                if (installed.has(candidate)) { found = installed.get(candidate); break; }
                const parent = path.dirname(current);
                if (parent === current) break;
                current = parent;
            }
            if (found === dep) continue;
            const hoisted = path.join(rootModules, name);
            const target = !found && !installed.has(hoisted) ? hoisted : path.join(dest, 'node_modules', name);
            if (installed.get(target) === dep) continue;
            if (installed.has(target)) throw new Error(`Conflicting dependency ${name} at ${target}`);
            // Reserve siblings before traversing transitive dependencies, so
            // a transitive version cannot take a direct dependency's slot.
            installed.set(target, dep);
            pending.push([dep, target]);
        }
        for (const [dep, target] of pending) copyPackage(dep, target);
    }
    copyPackage(fs.realpathSync(source), destination);
}

module.exports = { copyProductionTree, packageDirectory, includeFile };

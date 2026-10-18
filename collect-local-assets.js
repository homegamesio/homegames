'use strict';
const fs = require('fs');
const path = require('path');
const { packageDirectory } = require('./build-support');

// These two historical fixtures compute their assets dynamically. Keep them
// hidden like the website does, but only while their metadata explicitly says
// isTest: true. All other parse failures still stop a release.
function readReleaseMetadata(core, name, source) {
    const common = packageDirectory('homegames-common', core);
    const meta = require(path.join(common, 'local-play')).parseGameSourceMetadata(source);
    if (meta.error && ['iron-keep', 'sprite-test'].includes(name)) {
        const { walk } = require(path.join(common, 'game-metadata'));
        const acorn = require(path.join(packageDirectory('acorn', core), 'dist/acorn.js'));
        const flags = [];
        walk(acorn.parse(source, { ecmaVersion: 'latest' }), node => {
            if (node.type !== 'MethodDefinition' || !node.static || node.computed || node.key.name !== 'metadata') return;
            for (const statement of node.value.body.body) {
                if (statement.type !== 'ReturnStatement' || statement.argument?.type !== 'ObjectExpression') continue;
                for (const prop of statement.argument.properties) {
                    if (prop.type === 'Property' && !prop.computed && (prop.key.name ?? prop.key.value) === 'isTest') flags.push(prop.value);
                }
            }
        });
        if (flags.length === 1 && flags[0].type === 'Literal' && flags[0].value === true) meta.isTest = true;
    }
    return meta;
}

function collectLocalAssets(core, selectedGame) {
    const acorn = require(path.join(packageDirectory('acorn', core), 'dist/acorn.js'));
    const legacy = new Map(), local = new Map();
    const inspect = (entry, { game = false } = {}) => {
        const root = path.dirname(entry), seen = new Set();
        const record = (reference, key, type) => {
            if (/^[a-f0-9]{32}$/.test(reference)) { legacy.set(reference, { id: reference, key, type }); return; }
            if (!reference.startsWith('./')) throw new Error(`Asset must use a game-relative file path: ${entry}: ${reference}`);
            const realRoot = fs.realpathSync(root), file = fs.realpathSync(path.resolve(root, reference));
            if (!file.startsWith(realRoot + path.sep) || !fs.statSync(file).isFile() || !fs.statSync(file).size) throw new Error(`Missing or unsafe local asset: ${entry}: ${reference}`);
            local.set(file, { path: path.relative(core, file), sizeBytes: fs.statSync(file).size });
        };
        const read = filename => {
            if (seen.has(filename)) return; seen.add(filename);
            const source = fs.readFileSync(filename, 'utf8');
            if (path.extname(filename) === '.json') {
                try { JSON.parse(source); }
                catch (error) { throw new Error(`Invalid JSON game data: ${filename}: ${error.message}`); }
                return;
            }
            const visit = node => {
                if (!node || typeof node.type !== 'string') return;
                if (node.type === 'Property' && (node.key.name || node.key.value) === 'thumbnail' && typeof node.value.value === 'string') record(node.value.value, 'thumbnail', 'image');
                if (node.type === 'NewExpression' && node.callee.name === 'Asset' && node.arguments[0]?.type === 'ObjectExpression') {
                    const info = Object.fromEntries(node.arguments[0].properties.filter(p => p.type === 'Property').map(p => [p.key.name || p.key.value, p.value.value]));
                    if (typeof info.path === 'string') record(info.path, info.path, info.type);
                    else if (node.arguments.length < 2 && typeof info.id === 'string') record(info.id, info.id, info.type);
                }
                if (game && node.type === 'CallExpression' && node.callee.name === 'require' && typeof node.arguments[0]?.value === 'string') {
                    const request = node.arguments[0].value;
                    if (!/^squish-\d+$/.test(request)) {
                        if (!request.startsWith('./') && !request.startsWith('../')) throw new Error(`Game depends on an external module: ${filename}: ${request}`);
                        const base = path.resolve(path.dirname(filename), request);
                        const target = [base, base + '.js', base + '.json', path.join(base, 'index.js')].find(f => fs.existsSync(f) && fs.statSync(f).isFile());
                        if (!target || !fs.realpathSync(target).startsWith(fs.realpathSync(root) + path.sep)) throw new Error(`Game dependency must be inside its folder: ${filename}: ${request}`);
                        read(target);
                    }
                }
                for (const value of Object.values(node)) {
                    if (Array.isArray(value)) value.forEach(visit);
                    else if (value && typeof value.type === 'string') visit(value);
                }
            };
            visit(acorn.parse(source, { ecmaVersion: 'latest' }));
        };
        read(entry);
    };
    for (const name of fs.readdirSync(path.join(core, 'src/games'))) {
        const entry = path.join(core, 'src/games', name, 'index.js'); if (!fs.existsSync(entry)) continue;
        const meta = readReleaseMetadata(core, name, fs.readFileSync(entry, 'utf8'));
        if (meta.isTest && name !== selectedGame) continue;
        if (meta.error) throw new Error(`${entry}: ${meta.error}`);
        inspect(entry, { game: true });
    }
    inspect(path.join(core, 'src/homegames_root/HomegamesRoot.js'));
    inspect(path.join(core, 'src/dashboard/HomegamesDashboard.js'));
    return { assets: [...legacy.values()], localAssets: [...local.values()], critical: new Set(legacy.keys()) };
}
module.exports = { collectLocalAssets, readReleaseMetadata };

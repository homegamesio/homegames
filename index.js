const { fork } = require('child_process');
const path = require('path');
const process = require('process');

process.env.LINK_ENABLED = true;

const hgCorePath = path.join(__dirname, 'node_modules/homegames-core');
const hgWebPath = path.join(__dirname, 'node_modules/homegames-web');

const webBundlePath = path.join(__dirname, 'node_modules/homegames-web/web/bundle.js');

fork(`${hgCorePath}/index.js`);

console.log('starting web server in 20 seconds');
setTimeout(() => {
    fork(`${hgWebPath}/index.js`);
}, 20 * 1000);

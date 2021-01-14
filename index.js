const { fork } = require('child_process');
const path = require('path');

const hgCorePath = path.join(__dirname, 'node_modules/homegames-core');
const hgWebPath = path.join(__dirname, 'node_modules/homegames-web');

const webBundlePath = path.join(__dirname, 'node_modules/homegames-web/web/bundle.js');

fork(`${hgCorePath}/index.js`);
fork(`${hgWebPath}/index.js`);

const { fork } = require('child_process');
const path = require('path');
const process = require('process');
const squish061 = require('squish-061');
const squish063 = require('squish-063');
const squish0631 = require('squish-0631');
const squish0632 = require('squish-0632');
const squish0633 = require('squish-0633');

process.env.LINK_ENABLED = true;

const hgCorePath = path.join(__dirname, 'node_modules/homegames-core');
const hgWebPath = path.join(__dirname, 'node_modules/homegames-web');

const webBundlePath = path.join(__dirname, 'node_modules/homegames-web/web/bundle.js');

fork(`${hgCorePath}/index.js`);
fork(`${hgWebPath}/index.js`);

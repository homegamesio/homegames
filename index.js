const { fork } = require('child_process');

fork('./node_modules/homegames-core/index.js');
fork('./node_modules/homegames-web/index.js');

import { promises as fs } from 'node:fs';

import { app } from './app.js';
import { config } from './config.js';

// Express 5 calls back with the error when the server cannot listen, and without handling it a port
// that is already taken would end the process with nothing said about why.
app.listen(config.port, async (error?: NodeJS.ErrnoException) => {
    if (error) {
        console.error(error.code === 'EADDRINUSE'
            ? `Port ${config.port} is already in use, set PORT to another one`
            : `Server failed to start: ${error.message}`);
        process.exit(1);
    }
    console.log(`Server starting on port ${config.port}`);
    await fs.mkdir(config.storageDir, { recursive: true });
    console.log(`Server started on port ${config.port}, storing images in ${config.storageDir}`);
});

process.on('SIGINT', function () {
    console.log('Gracefully shutting down from SIGINT (Ctrl-C)');
    process.exit();
});

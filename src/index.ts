import { promises as fs } from 'node:fs';

import { app } from './app.js';
import { config } from './config.js';

app.listen(config.port, async () => {
    console.log(`Server starting on port ${config.port}`);
    await fs.mkdir(config.storageDir, { recursive: true });
    console.log(`Server started on port ${config.port}, storing images in ${config.storageDir}`);
});

process.on('SIGINT', function () {
    console.log('Gracefully shutting down from SIGINT (Ctrl-C)');
    process.exit();
});

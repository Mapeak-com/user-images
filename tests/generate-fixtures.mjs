import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

/**
 * Builds the images the http tests upload. They are generated rather than committed so that the
 * repository holds no binaries, and so that a test can be given a different picture by changing
 * two numbers here.
 */
const fixtures = [
    { name: 'landscape.jpg', width: 1200, height: 800, background: { r: 40, g: 90, b: 140 } },
    { name: 'other.jpg', width: 640, height: 480, background: { r: 150, g: 40, b: 40 } }
];

await mkdir(new URL('./fixtures/', import.meta.url), { recursive: true });
for (const fixture of fixtures) {
    const content = await sharp({
        create: {
            width: fixture.width,
            height: fixture.height,
            channels: 3,
            background: fixture.background
        }
    }).jpeg().toBuffer();
    await writeFile(new URL(`./fixtures/${fixture.name}`, import.meta.url), content);
}
console.log(`Wrote ${fixtures.length} fixtures`);

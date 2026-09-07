import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceLogo = path.resolve(__dirname, '../assets/spotify-logo.png');
const targetDir = path.resolve(__dirname, '../../songs');

const icons = [
  { name: 'favicon-16x16.png', size: 16, format: 'png' },
  { name: 'favicon-32x32.png', size: 32, format: 'png' },
  { name: 'apple-touch-icon.png', size: 180, format: 'png' },
  { name: 'icon-192x192.png', size: 192, format: 'png' },
  { name: 'icon-512x512.png', size: 512, format: 'png' },
  { name: 'favicon.ico', size: 32, format: 'ico' },
];

async function generate() {
  console.log(`Generating Spotibai icons from ${sourceLogo}...`);
  for (const icon of icons) {
    const outputPath = path.join(targetDir, icon.name);
    let pipeline = sharp(sourceLogo).resize(icon.size, icon.size);
    if (icon.format === 'png') {
      pipeline = pipeline.png();
    }
    await pipeline.toFile(outputPath);
    console.log(`✓ Generated ${icon.name} (${icon.size}x${icon.size})`);
  }
  console.log('Icon generation complete!');
}

generate().catch((err) => {
  console.error('Error generating icons:', err);
  process.exit(1);
});

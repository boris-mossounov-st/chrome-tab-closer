// Renders icon.svg into the PNG sizes Chrome needs (manifest icons can't be SVG).
// Usage: npm run icons
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync(new URL('../icon.svg', import.meta.url));
const outDir = new URL('../public/icons/', import.meta.url);
mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(new URL(`icon-${size}.png`, outDir), png);
  console.log(`public/icons/icon-${size}.png`);
}

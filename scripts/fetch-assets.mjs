// Downloads the runtime resources the game pulls from online.
//
//   node scripts/fetch-assets.mjs
//
// By default the game streams three.js straight from a CDN at page load. Running
// this script vendors the same files into public/vendor/ so the game also runs
// offline; index.html prefers the local copy when it is present.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(__dirname, '..', 'public', 'vendor');

const THREE_VERSION = '0.169.0';
const RESOURCES = [
  {
    name: 'three.module.js',
    url: `https://unpkg.com/three@${THREE_VERSION}/build/three.module.js`,
    desc: 'three.js core (WebGL renderer)',
  },
  {
    name: 'three.webgpu.nodes.js.SKIP',
    url: null,
    desc: 'placeholder — not needed',
  },
];

async function download(res) {
  if (!res.url) return;
  process.stdout.write(`  fetching ${res.desc} ... `);
  const r = await fetch(res.url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${res.url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(path.join(VENDOR, res.name), buf);
  console.log(`ok (${(buf.length / 1024).toFixed(0)} KB)`);
}

async function main() {
  fs.mkdirSync(VENDOR, { recursive: true });
  console.log(`\nDownloading online resources into public/vendor ...\n`);
  for (const r of RESOURCES) {
    try {
      await download(r);
    } catch (e) {
      console.log(`FAILED\n    ${e.message}`);
      console.log(`    (the game will fall back to the CDN at runtime)`);
    }
  }
  fs.writeFileSync(
    path.join(VENDOR, 'manifest.json'),
    JSON.stringify({ three: THREE_VERSION, fetchedAt: new Date().toISOString() }, null, 2)
  );
  console.log(`\nDone. Run "npm start" and open http://localhost:8080\n`);
}

main();

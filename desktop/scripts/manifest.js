#!/usr/bin/env node
// Writes the release manifest the desktop updater reads (latest.json): version, notes and each installer's SHA-256.
// usage: node scripts/manifest.js <folder with installers> <tag, e.g. desktop-v0.3.0> [notes file] > latest.json
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [dir, tag, notesFile] = process.argv.slice(2);
if (!dir || !tag) { console.error('usage: manifest.js <dir> <tag> [notes]'); process.exit(2); }
const sha256 = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

(async () => {
  const names = fs.readdirSync(dir).filter((f) => /\.(dmg|exe|AppImage|deb)$/.test(f)).sort();
  const files = [];
  for (const name of names) {
    const p = path.join(dir, name);
    files.push({ name, size: fs.statSync(p).size, sha256: await sha256(p), url: `https://github.com/doguri25/cardnovel/releases/download/${tag}/${encodeURIComponent(name)}` });
  }
  const notes = notesFile && fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : '';
  process.stdout.write(JSON.stringify({ version: tag.replace(/^desktop-v/, ''), tag, date: new Date().toISOString(), notes, files }, null, 1) + '\n');
})();

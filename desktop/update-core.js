// Helpers of the desktop shell and its updater (no Electron here, so they can be tested with `node --test`).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

/** "desktop-v0.3.1" / "v0.3.1" / "0.3.1" → [0, 3, 1]; null when it is not a version. */
function parseVersion(s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** true when `candidate` is a later version than `current`. */
function isNewer(candidate, current) {
  const a = parseVersion(candidate), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** How this copy of the app was installed, which decides the file to download and how to install it. */
function installKind(platform, env) {
  if (platform === 'darwin') return 'dmg';
  if (platform === 'win32') return 'nsis';
  if (platform === 'linux') return env && env.APPIMAGE ? 'appimage' : 'deb';
  return null;
}

const SUFFIX = {
  dmg: (arch) => `-mac-${arch === 'x64' ? 'x64' : 'arm64'}.dmg`,
  nsis: () => '-win-x64.exe',
  appimage: () => '-linux-x86_64.AppImage',
  deb: () => '-linux-amd64.deb',
};

/**
 * The installer for this computer from the release manifest (latest.json, written by CI next to the installers):
 * { version, tag, notes, files: [{ name, size, sha256, url }] } → { version, name, url, size, sha256, notes } or null.
 */
function releaseInfo(manifest, kind, arch) {
  if (!manifest || !SUFFIX[kind] || !Array.isArray(manifest.files)) return null;
  const version = parseVersion(manifest.version || manifest.tag);
  if (!version) return null;
  const suffix = SUFFIX[kind](arch);
  const f = manifest.files.find((x) => x && typeof x.name === 'string' && x.name.endsWith(suffix));
  if (!f || !/^https:\/\/github\.com\/doguri25\/cardnovel\/releases\/download\//.test(f.url || '')) return null;
  if (!/^[0-9a-f]{64}$/i.test(f.sha256 || '')) return null; // never install a file that cannot be checked
  return {
    version: version.join('.'),
    name: f.name.replace(/[^A-Za-z0-9._-]/g, '_'),
    url: f.url,
    size: Number(f.size) || 0,
    sha256: f.sha256.toLowerCase(),
    notes: notesSummary(manifest.notes || ''),
  };
}

/** The "what's new" part of the release notes, a few lines, without markdown marks. */
function notesSummary(body, max = 8) {
  const lines = String(body).split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s.*새로워진/.test(l));
  const part = start >= 0 ? lines.slice(start + 1) : lines;
  const end = part.findIndex((l) => /^##\s/.test(l));
  return (end >= 0 ? part.slice(0, end) : part)
    .map((l) => l.replace(/\*\*/g, '').replace(/^\s*[-*]\s*/, '· ').trim())
    .filter((l) => l && !/^\|/.test(l))
    .slice(0, max)
    .join('\n');
}

/**
 * A new folder for one download that only this user can open (mode 0700, a name nobody can guess).
 * On Ubuntu the temp folder is /tmp, which every account shares: a fixed folder there may belong to another
 * account, which could then swap the installer after it was checked and before it is installed (as root, for a .deb).
 */
function makeDownloadDir(tempRoot) {
  return fs.mkdtempSync(path.join(tempRoot, 'cardnovel-update-'));
}

/**
 * Writes the downloaded chunks to a new file (never through a file or link that is already there) and checks it:
 * the SHA-256 when the release gives one, otherwise the size. A failed or wrong download is removed and throws.
 * `onChunk(bytesSoFar)` is called after each chunk, for the progress bar. Returns the number of bytes.
 */
async function saveChecked(chunks, file, expect = {}, onChunk) {
  const handle = await fs.promises.open(file, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  let got = 0;
  try {
    await pipeline(async function* () {
      for await (const value of chunks) {
        hash.update(value);
        got += value.length;
        if (onChunk) onChunk(got);
        yield value;
      }
    }, fs.createWriteStream(file, { fd: handle }));
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
  if (expect.sha256 ? hash.digest('hex') !== expect.sha256 : expect.size && got !== expect.size) {
    fs.rmSync(file, { force: true });
    throw new Error('the downloaded file does not match the release');
  }
  return got;
}

/** Removes the folder makeDownloadDir made for this file (and nothing else). */
function removeDownload(file) {
  const dir = path.dirname(String(file || ''));
  if (!path.isAbsolute(dir) || !path.basename(dir).startsWith('cardnovel-update-')) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the temp folder is cleaned up later anyway */ }
}

/** Links the app may hand to the system (the default browser or mail app). Other schemes would start other apps. */
function isWebLink(url) {
  try {
    return ['https:', 'http:', 'mailto:'].includes(new URL(String(url)).protocol);
  } catch {
    return false;
  }
}

module.exports = { parseVersion, isNewer, installKind, releaseInfo, notesSummary, makeDownloadDir, saveChecked, removeDownload, isWebLink };

// Pure helpers of the desktop updater (no Electron here, so they can be tested with `node --test`).

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

module.exports = { parseVersion, isNewer, installKind, releaseInfo, notesSummary };

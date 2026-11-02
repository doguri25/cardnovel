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

/** The installer of a GitHub release for this computer: { version, name, url, size, sha256, notes } or null. */
function releaseInfo(release, kind, arch) {
  if (!release || release.draft || release.prerelease || !SUFFIX[kind]) return null;
  const version = parseVersion(release.tag_name || release.name);
  if (!version) return null;
  const suffix = SUFFIX[kind](arch);
  const asset = (release.assets || []).find((a) => a && typeof a.name === 'string' && a.name.endsWith(suffix));
  if (!asset || !/^https:\/\/github\.com\//.test(asset.browser_download_url || '')) return null;
  const sha = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
  return {
    version: version.join('.'),
    name: asset.name.replace(/[^A-Za-z0-9._-]/g, '_'),
    url: asset.browser_download_url,
    size: Number(asset.size) || 0,
    sha256: sha ? sha[1].toLowerCase() : null,
    notes: notesSummary(release.body || ''),
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

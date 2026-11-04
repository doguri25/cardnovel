// node --test desktop/update-core.test.js
const test = require('node:test');
const assert = require('node:assert');
const { isNewer, parseVersion, installKind, releaseInfo, notesSummary } = require('./update-core.js');

const url = (n) => `https://github.com/doguri25/cardnovel/releases/download/desktop-v0.3.1/${n}`;
const manifest = {
  version: '0.3.1', tag: 'desktop-v0.3.1',
  notes: '소개\n\n## 0.3.1에서 새로워진 것\n\n**앱**\n- **자동 업데이트**: 새 버전을 알아서 받아요.\n- 고친 점\n\n## 받을 파일\n| a | b |',
  files: [
    { name: 'CardNovel-0.3.1-mac-arm64.dmg', size: 10, sha256: 'a'.repeat(64), url: url('CardNovel-0.3.1-mac-arm64.dmg') },
    { name: 'CardNovel-0.3.1-win-x64.exe', size: 20, sha256: 'B'.repeat(64), url: url('CardNovel-0.3.1-win-x64.exe') },
    { name: 'CardNovel-0.3.1-linux-x86_64.AppImage', size: 30, url: url('CardNovel-0.3.1-linux-x86_64.AppImage') },
    { name: 'CardNovel-0.3.1-linux-amd64.deb', size: 40, sha256: 'c'.repeat(64), url: 'https://evil.example.com/x.deb' },
  ],
};

test('compares versions from tags', () => {
  assert.deepStrictEqual(parseVersion('desktop-v0.3.1'), [0, 3, 1]);
  assert.strictEqual(isNewer('desktop-v0.3.1', '0.3.0'), true);
  assert.strictEqual(isNewer('desktop-v0.10.0', '0.9.9'), true);
  assert.strictEqual(isNewer('0.3.0', '0.3.0'), false);
  assert.strictEqual(isNewer('0.2.9', '0.3.0'), false);
  assert.strictEqual(isNewer('nonsense', '0.3.0'), false);
});

test('knows how this copy was installed', () => {
  assert.strictEqual(installKind('darwin', {}), 'dmg');
  assert.strictEqual(installKind('win32', {}), 'nsis');
  assert.strictEqual(installKind('linux', { APPIMAGE: '/home/u/CardNovel.AppImage' }), 'appimage');
  assert.strictEqual(installKind('linux', {}), 'deb');
});

test('picks the installer for this computer and its checksum', () => {
  const mac = releaseInfo(manifest, 'dmg', 'arm64');
  assert.strictEqual(mac.version, '0.3.1');
  assert.strictEqual(mac.name, 'CardNovel-0.3.1-mac-arm64.dmg');
  assert.strictEqual(mac.sha256, 'a'.repeat(64));
  assert.strictEqual(mac.notes, '앱\n· 자동 업데이트: 새 버전을 알아서 받아요.\n· 고친 점');
  assert.strictEqual(releaseInfo(manifest, 'nsis', 'x64').sha256, 'b'.repeat(64));
  assert.strictEqual(releaseInfo(manifest, 'appimage', 'x64'), null, 'no checksum, no install');
  assert.strictEqual(releaseInfo(manifest, 'deb', 'x64'), null, 'only downloads from this repository');
  assert.strictEqual(releaseInfo({ ...manifest, version: 'latest', tag: 'x' }, 'dmg', 'arm64'), null);
  assert.strictEqual(releaseInfo(null, 'dmg', 'arm64'), null);
});

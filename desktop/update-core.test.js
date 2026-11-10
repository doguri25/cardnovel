// node --test desktop/update-core.test.js
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isNewer, parseVersion, installKind, releaseInfo, notesSummary, makeDownloadDir, saveChecked, removeDownload, isWebLink } = require('./update-core.js');

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

/* ---------- downloads (Ubuntu's temp folder is the shared /tmp) ---------- */
const posix = process.platform !== 'win32';
const scratches = [];
const scratch = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cardnovel-test-')); scratches.push(d); return d; };
test.after(() => { for (const d of scratches) fs.rmSync(d, { recursive: true, force: true }); });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

test('each download gets a new folder that only this user can open', () => {
  const tmp = scratch();
  // another account made the old fixed folder and put a link where the installer would go
  fs.mkdirSync(path.join(tmp, 'cardnovel-update'), { mode: 0o777 });
  fs.writeFileSync(path.join(tmp, 'other-users-file'), 'theirs');
  if (posix) fs.symlinkSync(path.join(tmp, 'other-users-file'), path.join(tmp, 'cardnovel-update', 'CardNovel-0.3.4-linux-amd64.deb'));
  const a = makeDownloadDir(tmp);
  const b = makeDownloadDir(tmp);
  assert.notStrictEqual(a, b);
  for (const d of [a, b]) {
    assert.strictEqual(path.dirname(d), tmp);
    assert.match(path.basename(d), /^cardnovel-update-.{6}$/);
    assert.deepStrictEqual(fs.readdirSync(d), []);
    if (posix) assert.strictEqual(fs.statSync(d).mode & 0o777, 0o700);
  }
});

test('saves a download that matches its checksum, readable only by this user', async () => {
  const dir = makeDownloadDir(scratch());
  const file = path.join(dir, 'CardNovel-0.3.4-linux-amd64.deb');
  const seen = [];
  const got = await saveChecked([Buffer.from('hello '), new Uint8Array(Buffer.from('world'))], file, { sha256: sha('hello world'), size: 11 }, (n) => seen.push(n));
  assert.strictEqual(got, 11);
  assert.deepStrictEqual(seen, [6, 11]);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'hello world');
  if (posix) assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

test('removes a download that does not match the release', async () => {
  const dir = makeDownloadDir(scratch());
  const file = path.join(dir, 'x.deb');
  await assert.rejects(saveChecked([Buffer.from('changed')], file, { sha256: sha('hello world') }), /does not match/);
  assert.strictEqual(fs.existsSync(file), false);
  // without a checksum, the size is checked
  await assert.rejects(saveChecked([Buffer.from('abc')], file, { size: 4 }), /does not match/);
  assert.strictEqual(fs.existsSync(file), false);
});

test('never writes through a file or link that is already there', { skip: !posix && 'symlinks need rights on Windows' }, async () => {
  const tmp = scratch();
  const target = path.join(tmp, 'victim');
  fs.writeFileSync(target, 'keep');
  const link = path.join(tmp, 'x.deb');
  fs.symlinkSync(target, link);
  await assert.rejects(saveChecked([Buffer.from('new')], link, { sha256: sha('new') }), { code: 'EEXIST' });
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'keep');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link is left alone');
  const plain = path.join(tmp, 'y.deb');
  fs.writeFileSync(plain, 'old');
  await assert.rejects(saveChecked([Buffer.from('new')], plain, { sha256: sha('new') }), { code: 'EEXIST' });
  assert.strictEqual(fs.readFileSync(plain, 'utf8'), 'old');
});

test('a file that cannot be written or a broken download fails instead of crashing', async () => {
  const dir = makeDownloadDir(scratch());
  await assert.rejects(saveChecked([Buffer.from('x')], path.join(dir, 'missing', 'x.deb'), {}), { code: 'ENOENT' });
  const file = path.join(dir, 'x.deb');
  async function* broken() { yield Buffer.from('part'); throw new Error('connection lost'); }
  await assert.rejects(saveChecked(broken(), file, { sha256: sha('part') }), /connection lost/);
  assert.strictEqual(fs.existsSync(file), false, 'no half file is left');
});

test('removes only the folder it made for the download', () => {
  const tmp = scratch();
  const dir = makeDownloadDir(tmp);
  fs.writeFileSync(path.join(dir, 'x.deb'), 'x');
  fs.writeFileSync(path.join(dir, 'install.sh'), 'x');
  removeDownload(path.join(dir, 'x.deb'));
  assert.strictEqual(fs.existsSync(dir), false);
  const other = path.join(tmp, 'Downloads');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'x.deb'), 'x');
  removeDownload(path.join(other, 'x.deb'));
  removeDownload('x.deb');
  removeDownload(undefined);
  assert.strictEqual(fs.existsSync(path.join(other, 'x.deb')), true);
});

/* ---------- links that leave the app ---------- */
test('only web and mail links are handed to the system', () => {
  for (const u of ['https://www.canva.com/design/x/edit', 'http://example.com/', 'mailto:someone@example.com']) assert.strictEqual(isWebLink(u), true, u);
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'ms-msdt:/id PCWDiagnostic', 'search-ms:query=x', 'smb://host/share', 'vscode://file/x', 'zoommtg://x', 'data:text/html,x', 'ftp://example.com/', '', 'not a url', null, undefined]) {
    assert.strictEqual(isWebLink(u), false, String(u));
  }
});

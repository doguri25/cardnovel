import { describe, expect, it } from 'vitest';
import { crc32, makeZip } from '../src/export';

describe('zip', () => {
  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('writes local headers, central directory and the end record', async () => {
    const blob = makeZip([{ name: '01.png', data: new Uint8Array([1, 2, 3]) }, { name: '02.png', data: new Uint8Array([4]) }], new Date(2026, 10, 2, 12, 0, 0));
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    const end = buf.length - 22;
    expect(dv.getUint32(end, true)).toBe(0x06054b50);
    expect(dv.getUint16(end + 10, true)).toBe(2);
  });
});

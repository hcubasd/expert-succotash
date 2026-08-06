import { describe, expect, it } from 'vitest';
import { loadCsv } from '../src/lib/csvLoader';

describe('loadCsv', () => {
  it('returns nothing for an empty file', () => {
    expect(loadCsv('')).toEqual({ headers: [], columns: [], rowCount: 0 });
  });

  it('reads column-major, one array per header', () => {
    const raw = loadCsv('a,b\n1,x\n2,y\n');
    expect(raw.headers).toEqual(['a', 'b']);
    expect(raw.columns[0]).toEqual([1, 2]);
    expect(raw.columns[1]).toEqual(['x', 'y']);
    expect(raw.rowCount).toBe(2);
  });

  it('reads an empty field as absent, not as zero', () => {
    const raw = loadCsv('a,b\n1,\n');
    expect(raw.columns[1][0]).toBeNull();
  });

  it('keeps pandas booleans as their own labels rather than coercing them', () => {
    const raw = loadCsv('forward\nTrue\nFalse\n');
    expect(raw.columns[0]).toEqual(['True', 'False']);
  });

  it('honors quoted fields containing commas and escaped quotes', () => {
    const raw = loadCsv('a,b\n"x,y","he said ""hi"""\n');
    expect(raw.columns[0][0]).toBe('x,y');
    expect(raw.columns[1][0]).toBe('he said "hi"');
  });

  it('pads a short row rather than shifting the columns', () => {
    const raw = loadCsv('a,b,c\n1,2\n');
    expect(raw.columns[2][0]).toBeNull();
  });
});

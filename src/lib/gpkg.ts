import type { SqlJsStatic } from 'sql.js';

export type ParsedGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'Polygon'; coordinates: [number, number][][] }
  | null;

export type GpkgTable = {
  name: string;
  rows: Record<string, unknown>[];
  geometries: ParsedGeometry[] | null;
};

let _sql: SqlJsStatic | null = null;

async function getSql(): Promise<SqlJsStatic> {
  if (_sql) return _sql;
  const initSqlJs = ((await import('sql.js')) as { default: (cfg: object) => Promise<SqlJsStatic> }).default;
  _sql = await initSqlJs({ locateFile: (file: string) => `${import.meta.env.BASE_URL}${file}` });
  return _sql;
}

export async function readGpkg(buffer: ArrayBuffer): Promise<GpkgTable[]> {
  const SQL = await getSql();
  const db = new SQL.Database(new Uint8Array(buffer));
  let layerNames: string[] = [];
  try {
    const res = db.exec("SELECT table_name FROM gpkg_contents");
    layerNames = (res[0]?.values ?? []).map(r => String(r[0]));
  } catch { /* no gpkg_contents */ }

  const tables: GpkgTable[] = [];
  for (const name of layerNames) {
    try {
      const res = db.exec(`SELECT * FROM "${name}"`);
      if (!res[0]) { tables.push({ name, rows: [], geometries: null }); continue; }
      const cols = res[0].columns;
      const geomColIdx = cols.findIndex(c => c.toLowerCase() === 'geom' || c.toLowerCase() === 'geometry');
      // fid is GeoPackage's auto-assigned row id, not real data -- excluded
      // the same way geom is, at the parse boundary, not just hidden from view.
      const fidColIdx = cols.findIndex(c => c.toLowerCase() === 'fid');
      const rows: Record<string, unknown>[] = [];
      const geometries: ParsedGeometry[] = [];
      for (const rawRow of res[0].values) {
        const row: Record<string, unknown> = {};
        for (let i = 0; i < cols.length; i++) {
          if (i === geomColIdx || i === fidColIdx) continue;
          row[cols[i]] = rawRow[i];
        }
        rows.push(row);
        if (geomColIdx >= 0) {
          const blob = rawRow[geomColIdx];
          geometries.push(blob instanceof Uint8Array ? parseGpb(blob) : null);
        }
      }
      tables.push({ name, rows, geometries: geomColIdx >= 0 ? geometries : null });
    } catch { /* skip unreadable table */ }
  }
  db.close();
  return tables;
}

function parseGpb(data: Uint8Array): ParsedGeometry {
  if (data.length < 8 || data[0] !== 0x47 || data[1] !== 0x50) return null;
  const flags = data[3];
  const envType = (flags >> 1) & 0x07;
  const envBytes = [0, 32, 48, 48, 64][envType] ?? 0;
  return parseWkb(data, 8 + envBytes);
}

function parseWkb(data: Uint8Array, offset: number): ParsedGeometry {
  if (offset + 5 > data.length) return null;
  const le = data[offset] === 1;
  const type = u32(data, offset + 1, le);
  const base = offset + 5;
  if (type === 1) {
    return { type: 'Point', coordinates: [f64(data, base, le), f64(data, base + 8, le)] };
  }
  if (type === 2) {
    const n = u32(data, base, le);
    const coords: [number, number][] = [];
    for (let i = 0; i < n; i++) coords.push([f64(data, base + 4 + i * 16, le), f64(data, base + 4 + i * 16 + 8, le)]);
    return { type: 'LineString', coordinates: coords };
  }
  if (type === 3) {
    const nRings = u32(data, base, le);
    const rings: [number, number][][] = [];
    let off = base + 4;
    for (let r = 0; r < nRings; r++) {
      const n = u32(data, off, le); off += 4;
      const ring: [number, number][] = [];
      for (let i = 0; i < n; i++) { ring.push([f64(data, off, le), f64(data, off + 8, le)]); off += 16; }
      rings.push(ring);
    }
    return { type: 'Polygon', coordinates: rings };
  }
  return null;
}

function u32(d: Uint8Array, o: number, le: boolean): number {
  return le
    ? d[o] | (d[o+1] << 8) | (d[o+2] << 16) | (d[o+3] << 24)
    : (d[o] << 24) | (d[o+1] << 16) | (d[o+2] << 8) | d[o+3];
}

function f64(d: Uint8Array, o: number, le: boolean): number {
  const buf = new ArrayBuffer(8);
  const v = new DataView(buf);
  for (let i = 0; i < 8; i++) v.setUint8(i, d[o + i]);
  return v.getFloat64(0, le);
}

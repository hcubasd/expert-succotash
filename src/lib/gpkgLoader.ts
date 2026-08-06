import type { SqlJsStatic } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { RawCell, RawGeometry, RawTable } from './rawTable';

// A GeoPackage is a SQLite database with geometry stored as a small header
// followed by raw WKB, so reading one in the browser means running SQLite
// (sql.js, a compact WASM build) and then decoding the blobs by hand. The
// wasm binary is imported as an asset rather than hand-placed in public/, so
// Vite resolves it from node_modules and content-hashes it for us.

export type GpkgTable = RawTable & { geometries: RawGeometry[] | null };

let sql: SqlJsStatic | null = null;

async function getSql(): Promise<SqlJsStatic> {
  if (sql) return sql;
  const initSqlJs = ((await import('sql.js')) as unknown as {
    default: (config: object) => Promise<SqlJsStatic>;
  }).default;
  sql = await initSqlJs({ locateFile: () => wasmUrl });
  return sql;
}

export async function loadGpkg(buffer: ArrayBuffer): Promise<GpkgTable> {
  const SQL = await getSql();
  const db = new SQL.Database(new Uint8Array(buffer));
  try {
    let layers: string[] = [];
    try {
      const listed = db.exec('SELECT table_name FROM gpkg_contents');
      layers = (listed[0]?.values ?? []).map(r => String(r[0]));
    } catch {
      // not a GeoPackage, or no contents table -- nothing to read
    }
    if (layers.length === 0) return { headers: [], columns: [], rowCount: 0, geometries: null };

    const result = db.exec(`SELECT * FROM "${layers[0]}"`);
    if (!result[0]) return { headers: [], columns: [], rowCount: 0, geometries: null };

    const all = result[0].columns;
    const values = result[0].values;
    // fid is GeoPackage's auto-assigned row id and geom is the blob we decode
    // separately -- neither is data the user put there, so both are dropped
    // at the parse boundary rather than filtered out further downstream.
    const geomIndex = all.findIndex(c => c.toLowerCase() === 'geom' || c.toLowerCase() === 'geometry');
    const skip = new Set<number>();
    if (geomIndex >= 0) skip.add(geomIndex);
    const fidIndex = all.findIndex(c => c.toLowerCase() === 'fid');
    if (fidIndex >= 0) skip.add(fidIndex);

    const keep = all.map((_, i) => i).filter(i => !skip.has(i));
    const headers = keep.map(i => all[i]);
    const columns: RawCell[][] = keep.map(() => new Array(values.length).fill(null));
    const geometries: RawGeometry[] = [];

    values.forEach((row, r) => {
      keep.forEach((sourceIndex, target) => {
        const cell = row[sourceIndex];
        columns[target][r] = cell === null || cell === undefined
          ? null
          : (typeof cell === 'number' || typeof cell === 'string' ? cell : String(cell));
      });
      if (geomIndex >= 0) {
        const blob = row[geomIndex];
        geometries.push(blob instanceof Uint8Array ? parseGeoPackageBlob(blob) : null);
      }
    });

    return {
      headers,
      columns,
      rowCount: values.length,
      geometries: geomIndex >= 0 ? geometries : null,
    };
  } finally {
    db.close();
  }
}

// GeoPackage binary header: magic "GP", version, flags, srs_id, then an
// optional envelope whose size the flags encode, then plain WKB.
function parseGeoPackageBlob(data: Uint8Array): RawGeometry {
  if (data.length < 8 || data[0] !== 0x47 || data[1] !== 0x50) return null;
  const envelopeType = (data[3] >> 1) & 0x07;
  const envelopeBytes = [0, 32, 48, 48, 64][envelopeType] ?? 0;
  return parseWkb(data, 8 + envelopeBytes);
}

function parseWkb(data: Uint8Array, offset: number): RawGeometry {
  if (offset + 5 > data.length) return null;
  const little = data[offset] === 1;
  const type = readU32(data, offset + 1, little);
  const base = offset + 5;

  if (type === 1) {
    return { type: 'Point', coordinates: [readF64(data, base, little), readF64(data, base + 8, little)] };
  }
  if (type === 2) {
    const n = readU32(data, base, little);
    const coordinates: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const at = base + 4 + i * 16;
      coordinates.push([readF64(data, at, little), readF64(data, at + 8, little)]);
    }
    return { type: 'LineString', coordinates };
  }
  if (type === 3) {
    const ringCount = readU32(data, base, little);
    const coordinates: [number, number][][] = [];
    let at = base + 4;
    for (let r = 0; r < ringCount; r++) {
      const n = readU32(data, at, little);
      at += 4;
      const ring: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        ring.push([readF64(data, at, little), readF64(data, at + 8, little)]);
        at += 16;
      }
      coordinates.push(ring);
    }
    return { type: 'Polygon', coordinates };
  }
  return null;
}

function readU32(d: Uint8Array, o: number, little: boolean): number {
  return little
    ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0
    : ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
}

const scratch = new DataView(new ArrayBuffer(8));

function readF64(d: Uint8Array, o: number, little: boolean): number {
  for (let i = 0; i < 8; i++) scratch.setUint8(i, d[o + i]);
  return scratch.getFloat64(0, little);
}

import { gradientAt, hueIndexOf, indexColor, ngon, semicircle } from './colors';
import type { RgbColor } from './colors';
import type { Geometries } from './geometryMaker';
import type { TableName } from './schema';
import type { Table } from './tableMaker';

// Which (table, column) pairs mean something to the map, and which geometry
// bucket they drive. Adding an entry here is the whole change -- Map itself
// never learns this registry exists, it just reads whatever colors are
// sitting on the geometry.
export type MapTarget = 'zones' | 'network' | 'desireLines' | 'agents';

// A table's registration is either explicit columns by name, or the
// wildcard `{ anyStratum: target }` meaning every stratum column of that
// table drives the same target. agents needs the wildcard specifically:
// agent_id/zone_id are guaranteed, but which other stratum dimensions
// exist (if any) isn't fixed by name the way `resource` or `grade` are for
// their tables -- it depends on what got synthesized.
type Registration = Record<string, MapTarget> | { anyStratum: MapTarget };

export const MAP_DRIVERS: Partial<Record<TableName, Registration>> = {
  desire_lines: { resource: 'desireLines' },
  network: { grade: 'network', road_type: 'network' },
  agents: { anyStratum: 'agents' },
};

export function targetOf(table: TableName, column: string, tableData?: Table): MapTarget | null {
  const registration = MAP_DRIVERS[table];
  if (!registration) return null;
  if ('anyStratum' in registration) {
    return tableData?.strata.some(s => s.name === column) ? registration.anyStratum : null;
  }
  return registration[column] ?? null;
}

// The color for every row of a table under one selected column. Strata read
// their palette index straight off the dictionary code; values normalize onto
// a half-wheel gradient. Rows the column has no value for come back null and
// keep the monochrome default.
function rowColors(table: Table, column: string): (RgbColor | null)[] | null {
  const stratum = table.strata.find(c => c.name === column);
  if (stratum) {
    const palette = ngon(stratum.dictionary.length, stratum.rotation);
    if (palette.length === 0) return null;
    const colors: (RgbColor | null)[] = new Array(table.rowCount);
    for (let row = 0; row < table.rowCount; row++) {
      colors[row] = indexColor(palette, stratum.codes[row]);
    }
    return colors;
  }

  const value = table.values.find(c => c.name === column);
  if (!value) return null;

  const gradient = semicircle(value.rotation);
  const span = value.max - value.min;
  const colors: (RgbColor | null)[] = new Array(table.rowCount);
  for (let row = 0; row < table.rowCount; row++) {
    if (!value.present[row]) {
      colors[row] = null;
      continue;
    }
    const t = span === 0 ? 0.5 : (value.data[row] - value.min) / span;
    colors[row] = gradientAt(t, gradient);
  }
  return colors;
}

function writeColors(
  target: Uint8Array,
  rowIndex: Uint32Array | null,
  colors: (RgbColor | null)[],
  fallback: RgbColor,
) {
  const vertexCount = target.length / 3;
  for (let v = 0; v < vertexCount; v++) {
    const row = rowIndex ? rowIndex[v] : v;
    const color = colors[row] ?? fallback;
    target[v * 3] = color.r;
    target[v * 3 + 1] = color.g;
    target[v * 3 + 2] = color.b;
  }
}

function writeHues(target: Uint8Array, rowIndex: Uint32Array, colors: (RgbColor | null)[], fallback: RgbColor) {
  // Cache per distinct color: hueIndexOf is a map lookup, but a nearest-match
  // miss walks all 256 vertices, and a segment buffer can hold hundreds of
  // thousands of vertices that share a handful of colors.
  const cache = new Map<string, number>();
  const indexFor = (color: RgbColor) => {
    const key = `${color.r},${color.g},${color.b}`;
    let index = cache.get(key);
    if (index === undefined) {
      index = hueIndexOf(color);
      cache.set(key, index);
    }
    return index;
  };

  for (let v = 0; v < target.length; v++) {
    target[v] = indexFor(colors[rowIndex[v]] ?? fallback);
  }
}

// Paint every geometry bucket for the current selection. A bucket whose table
// isn't the selected one -- or the whole scene, when nothing map-affecting is
// selected -- gets the monochrome ink color, which is what "default state"
// means here.
export function applyMapColors(
  geometries: Geometries,
  tables: Partial<Record<TableName, Table>>,
  selection: { table: TableName; column: string } | null,
  ink: RgbColor,
  paper: RgbColor,
) {
  const table = selection ? tables[selection.table] : undefined;
  const target = selection ? targetOf(selection.table, selection.column, table) : null;
  const colors = target && table ? rowColors(table, selection!.column) : null;

  const activeFor = (bucket: MapTarget) => (target === bucket && colors ? colors : null);

  if (geometries.zones) {
    const zoneColors = activeFor('zones');
    // Zone fill is background-colored when nothing drives it: present, but
    // reading as empty behind everything else.
    writeColors(geometries.zones.fillColors, geometries.zones.fillRowIndex, zoneColors ?? [], zoneColors ? ink : paper);
    writeColors(geometries.zones.borderColors, geometries.zones.borderRowIndex, [], ink);
  }

  if (geometries.network) {
    const networkColors = activeFor('network');
    writeColors(geometries.network.colors, geometries.network.rowIndex, networkColors ?? [], ink);
  }

  if (geometries.desireLines) {
    const lineColors = activeFor('desireLines');
    writeColors(geometries.desireLines.colors, geometries.desireLines.rowIndex, lineColors ?? [], ink);
    if (lineColors) {
      writeHues(geometries.desireLines.hues, geometries.desireLines.rowIndex, lineColors, ink);
    }
  }

  if (geometries.agents) {
    const agentColors = activeFor('agents');
    writeColors(geometries.agents.colors, null, agentColors ?? [], ink);
  }
}

// Which line layer the map should show. Never both -- at this scale the two
// together are unreadable. A selection that drives one of them picks it;
// otherwise network wins if it's loaded, since it's the sparser of the two.
export function activeLineLayer(
  geometries: Geometries,
  selection: { table: TableName; column: string } | null,
  tables: Partial<Record<TableName, Table>>,
): 'network' | 'desireLines' | null {
  const target = selection ? targetOf(selection.table, selection.column, tables[selection.table]) : null;
  if (target === 'network' && geometries.network) return 'network';
  if (target === 'desireLines' && geometries.desireLines) return 'desireLines';
  if (geometries.network) return 'network';
  if (geometries.desireLines) return 'desireLines';
  return null;
}

// True when desire lines carry real per-line hues, which is the only case
// that needs the accumulate-and-average render path. Monochrome lines all
// share one color, so averaging them would return that same color -- the
// extra passes would be pure cost for an identical picture.
export function desireLinesAreColored(
  selection: { table: TableName; column: string } | null,
  tables: Partial<Record<TableName, Table>>,
): boolean {
  return selection
    ? targetOf(selection.table, selection.column, tables[selection.table]) === 'desireLines'
    : false;
}

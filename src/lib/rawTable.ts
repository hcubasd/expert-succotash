// What a loader hands back: column-major, untyped, unclassified. Loaders know
// file formats; they know nothing about strata, values, dictionaries, or
// geometry semantics. Everything past this boundary is tableMaker's and
// geometryMaker's job.
export type RawCell = string | number | null;

export type RawTable = {
  headers: string[];
  // columns[i] holds every row's value for headers[i], in row order.
  columns: RawCell[][];
  rowCount: number;
};

export type RawGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'Polygon'; coordinates: [number, number][][] }
  | null;

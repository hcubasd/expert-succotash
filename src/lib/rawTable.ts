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

// Real GIS exports routinely type a whole layer as Multi* even when most
// features have exactly one part -- e.g. an administrative boundary layer
// where a handful of zones have a disjoint exclave. geometryMaker treats
// every part of a Multi* as belonging to the same row it came from, same as
// a polygon's holes: more geometry for one feature, not more features.
export type RawGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'Polygon'; coordinates: [number, number][][] }
  | { type: 'MultiPoint'; coordinates: [number, number][] }
  | { type: 'MultiLineString'; coordinates: [number, number][][] }
  | { type: 'MultiPolygon'; coordinates: [number, number][][][] }
  | null;

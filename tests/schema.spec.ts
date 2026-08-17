import { describe, expect, it } from 'vitest';
import { REQUIRED_COLUMNS, TABLE_NAMES, classifyColumns } from '../src/lib/schema';

describe('REQUIRED_COLUMNS', () => {
  it('lists every table', () => {
    for (const table of TABLE_NAMES) expect(REQUIRED_COLUMNS[table]).toBeDefined();
  });

  // Hand-maintained alongside classifyColumns' own switch rather than
  // derived from it, so this exists to catch the two drifting apart -- a
  // typo'd or renamed column here would otherwise silently never be checked
  // for at load time.
  it('is consistent with classifyColumns: every required column actually classifies as something', () => {
    for (const table of TABLE_NAMES) {
      const headers = REQUIRED_COLUMNS[table];
      const { strata, values } = classifyColumns(table, headers, () => false);
      const classified = new Set([...strata, ...values]);
      for (const column of headers) {
        expect(classified.has(column), `${table}.${column}`).toBe(true);
      }
    }
  });
});

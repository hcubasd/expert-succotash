import type { RawCell, RawTable } from './rawTable';

// Splits one CSV line, honoring double-quoted fields (and "" as an escaped
// quote inside them).
function parseRow(line: string): string[] {
  const result: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) {
      result.push('');
      break;
    }
    if (line[i] === '"') {
      let j = i + 1;
      let s = '';
      while (j < line.length) {
        if (line[j] === '"' && line[j + 1] === '"') {
          s += '"';
          j += 2;
        } else if (line[j] === '"') {
          j++;
          break;
        } else {
          s += line[j++];
        }
      }
      result.push(s);
      i = j;
      if (line[i] === ',') i++;
      else break;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) {
        result.push(line.slice(i));
        break;
      }
      result.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return result;
}

// pandas writes booleans as True/False; everything else is either a number or
// a bare string. An empty field is genuinely absent, not zero.
function coerce(value: string): RawCell {
  if (value === '') return null;
  if (value === 'True') return 'True';
  if (value === 'False') return 'False';
  const n = Number(value);
  return Number.isNaN(n) ? value : n;
}

export function loadCsv(text: string): RawTable {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const lines = normalized.split('\n').filter(l => l.trim());
  if (lines.length < 1) return { headers: [], columns: [], rowCount: 0 };

  const headers = parseRow(lines[0]);
  const body = lines.slice(1);
  const columns: RawCell[][] = headers.map(() => new Array(body.length).fill(null));

  body.forEach((line, row) => {
    const cells = parseRow(line);
    for (let col = 0; col < headers.length; col++) {
      columns[col][row] = coerce(cells[col] ?? '');
    }
  });

  return { headers, columns, rowCount: body.length };
}

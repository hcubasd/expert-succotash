export function parseCsv(text: string): Record<string, unknown>[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const lines = normalized.split('\n');
  if (lines.length < 2) return [];
  const headers = parseRow(lines[0]);
  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const vals = parseRow(line);
      return Object.fromEntries(headers.map((h, i) => {
        const v = vals[i] ?? '';
        if (v === '') return [h, null];
        const n = Number(v);
        return [h, isNaN(n) ? v : n];
      }));
    });
}

function parseRow(line: string): string[] {
  const result: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) { result.push(''); break; }
    if (line[i] === '"') {
      let j = i + 1;
      let s = '';
      while (j < line.length) {
        if (line[j] === '"' && line[j + 1] === '"') { s += '"'; j += 2; }
        else if (line[j] === '"') { j++; break; }
        else { s += line[j++]; }
      }
      result.push(s);
      i = j;
      if (line[i] === ',') i++;
      else break;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { result.push(line.slice(i)); break; }
      result.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return result;
}

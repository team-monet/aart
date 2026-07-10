// A small, dependency-free RFC4180-ish CSV parser/stringifier for
// `data.parse`/`data.stringify` (spec §15.3 Data group, format: "csv").
// Handles the two things a naive `split(",")` gets wrong: quoted fields
// containing embedded commas/newlines, and `""`-escaped quotes inside a
// quoted field. Row 0 is always treated as the header row.
function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Row 0 is the header; every subsequent row becomes a `{header[i]: value}` record. Returns `[]` for empty/whitespace-only input. */
export function parseCsv(input: string): Record<string, string>[] {
  if (input.trim().length === 0) return [];
  const rows = parseCsvRows(input);
  if (rows.length === 0) return [];
  const [header, ...dataRows] = rows as [string[], ...string[][]];
  return dataRows
    .filter((r) => !(r.length === 1 && r[0] === ""))
    .map((r) => {
      const record: Record<string, string> = {};
      header.forEach((key, idx) => {
        record[key] = r[idx] ?? "";
      });
      return record;
    });
}

function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Column set is the union of every row's own keys, in first-seen order — so a ragged array of records (not every row sharing identical keys) still produces one consistent header. */
export function stringifyCsv(rows: ReadonlyArray<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  const lines = [columns.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c])).join(","));
  }
  return lines.join("\r\n");
}

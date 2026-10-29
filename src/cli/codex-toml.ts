// INPUT: Codex config.toml text, the tables ms appends (header + body lines) and a predicate for the table headers ms owns.
// OUTPUT: appendTables (end-of-file append, one blank line between tables), dropTables (removes owned table blocks, keeping every
//         other byte) and tableHeaders; a `[` line inside a multi-line string or array is a value, not a header.
// POS: Text-level TOML editor for ~/.codex/config.toml; never parses or rewrites tables ms does not own.
export type TomlTable = Readonly<{ header: string; body: readonly string[] }>;

const HEADER = /^\s*\[/;

type Kind = 'header' | 'continued' | 'line';
type Scan = Readonly<{ open: string | null; depth: number }>;

function contentLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// End of a one-line string that starts at `start`: "..." takes \ escapes, '...' none.
function stringEnd(line: string, start: number): number {
  for (let index = start + 1; index < line.length; index += 1) {
    if (line[start] === '"' && line[index] === '\\') { index += 1; continue; }
    if (line[index] === line[start]) return index + 1;
  }
  return line.length;
}

// Carries the multi-line string ("""/''') and open-array state past one line; `#` outside strings ends the line, and a run of
// 3–5 quotes closes a multi-line string after the whole run.
function scanLine(line: string, state: Scan): Scan {
  let { open, depth } = state;
  for (let index = 0; index < line.length;) {
    const char = line[index];
    if (open !== null) {
      if (open === '"""' && char === '\\') index += 2;
      else if (!line.startsWith(open, index)) index += 1;
      else { while (line[index] === open[0]) index += 1; open = null; }
      continue;
    }
    if (char === '#') break;
    if (line.startsWith('"""', index) || line.startsWith("'''", index)) { open = line.slice(index, index + 3); index += 3; continue; }
    if (char === '"' || char === "'") { index = stringEnd(line, index); continue; }
    if (char === '[') depth += 1;
    else if (char === ']') depth -= 1;
    index += 1;
  }
  return { open, depth };
}

// A header is a line that starts with `[` outside multi-line strings and arrays; lines inside them are 'continued'.
function lineKinds(lines: readonly string[]): Kind[] {
  let state: Scan = { open: null, depth: 0 };
  return lines.map(line => {
    const kind: Kind = state.open !== null || state.depth !== 0 ? 'continued' : HEADER.test(line) ? 'header' : 'line';
    if (kind !== 'header') state = scanLine(line, state);
    return kind;
  });
}

export function appendTables(original: string, tables: readonly TomlTable[]): string {
  const lines = contentLines(original);
  const block = tables.map(table => [table.header, ...table.body].join('\n')).join('\n\n');
  return lines.length === 0 ? `${block}\n` : `${lines.join('\n')}\n\n${block}\n`;
}

export function tableHeaders(text: string): string[] {
  const lines = contentLines(text);
  const kinds = lineKinds(lines);
  return lines.filter((_, index) => kinds[index] === 'header').map(line => line.trim());
}

// A table block runs from its header to its last key line plus the blank lines after it; comments that lead into the next
// header belong to that next table.
function blockEnd(lines: readonly string[], kinds: readonly Kind[], start: number): number {
  let next = start + 1;
  while (next < lines.length && kinds[next] !== 'header') next += 1;
  let end = start + 1;
  for (let index = start + 1; index < next; index += 1) {
    const trimmed = lines[index].trim();
    if (kinds[index] === 'continued' || (trimmed !== '' && !trimmed.startsWith('#'))) end = index + 1;
  }
  while (end < next && lines[end].trim() === '') end += 1;
  return end;
}

export function dropTables(current: string, owned: (header: string, body: readonly string[]) => boolean): string {
  const lines = current.split('\n');
  const kinds = lineKinds(lines);
  const keep: string[] = [];
  for (let index = 0; index < lines.length;) {
    const header = kinds[index] === 'header';
    const next = header ? blockEnd(lines, kinds, index) : index + 1;
    const block = lines.slice(index, next);
    if (!(header && owned(lines[index].trim(), block.slice(1)))) keep.push(...block);
    index = next;
  }
  const text = keep.join('\n');
  return current.endsWith('\n') && text !== '' && !text.endsWith('\n') ? `${text}\n` : text;
}

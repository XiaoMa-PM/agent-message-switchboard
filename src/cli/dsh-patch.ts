// INPUT: DSH desktop profile cordis.patch.yml text and the ms entry id.
// OUTPUT: mentionsId (install precondition) and removeOverrideRows → text without the {id, disabled} rows DSH's entry switch wrote,
//         in block or flow form (yaml 2.9.1 shapes), or a conflict when anything else names the id, a comment splits the row,
//         a flow file carries any comment or a flow override shape sits anywhere but directly in the root sequence.
// POS: Text-level cleanup of the profile patch layer; install never writes this file, uninstall only drops DSH's override rows.
type Segment = { item: boolean; lines: string[] };

const ITEM_START = /^-(?:\s|$)/;

function contentLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function segments(text: string): Segment[] | null {
  const result: Segment[] = [];
  for (const line of contentLines(text)) {
    if (ITEM_START.test(line)) { result.push({ item: true, lines: [line] }); continue; }
    if (line.startsWith('#')) { result.push({ item: false, lines: [line] }); continue; }
    const indented = line.trim() === '' || /^\s/.test(line);
    if (!indented) return null;
    if (result.length === 0) { if (line.trim() !== '') return null; result.push({ item: false, lines: [] }); }
    result[result.length - 1].lines.push(line);
  }
  return result;
}

const escape = (id: string) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const quotedId = (id: string) => `(?:${escape(id)}|"${escape(id)}"|'${escape(id)}')`;

export function mentionsId(text: string, id: string): boolean {
  return new RegExp(`(^|[^\\w-])${escape(id)}([^\\w-]|$)`, 'm').test(text);
}

function isBlockOverride(lines: readonly string[], id: string): boolean {
  const keys = lines.filter(line => line.trim() !== '').map(line => line.replace(/^-\s+/, '').trim());
  const idLine = new RegExp(`^id:\\s*${quotedId(id)}$`);
  const disabledLine = /^disabled:\s*(?:true|false)$/;
  return lines.length > 0 && ITEM_START.test(lines[0]) && keys.length === 2
    && ((idLine.test(keys[0]) && disabledLine.test(keys[1])) || (disabledLine.test(keys[0]) && idLine.test(keys[1])));
}

function removeBlock(parsed: Segment[], id: string): Readonly<{ text: string | null; conflict: boolean }> {
  const named = parsed.filter(segment => mentionsId(segment.lines.join('\n'), id));
  if (!named.every(segment => segment.item && isBlockOverride(segment.lines, id))) return { text: null, conflict: true };
  const kept = parsed.filter(segment => !named.includes(segment));
  const lines = kept.flatMap(segment => segment.lines);
  if (!kept.some(segment => segment.item)) lines.push('[]');
  return { text: `${lines.join('\n')}\n`, conflict: false };
}

// Flow brackets still open before `end`; quoted scalars are skipped ("..." with \ escapes, '...' with '' escapes; a quote only
// opens a scalar at its start, after [ { , : ? or the beginning). Ending inside a quoted scalar returns -1.
function depthAt(text: string, end: number): number {
  let depth = 0;
  let quote: string | null = null;
  let previous = '';
  for (let index = 0; index < end; index += 1) {
    const char = text[index];
    if (quote === '"' && char === '\\') { index += 1; continue; }
    if (quote !== null) { if (char === quote) quote = null; continue; }
    if ((char === '"' || char === "'") && /^[[{,:?]?$/.test(previous)) quote = char;
    else if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    if (!/\s/.test(char)) previous = char;
  }
  return quote === null ? depth : -1;
}

// A comment can hide or swallow flow punctuation (a `,` or `]` after `#`), so a flow file with any comment is a conflict.
// Only maps directly in the root sequence are switch rows; the same shape inside another item belongs to that item.
function removeFlow(text: string, id: string): Readonly<{ text: string | null; conflict: boolean }> {
  if (/(^|\s)#/.test(text)) return { text: null, conflict: true };
  const row = `\\{\\s*(?:id:\\s*${quotedId(id)},\\s*disabled:\\s*(?:true|false)|disabled:\\s*(?:true|false),\\s*id:\\s*${quotedId(id)})\\s*\\}`;
  const mentions = text.match(new RegExp(`(^|[^\\w-])${escape(id)}([^\\w-]|$)`, 'g'))?.length ?? 0;
  const rows = [...text.matchAll(new RegExp(row, 'g'))];
  if (rows.length !== mentions || rows.some(match => depthAt(text, match.index) !== 1)) return { text: null, conflict: true };
  let result = text;
  for (const shape of [`,\\s*${row}`, `${row}\\s*,\\s*`, row]) result = result.replace(new RegExp(shape, 'g'), '');
  return { text: /^\s*\[\s*\]\s*$/.test(result) ? '[]\n' : result, conflict: false };
}

export function removeOverrideRows(text: string, id: string): Readonly<{ text: string | null; conflict: boolean }> {
  if (!mentionsId(text, id)) return Object.freeze({ text: null, conflict: false });
  const first = contentLines(text).find(line => line.trim() !== '' && !line.startsWith('#'));
  if (first?.trimStart().startsWith('[')) return Object.freeze(removeFlow(text, id));
  const parsed = segments(text);
  return Object.freeze(parsed === null ? { text: null, conflict: true } : removeBlock(parsed, id));
}

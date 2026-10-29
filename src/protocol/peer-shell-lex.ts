// INPUT: A shell command string from a peer-request tool call.
// OUTPUT: splitShell → simple commands (argv, redirections, stdin, expansion, background, heredoc), or null when not statically understood.
// POS: Conservative static lexer for the shell tiers; it never expands anything and returns null instead of guessing.
export type Redirect = Readonly<{ op: string; target: string }>;
export type ShellCommand = Readonly<{ argv: readonly string[]; redirects: readonly Redirect[]; piped: boolean; expands: boolean;
  background: boolean; heredoc: boolean }>;
type Token = Readonly<{ kind: 'word' | 'op' | 'redir' | 'heredoc'; value: string; expands: boolean }>;

const OPERATORS = ['&&', '||', '|&', '|', ';', '&'] as const;
const REDIRECTS = ['&>>', '&>', '>>', '>|', '>&', '<&', '>', '<'] as const;
// Matched against a word's skeleton: unquoted characters as written, quoted or escaped ones as _, except $ inside double quotes.
const EXPANDS = /[*?$]|\[[^\]]*\]|\{[^{}]*(?:,|\.\.)[^{}]*\}|^~[^/]/;

type Part = Readonly<{ value: string; skeleton: string; end: number }>;
// A heredoc whose whole delimiter is quoted ('EOF', "EOF" or \EOF) has a body the shell never expands. An unquoted or partly
// quoted delimiter, an empty one or one with other characters does not match and stays unparseable.
const HEREDOC = /^<<(-?)[ \t]*(?:'([A-Za-z0-9_.-]+)'|"([A-Za-z0-9_.-]+)"|\\([A-Za-z0-9_.-]+))(?=[ \t\n;&|<>]|$)/;
type Pending = Readonly<{ strip: boolean; delimiter: string }>;

// The body is every line up to the first one that equals the delimiter exactly (after leading tabs for <<-); the index after that
// line, or null when no line ends it.
function bodyEnd(text: string, start: number, heredoc: Pending): number | null {
  for (let line = start; line <= text.length;) {
    const newline = text.indexOf('\n', line); const end = newline < 0 ? text.length : newline;
    const content = text.slice(line, end);
    if ((heredoc.strip ? content.replace(/^\t+/, '') : content) === heredoc.delimiter) return newline < 0 ? text.length : end + 1;
    if (newline < 0) return null;
    line = end + 1;
  }
  return null;
}

function quoted(text: string, start: number, quote: string): Part | null {
  let value = ''; let skeleton = '';
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (char === quote) return { value, skeleton, end: index + 1 };
    if (quote === '"' && (char === '`' || (char === '$' && text[index + 1] === '('))) return null;
    if (quote === '"' && char === '\\' && index + 1 < text.length) { value += text[++index]; skeleton += '_'; continue; }
    value += char; skeleton += quote === '"' && char === '$' ? '$' : '_';
  }
  return null;
}

function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let word: string | null = null; let skeleton = ''; let pending: Pending | null = null;
  const flush = () => {
    if (word !== null) tokens.push({ kind: 'word', value: word, expands: EXPANDS.test(skeleton) });
    word = null; skeleton = '';
  };
  for (let index = 0; index < text.length;) {
    const char = text[index]; const rest = text.slice(index);
    if (rest.startsWith('<<') && !rest.startsWith('<<<')) {
      const found = HEREDOC.exec(rest);
      // One heredoc per line, and none after a word glued to it (0<<: a file descriptor).
      if (found === null || pending !== null || word !== null) return null;
      tokens.push({ kind: 'heredoc', value: '', expands: false });
      pending = { strip: found[1] === '-', delimiter: found[2] ?? found[3] ?? found[4] };
      index += found[0].length; continue;
    }
    if (char === '`' || rest.startsWith('$(') || rest.startsWith('<(') || rest.startsWith('>(') || rest.startsWith('<<')
        || char === '(' || char === ')') return null;
    if (char === ' ' || char === '\t') { flush(); index++; continue; }
    if (char === '\n') {
      flush(); tokens.push({ kind: 'op', value: ';', expands: false });
      if (pending === null) { index++; continue; }
      const end = bodyEnd(text, index + 1, pending);
      if (end === null) return null;
      pending = null; index = end; continue;
    }
    if (char === '#' && word === null) { while (index < text.length && text[index] !== '\n') index++; continue; }
    if (char === '\\') {
      const escaped = text[index + 1] === '\n' ? '' : text[index + 1] ?? '';
      word = (word ?? '') + escaped; skeleton += '_'.repeat(escaped.length); index += 2; continue;
    }
    if (char === "'" || char === '"') {
      const part = quoted(text, index, char);
      if (part === null) return null;
      word = (word ?? '') + part.value; skeleton += part.skeleton || '_'; index = part.end; continue;
    }
    const redirect = REDIRECTS.find(op => rest.startsWith(op));
    if (redirect) {
      // A bare number right before the operator is its file descriptor (2>), anything else ends the word (a>b redirects to b).
      if (word !== null && /^\d+$/.test(word)) { word = null; skeleton = ''; } else flush();
      tokens.push({ kind: 'redir', value: redirect, expands: false }); index += redirect.length; continue;
    }
    const operator = OPERATORS.find(op => rest.startsWith(op));
    if (operator) { flush(); tokens.push({ kind: 'op', value: operator, expands: false }); index += operator.length; continue; }
    word = (word ?? '') + char; skeleton += char; index++;
  }
  flush();
  return pending === null ? tokens : null;
}

export function splitShell(text: string): readonly ShellCommand[] | null {
  const tokens = tokenize(text);
  if (tokens === null) return null;
  const commands: ShellCommand[] = [];
  let argv: string[] = []; let redirects: Redirect[] = []; let piped = false; let nextPiped = false; let expands = false;
  let heredoc = false;
  // && is its own operator and the & of |&, &>, >& is part of another token, so only a lone & sends a command to the background.
  const close = (background: boolean) => {
    if (argv.length > 0 || redirects.length > 0 || heredoc) {
      commands.push(Object.freeze({ argv: Object.freeze(argv), redirects: Object.freeze(redirects), piped, expands, background, heredoc }));
    }
    argv = []; redirects = []; piped = nextPiped; nextPiped = false; expands = false; heredoc = false;
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === 'word') { argv.push(token.value); expands ||= token.expands; continue; }
    if (token.kind === 'heredoc') { heredoc = true; continue; }
    if (token.kind === 'redir') {
      const target = tokens[index + 1];
      if (target?.kind !== 'word') return null;
      redirects.push(Object.freeze({ op: token.value, target: target.value })); expands ||= target.expands; index++; continue;
    }
    nextPiped = token.value === '|' || token.value === '|&';
    close(token.value === '&');
  }
  close(false);
  return Object.freeze(commands);
}

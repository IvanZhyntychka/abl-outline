'use strict';

const NAME_KEYWORDS = new Set([
  'abstract', 'as', 'character', 'class', 'com-handle', 'dataset', 'dataset-handle',
  'date', 'datetime', 'datetime-tz', 'decimal', 'extent', 'final', 'handle',
  'input', 'input-output', 'int64', 'integer', 'logical', 'longchar', 'memptr',
  'output', 'override', 'private', 'protected', 'public', 'raw', 'recid', 'rowid',
  'static', 'table', 'table-handle', 'void'
]);

const ACCESS = new Set(['public', 'protected', 'private', 'static', 'abstract', 'override', 'final']);

const CLOSABLE = new Set([
  'method', 'constructor', 'destructor', 'procedure', 'function', 'temptable'
]);

function parse(text) {
  const lines = String(text).split(/\r?\n/);
  const state = { inBlock: false, inString: false, quote: '' };
  const codes = new Array(lines.length);
  const roots = [];
  const stack = [];

  for (let i = 0; i < lines.length; i++) {
    const code = stripLine(lines[i], state);
    codes[i] = code;
    const trimmed = code.trim();
    if (!trimmed) {
      continue;
    }

    const ended = matchEnd(trimmed);
    if (ended) {
      if (ended === 'class' || ended === 'interface' || ended === 'enum' || CLOSABLE.has(ended)) {
        closeContainer(stack, ended, i);
      } else {
        closeMembers(stack, i);
      }
      continue;
    }

    const syms = matchAll(lines[i], code, i);
    if (!syms.length) {
      continue;
    }
    for (const sym of syms) {
      beforeAdd(sym, stack, lastCodeLine(codes, i));
      addSymbol(roots, stack, sym);
    }
  }

  const last = Math.max(0, lines.length - 1);
  closeMembers(stack, last);
  while (stack.length) {
    const sym = stack.pop();
    if (sym.endLine == null) {
      sym.endLine = last;
    }
  }
  fixRanges(roots);
  return roots;
}

function addSymbol(roots, stack, sym) {
  const parent = topContainer(stack);
  (parent ? parent.children : roots).push(sym);
  if (sym.isContainer || sym.extendRange) {
    stack.push(sym);
  }
}

function beforeAdd(sym, stack, endLine) {
  closeMembers(stack, endLine);
  if (sym.kind === 'field' || sym.kind === 'index') {
    return;
  }
  if (sym.kind === 'include' || sym.kind === 'property' || sym.kind === 'dataset' || sym.kind === 'temptable') {
    closeWhile(stack, new Set(['temptable']), endLine);
    return;
  }
  closeWhile(stack, CLOSABLE, endLine);
}

function topContainer(stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].isContainer && stack[i].endLine == null) {
      return stack[i];
    }
  }
  return null;
}

function closeMembers(stack, endLine) {
  while (stack.length && !stack[stack.length - 1].isContainer && stack[stack.length - 1].endLine == null) {
    stack.pop().endLine = endLine;
  }
}

function closeWhile(stack, kinds, endLine) {
  while (stack.length && kinds.has(stack[stack.length - 1].kind) && stack[stack.length - 1].endLine == null) {
    stack.pop().endLine = endLine;
  }
}

function closeContainer(stack, kind, endLine) {
  closeMembers(stack, endLine);
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].isContainer && stack[i].kind === kind && stack[i].endLine == null) {
      for (let j = stack.length - 1; j >= i; j--) {
        if (stack[j].endLine == null) {
          stack[j].endLine = endLine;
        }
      }
      stack.length = i;
      return;
    }
  }
}

function lastCodeLine(codes, line) {
  for (let i = line - 1; i >= 0; i--) {
    if (codes[i] && codes[i].trim()) {
      return i;
    }
  }
  return Math.max(0, line);
}

function fixRanges(nodes) {
  for (const node of nodes) {
    if (node.endLine == null || node.endLine < node.line) {
      node.endLine = node.line;
    }
    fixRanges(node.children);
  }
}

function stripLine(line, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];
    if (state.inBlock) {
      const end = line.indexOf('*/', i);
      if (end < 0) {
        return out;
      }
      state.inBlock = false;
      i = end + 2;
      continue;
    }
    if (state.inString) {
      if (ch === state.quote) {
        if (next === state.quote) {
          i += 2;
          continue;
        }
        state.inString = false;
        state.quote = '';
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      state.inString = true;
      state.quote = ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      state.inBlock = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '/') {
      break;
    }
    out += ch;
    i++;
  }
  return out;
}

function maskLines(text) {
  const lines = String(text).split(/\r?\n/);
  const state = { inBlock: false, inString: false, quote: '' };
  return lines.map(line => maskLine(line, state));
}

function maskLine(line, state) {
  const chars = line.split('');
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    const next = chars[i + 1];
    if (state.inBlock) {
      const end = line.indexOf('*/', i);
      if (end < 0) {
        for (let j = i; j < chars.length; j++) chars[j] = ' ';
        return chars.join('');
      }
      for (let j = i; j < end + 2 && j < chars.length; j++) chars[j] = ' ';
      state.inBlock = false;
      i = end + 2;
      continue;
    }
    if (state.inString) {
      chars[i] = ' ';
      if (ch === state.quote) {
        if (next === state.quote) {
          chars[i + 1] = ' ';
          i += 2;
          continue;
        }
        state.inString = false;
        state.quote = '';
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      state.inString = true;
      state.quote = ch;
      chars[i] = ' ';
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      state.inBlock = true;
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '/') {
      for (let j = i; j < chars.length; j++) chars[j] = ' ';
      return chars.join('');
    }
    i++;
  }
  return chars.join('');
}

function matchEnd(code) {
  const match = code.match(/^\s*end\s+(method|constructor|destructor|procedure|function|class|interface|enum)\b/i);
  return match ? match[1].toLowerCase() : null;
}

function matchAll(rawLine, code, line) {
  const classLike = matchClassLike(rawLine, code, line);
  if (classLike) return [classLike];

  const ctor = matchConstructor(rawLine, code, line);
  if (ctor) return [ctor];

  const dtor = matchDestructor(rawLine, code, line);
  if (dtor) return [dtor];

  const method = matchMethod(rawLine, code, line);
  if (method) return [method];

  const prop = matchProperty(rawLine, code, line);
  if (prop) return [prop];

  const proc = matchProcedure(rawLine, code, line);
  if (proc) return [proc];

  const fn = matchFunction(rawLine, code, line);
  if (fn) return [fn];

  const table = matchTempTable(rawLine, code, line);
  if (table) {
    return [table].concat(matchInlineMembers(rawLine, code, line));
  }

  const dataset = matchDataset(rawLine, code, line);
  if (dataset) return [dataset];

  const field = matchField(rawLine, code, line);
  if (field) return [field];

  const index = matchIndex(rawLine, code, line);
  if (index) return [index];

  return matchIncludes(rawLine, code, line);
}

function symbol(rawLine, name, detail, kind, line, isContainer, singleLine, extendRange) {
  const pos = namePos(rawLine, name);
  return {
    name,
    detail,
    kind,
    line,
    endLine: singleLine ? line : null,
    nameStart: pos.start,
    nameEnd: pos.end,
    isContainer,
    extendRange: Boolean(extendRange),
    children: []
  };
}

function matchClassLike(rawLine, code, line) {
  let match = code.match(/^\s*(?:(?:abstract|final|serializable)\s+)*class\s+([\w.]+)/i);
  if (match) return symbol(rawLine, match[1], 'class', 'class', line, true, false);
  match = code.match(/^\s*interface\s+([\w.]+)/i);
  if (match) return symbol(rawLine, match[1], 'interface', 'interface', line, true, false);
  match = code.match(/^\s*enum\s+([\w.]+)/i);
  if (match) return symbol(rawLine, match[1], 'enum', 'enum', line, true, false);
  return null;
}

function matchMethod(rawLine, code, line) {
  if (!/^\s*method\b/i.test(code)) return null;
  const paren = code.indexOf('(');
  const head = (paren >= 0 ? code.slice(0, paren) : code).replace(/^\s*method\s+/i, '').trim();
  const tokens = head.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const name = tokens[tokens.length - 1];
  if (!isName(name)) return null;
  return symbol(rawLine, name, tokens.slice(0, -1).join(' '), 'method', line, true, false);
}

function matchConstructor(rawLine, code, line) {
  if (!/^\s*constructor\b/i.test(code)) return null;
  const paren = code.indexOf('(');
  const head = (paren >= 0 ? code.slice(0, paren) : code).replace(/^\s*constructor\s+/i, '').trim();
  const tokens = head.split(/\s+/).filter(Boolean);
  const name = tokens.filter(token => !ACCESS.has(token.toLowerCase())).pop();
  if (!name || !isName(name)) return null;
  const detail = tokens.filter(token => ACCESS.has(token.toLowerCase())).join(' ');
  return symbol(rawLine, name, detail || 'constructor', 'constructor', line, true, false);
}

function matchDestructor(rawLine, code, line) {
  const match = code.match(/^\s*destructor\s+(?:(?:public|protected|private)\s+)?([\w.]+)/i);
  if (!match) return null;
  return symbol(rawLine, match[1], 'destructor', 'destructor', line, true, false);
}

function matchProperty(rawLine, code, line) {
  const match = code.match(/^\s*(?:define|def)\s+((?:(?:public|protected|private|static|abstract|override|new|serializable|non-serializable)\s+)*)property\s+([\w-]+)/i);
  if (!match) return null;
  return symbol(rawLine, match[2], match[1].trim(), 'property', line, false, false, true);
}

function matchProcedure(rawLine, code, line) {
  const match = code.match(/^\s*procedure\s+([\w-]+)/i);
  if (!match || !isName(match[1])) return null;
  return symbol(rawLine, match[1], 'procedure', 'procedure', line, true, false);
}

function matchFunction(rawLine, code, line) {
  const match = code.match(/^\s*function\s+([\w-]+)\s+returns\s+([\w.-]+)/i);
  if (!match || !isName(match[1])) return null;
  const forward = /\bforward\b/i.test(code) ? ' forward' : '';
  return symbol(rawLine, match[1], 'returns ' + match[2] + forward, 'function', line, true, false);
}

function matchTempTable(rawLine, code, line) {
  const match = code.match(/^\s*(?:define|def)\s+(?:(?:private|protected|public|static|global|shared|new|serializable|non-serializable)\s+)*temp-table\s+(\S+)/i);
  if (!match || !isName(match[1])) return null;
  return symbol(rawLine, match[1], 'temp-table', 'temptable', line, true, false);
}

function matchDataset(rawLine, code, line) {
  const match = code.match(/^\s*(?:define|def)\s+dataset\s+(\S+)/i);
  if (!match || !isName(match[1])) return null;
  const forTable = code.match(/\bfor\s+(\S+)/i);
  const detail = forTable ? 'for ' + forTable[1].replace(/\.$/, '') : 'dataset';
  return symbol(rawLine, match[1], detail, 'dataset', line, false, true);
}

function matchField(rawLine, code, line) {
  const match = code.match(/^\s*field\s+(\S+)(?:\s+as\s+(\S+))?/i);
  if (!match || !isName(match[1])) return null;
  return symbol(rawLine, match[1], (match[2] || '').replace(/\.$/, ''), 'field', line, false, true);
}

function matchIndex(rawLine, code, line) {
  const match = code.match(/^\s*index\s+(\S+)/i);
  if (!match || !isName(match[1])) return null;
  return symbol(rawLine, match[1], 'index', 'index', line, false, true);
}

function matchInlineMembers(rawLine, code, line) {
  const found = [];
  const fieldRe = /\bfield\s+(\S+)(?:\s+as\s+(\S+))?/gi;
  const indexRe = /\bindex\s+(\S+)/gi;
  let match;
  while ((match = fieldRe.exec(code))) {
    if (!isName(match[1])) continue;
    found.push(symbol(rawLine, match[1], (match[2] || '').replace(/\.$/, ''), 'field', line, false, true));
  }
  while ((match = indexRe.exec(code))) {
    if (!isName(match[1])) continue;
    found.push(symbol(rawLine, match[1], 'index', 'index', line, false, true));
  }
  return found;
}

function matchIncludes(rawLine, code, line) {
  const found = [];
  const re = /\{\s*(?![&\d])([^}\s]+)/g;
  let match;
  while ((match = re.exec(code))) {
    const path = match[1].replace(/\\/g, '/');
    if (!path.includes('/') && !/\.(i|pi|p|w|cls)$/i.test(path)) continue;
    const fileName = path.split('/').pop();
    const dir = path.slice(0, Math.max(0, path.length - fileName.length - 1));
    found.push(symbol(rawLine, fileName, dir, 'include', line, false, true));
  }
  return found;
}

function isName(name) {
  return /^[\w.&{}-]+$/.test(name) && !NAME_KEYWORDS.has(String(name).toLowerCase());
}

function namePos(rawLine, name) {
  const paren = rawLine.indexOf('(');
  const region = rawLine.slice(0, paren >= 0 ? paren : rawLine.length);
  const idx = region.toLowerCase().lastIndexOf(String(name).toLowerCase());
  if (idx < 0) {
    return { start: 0, end: Math.min(String(name).length, rawLine.length) };
  }
  return { start: idx, end: idx + String(name).length };
}

function sortOutline(nodes) {
  return (nodes || []).map(node => Object.assign({}, node, {
    children: sortOutline(node.children)
  })).sort(compareOutline);
}

function compareOutline(a, b) {
  const byName = String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base', numeric: true });
  if (byName) return byName;
  return (a.line - b.line) || ((a.nameStart || 0) - (b.nameStart || 0));
}

module.exports = { parse, maskLines, sortOutline };

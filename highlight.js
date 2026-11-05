'use strict';

const { parse, maskLines } = require('./parser');

const KEYWORDS = new Set((
  'abstract and as ascending available buffer by by-reference can-find case catch character class ' +
  'constructor create data-source dataset dataset-handle date datetime datetime-tz decimal def define ' +
  'delete destructor do each else end enum error exclusive-lock extent field finally find first for ' +
  'forward frame from function get handle if implements in index inherits initial input input-output ' +
  'int64 integer interface last leave like logical longchar memptr method new next no no-error no-lock ' +
  'no-undo not of on or otherwise output override parameter persistent primary private procedure ' +
  'property protected public query quit raw recid reference-only repeat return returns routine-level ' +
  'rowid run serialize-name set share-lock static stop stream super table table-handle temp-table then ' +
  'this-object this-procedure throw to transaction true false undo unique using variable void where while ' +
  'work-table yes unknown'
).split(/\s+/));

const TOKEN_RE = /[A-Za-z_](?:[\w$-]|\{&[\w-]+\})*/g;

function emptyNames() {
  return {
    tables: new Set(),
    fields: new Set(),
    datasets: new Set(),
    variables: new Set(),
    parameters: new Set(),
    buffers: new Set(),
    properties: new Set(),
    methods: new Set(),
    procedures: new Set()
  };
}

function addName(set, name) {
  if (!name) return;
  const text = String(name).replace(/\.$/, '');
  if (!text || KEYWORDS.has(text.toLowerCase())) return;
  set.add(text.toLowerCase());
  const alias = text.replace(/\{&[\w-]+\}/gi, '');
  if (alias && alias !== text) set.add(alias.toLowerCase());
}

function mergeNames(target, extra) {
  if (!extra) return target;
  for (const key of Object.keys(target)) {
    for (const name of extra[key] || []) target[key].add(name);
  }
  return target;
}

function structuralNames(text) {
  const names = emptyNames();
  walk(parse(text), sym => {
    if (sym.kind === 'temptable') addName(names.tables, sym.name);
    else if (sym.kind === 'field') addName(names.fields, sym.name);
    else if (sym.kind === 'dataset') addName(names.datasets, sym.name);
    else if (sym.kind === 'property') addName(names.properties, sym.name);
    else if (sym.kind === 'method' || sym.kind === 'constructor' || sym.kind === 'destructor') addName(names.methods, sym.name);
    else if (sym.kind === 'procedure' || sym.kind === 'function') addName(names.procedures, sym.name);
  });
  return names;
}

function collectNames(text) {
  const names = structuralNames(text);
  for (const line of maskLines(text)) {
    scanDefinitions(line, names);
  }
  return names;
}

function listIncludes(text) {
  const found = [];
  walk(parse(text), sym => {
    if (sym.kind === 'include') {
      const path = sym.detail ? sym.detail + '/' + sym.name : sym.name;
      found.push(path);
    }
  });
  return found;
}

function scanDefinitions(line, names) {
  let match;
  const varRe = /(?:^|\s)(?:define|def)\s+(?:(?:new|shared|private|protected|public|static|global|serializable|non-serializable)\s+)*(?:variable|var)\s+([A-Za-z_][\w$-]*)/gi;
  while ((match = varRe.exec(line))) addName(names.variables, match[1]);

  const paramRe = /(?:input-output|input|output)\s+parameter\s+([A-Za-z_][\w$-]*)/gi;
  while ((match = paramRe.exec(line))) addName(names.parameters, match[1]);

  const argRe = /(?:input-output|input|output)\s+([A-Za-z_][\w$-]*)\s+as\b/gi;
  while ((match = argRe.exec(line))) addName(names.parameters, match[1]);

  const bufRe = /(?:define|def)\s+buffer\s+([A-Za-z_][\w$-]*)\s+for\s+([A-Za-z_](?:[\w$-]|\{&[\w-]+\})*)/gi;
  while ((match = bufRe.exec(line))) {
    addName(names.buffers, match[1]);
    addName(names.tables, match[2]);
  }

  const queryRe = /(?:define|def)\s+(?:query|stream|data-source)\s+([A-Za-z_][\w$-]*)/gi;
  while ((match = queryRe.exec(line))) addName(names.variables, match[1]);
}

function tokenSpans(text, extra) {
  const names = mergeNames(collectNames(text), extra);
  const lines = maskLines(text);
  const spans = [];
  for (let i = 0; i < lines.length; i++) {
    scanLine(lines[i], i, names, spans);
  }
  spans.sort((a, b) => a.line - b.line || a.start - b.start || a.length - b.length);
  const out = [];
  let last = null;
  for (const span of spans) {
    if (span.length <= 0) continue;
    if (last && span.line === last.line && span.start < last.start + last.length) continue;
    out.push(span);
    last = span;
  }
  return out;
}

function scanLine(masked, line, names, spans) {
  const parts = [];
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(masked))) {
    parts.push({ name: match[0], start: match.index });
  }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const prevOp = operatorBetween(parts[i - 1], part, masked);
    const nextOp = operatorBetween(part, parts[i + 1], masked);
    const type = tokenType(part, prevOp, nextOp, masked, names, parts[i - 1] && parts[i - 1].name);
    if (type) {
      spans.push({ line, start: part.start, length: part.name.length, type });
    }
  }
}

function tokenType(part, prevOp, nextOp, masked, names, prevName) {
  const key = part.name.toLowerCase();
  if (KEYWORDS.has(key)) return null;
  if (prevOp === '.') {
    if (prevName && /^[a-z][a-z0-9-]*$/.test(prevName)) return /^[A-Z]/.test(part.name) ? 'class' : null;
    return 'field';
  }
  if (prevOp === ':') return /^\s*\(/.test(masked.slice(part.start + part.name.length)) ? 'method' : 'property';
  if (nextOp === '.') {
    if (/^[a-z][a-z0-9-]*$/.test(part.name)) return null;
    return names.buffers.has(key) ? 'buffer' : 'table';
  }
  if (nextOp === ':') {
    const known = classify(key, names);
    if (known) return known;
    return /^[A-Z]/.test(part.name) ? 'class' : 'variable';
  }
  const known = classify(key, names);
  if (known) return known;
  const before = statementBefore(masked, part.start);
  if (/(?:for\s+each|find(?:\s+(?:first|last|next|prev|current))?)\s+$/i.test(before)) return 'table';
  if (/\b(?:new|as|inherits|implements|using|class|interface|enum)\s+(?:class\s+)?$/i.test(before)) return 'class';
  return null;
}

function classify(key, names) {
  if (names.methods.has(key)) return 'method';
  if (names.procedures.has(key)) return 'function';
  if (names.datasets.has(key)) return 'dataset';
  if (names.buffers.has(key)) return 'buffer';
  if (names.tables.has(key)) return 'table';
  if (names.properties.has(key)) return 'property';
  if (names.parameters.has(key)) return 'parameter';
  if (names.variables.has(key)) return 'variable';
  if (names.fields.has(key)) return 'field';
  return null;
}

function operatorBetween(left, right, masked) {
  if (!left || !right) return null;
  const between = masked.slice(left.start + left.name.length, right.start);
  const match = between.match(/^\s*([.:])\s*$/) || between.match(/^\s*\(\s*\)\s*([.:])\s*$/);
  return match ? match[1] : null;
}

function statementBefore(masked, start) {
  const before = masked.slice(0, start);
  const dot = Math.max(before.lastIndexOf('.'), before.lastIndexOf(':'));
  return before.slice(dot + 1);
}

function walk(nodes, fn) {
  for (const node of nodes || []) {
    fn(node);
    walk(node.children, fn);
  }
}

module.exports = {
  collectNames,
  structuralNames,
  emptyNames,
  mergeNames,
  listIncludes,
  tokenSpans
};

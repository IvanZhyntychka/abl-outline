'use strict';

const fs = require('fs');
const path = require('path');
const { maskLines, parse } = require('./parser');

const SKIP = new Set([
  'character', 'class', 'com-handle', 'dataset', 'dataset-handle', 'date', 'datetime',
  'datetime-tz', 'dec', 'decimal', 'enum', 'handle', 'int', 'int64', 'integer',
  'interface', 'log', 'logical', 'longchar', 'memptr', 'object', 'raw', 'recid',
  'rowid', 'table', 'table-handle', 'void'
]);

function collectTargets(text) {
  const masked = maskLines(text);
  const raw = String(text).split(/\r?\n/);
  const links = [];
  const covered = masked.map(() => []);
  const imported = new Map();

  for (let i = 0; i < masked.length; i++) {
    const line = masked[i];
    let match;
    const includeRe = /\{\s*(?![&\d])([^}\s]+)/g;
    while ((match = includeRe.exec(line))) {
      const path = safeRelativePath(match[1]);
      if (!path || (!path.includes('/') && !/\.(i|pi|p|w|cls)$/i.test(path))) continue;
      addLink(links, covered, {
        line: i,
        start: match.index,
        end: match.index + match[0].length,
        kind: 'include',
        rel: path
      });
    }

    const qualifiedRe = /(?<![\w.])((?:[\w-]+\.){2,}[\w-]+)(?![\w])/g;
    while ((match = qualifiedRe.exec(line))) {
      const name = match[1];
      addLink(links, covered, {
        line: i,
        start: match.index,
        end: match.index + name.length,
        kind: 'class',
        rel: name.replace(/\./g, '/') + '.cls',
        simpleName: name.split('.').pop()
      });
      if (/^\s*using\s+/i.test(raw[i])) imported.set(name.split('.').pop().toLowerCase(), name);
    }
  }

  for (let i = 0; i < masked.length; i++) {
    for (const [simpleLower, qualified] of imported) {
      const simple = qualified.split('.').pop();
      const re = new RegExp('(?<![\\w.])' + escapeRegExp(simple) + '(?![\\w])', 'gi');
      let match;
      while ((match = re.exec(masked[i]))) {
        if (match[0].toLowerCase() !== simpleLower) continue;
        addLink(links, covered, {
          line: i,
          start: match.index,
          end: match.index + match[0].length,
          kind: 'class',
          rel: qualified.replace(/\./g, '/') + '.cls',
          simpleName: simple
        });
      }
    }

    const typeRe = /\b(?:new|inherits|implements|as)\s+(?:class\s+)?((?:[\w-]+\.)*\w+)/gi;
    let match;
    while ((match = typeRe.exec(masked[i]))) {
      const name = match[1];
      const simple = name.split('.').pop();
      if (SKIP.has(simple.toLowerCase())) continue;
      const start = match.index + match[0].lastIndexOf(name);
      addLink(links, covered, {
        line: i,
        start,
        end: start + name.length,
        kind: name.includes('.') ? 'class' : 'class-simple',
        rel: name.includes('.') ? name.replace(/\./g, '/') + '.cls' : simple + '.cls',
        simpleName: simple
      });
    }
  }

  return links;
}

function targetAt(text, line, character) {
  return collectTargets(text).find(link =>
    link.line === line && character >= link.start && character < link.end
  ) || null;
}

function landingPosition(text, simpleName) {
  const wanted = String(simpleName || '').toLowerCase();
  let found = null;
  let first = null;
  walk(parse(text), node => {
    if (node.kind !== 'class' && node.kind !== 'interface' && node.kind !== 'enum') return;
    if (!first) first = node;
    const shortName = node.name.split('.').pop().toLowerCase();
    if (wanted && (shortName === wanted || node.name.toLowerCase() === wanted)) found = node;
  });
  const node = found || first;
  if (!node) return { line: 0, character: 0 };
  return { line: node.line, character: node.nameStart || 0 };
}

function addLink(links, covered, link) {
  const row = covered[link.line];
  if (row.some(range => link.start < range.end && link.end > range.start)) return;
  row.push({ start: link.start, end: link.end });
  links.push(link);
}

function walk(nodes, fn) {
  for (const node of nodes || []) {
    fn(node);
    walk(node.children, fn);
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeRelativePath(rel) {
  const text = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!text || text.length > 240) return '';
  if (!/^[A-Za-z0-9_./-]+$/.test(text)) return '';
  const parts = text.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '.' || part === '..')) return '';
  return parts.join('/');
}

function isInside(root, file) {
  const base = path.resolve(root);
  const target = path.resolve(file);
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function findSourceFiles(rel, workspaceFolders) {
  const suffix = safeRelativePath(rel);
  if (!suffix) return [];
  const parts = suffix.split('/');
  const homes = projectHomes(workspaceFolders);
  const found = [];
  for (const home of homes) {
    const dirs = [home];
    let children = [];
    try {
      children = fs.readdirSync(home, { withFileTypes: true });
    } catch (error) {
      children = [];
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      if (child.name === 'node_modules' || child.name === 'tmp' || child.name.startsWith('.')) continue;
      dirs.push(path.join(home, child.name));
    }
    for (const dir of dirs) {
      if (!homes.some(root => isInside(root, dir))) continue;
      for (const layout of ['src/api', 'src/impl', 'src']) {
        const full = path.join(dir, layout, ...parts);
        try {
          if (!fs.statSync(full).isFile()) continue;
          const real = fs.realpathSync(full);
          if (homes.some(root => isInside(root, real))) found.push(real);
        } catch (error) {
          // not this layout
        }
      }
    }
  }
  return [...new Set(found)].sort((a, b) => sourceScore(a) - sourceScore(b));
}

function projectHomes(workspaceFolders) {
  const homes = new Set();
  for (const folder of workspaceFolders || []) {
    if (!folder) continue;
    const root = path.resolve(folder);
    homes.add(root);
    const parent = path.dirname(root);
    if (parent && parent !== root) homes.add(parent);
  }
  return [...homes];
}

function sourceScore(file) {
  const lower = file.replace(/\\/g, '/').toLowerCase();
  let score = lower.length / 10000;
  if (lower.includes('/tmp/')) score += 100;
  if (lower.includes('/lib/')) score += 40;
  if (lower.includes('/test')) score += 30;
  if (/\/[a-z0-9]+-\d/.test(lower)) score += 5;
  if (lower.includes('/src/api/') || lower.includes('/src/impl/')) score -= 10;
  return score;
}

const ACCESS = new Set(['public', 'protected', 'private', 'static', 'abstract', 'override', 'final', 'new', 'serializable', 'non-serializable']);
const PRIMITIVE = new Set([
  'character', 'com-handle', 'dataset', 'dataset-handle', 'date', 'datetime', 'datetime-tz',
  'dec', 'decimal', 'handle', 'int', 'int64', 'integer', 'logical', 'longchar', 'memptr',
  'raw', 'recid', 'rowid', 'void', 'object', 'table', 'table-handle'
]);
const MEMBER_KINDS = new Set(['method', 'constructor', 'destructor', 'property', 'procedure', 'function']);
const ARG_KIND = {
  'method-name': 'method',
  'prop': 'property',
  'property-name': 'property',
  'function-name': 'function'
};

function cursorSymbol(text, line, character) {
  const masked = maskLines(text);
  const row = masked[line];
  if (row == null) return null;
  const tokens = tokensOnLine(row);
  const index = tokens.findIndex(token => character >= token.start && character <= token.end);
  if (index < 0) return null;
  const token = tokens[index];
  if (SKIP.has(token.name.toLowerCase()) || token.name.toLowerCase() === 'end') return null;

  const colonChain = chainAcross(tokens, row, index, ':');
  if (colonChain.length > 1 || /^(this-object|super)$/i.test(token.name)) {
    return { kind: 'member', chain: colonChain.map(part => part.name), name: token.name };
  }

  const dotChain = chainAcross(tokens, row, index, '.');
  if (dotChain.length === 2) {
    const left = dotChain[0].name;
    const right = dotChain[1].name;
    const packagePart = /^[a-z][a-z0-9-]*$/;
    if (packagePart.test(left) && (packagePart.test(right) || /^[A-Z]/.test(right))) return null;
    const onRight = dotChain[1].start === token.start;
    return { kind: 'field', table: left, field: onRight ? right : null, name: token.name };
  }
  if (dotChain.length > 2) return null;

  const before = row.slice(0, token.start);
  if (/\brun\s+$/i.test(before)) return { kind: 'procedure', name: token.name };
  return { kind: 'name', name: token.name, line, character: token.start };
}

async function resolveCursor(text, line, character, load) {
  const symbol = cursorSymbol(text, line, character);
  if (!symbol || !load) return [];
  if (symbol.kind === 'member') return resolveMember(text, symbol, load);
  if (symbol.kind === 'field') return resolveField(text, symbol, load);
  if (symbol.kind === 'procedure') return resolveProcedure(text, symbol.name, load);
  if (symbol.kind === 'name') return resolveBareName(text, symbol, load);
  return [];
}

async function resolveMember(text, symbol, load) {
  const chain = symbol.chain.slice();
  let current = { text, path: null };
  const seen = new Set();

  if (/^this-object$/i.test(chain[0])) {
    chain.shift();
    if (!chain.length) return classLocation(text);
  } else if (/^super$/i.test(chain[0])) {
    chain.shift();
    const parent = classHeaderInfo(text).inherits[0];
    current = parent ? await openType(parent, text, load) : null;
    if (!current) return [];
    if (!chain.length) return classLocation(current.text, current.path);
  } else if (chain.length > 1) {
    const receiver = chain.shift();
    const declared = declaredType(text, receiver);
    current = await openType(declared || receiver, text, load);
    if (!current) return chain.length === 0 ? locationsFromMembers(text, null, receiver) : [];
  }

  while (chain.length > 1 && current) {
    const step = chain.shift();
    const returnType = memberReturnType(current.text, step);
    if (!returnType) return [];
    current = await openType(returnType, current.text, load);
  }
  if (!current || !chain.length) return [];

  const name = chain[0];
  const direct = locationsFromMembers(current.text, current.path, name);
  if (direct.length) return direct;
  return inheritedMembers(current.text, name, load, seen);
}

async function inheritedMembers(text, name, load, seen) {
  const header = classHeaderInfo(text);
  const locations = [];
  for (const typeName of header.inherits.concat(header.implements)) {
    const opened = await openType(typeName, text, load);
    if (!opened || seen.has(opened.path)) continue;
    seen.add(opened.path);
    locations.push(...locationsFromMembers(opened.text, opened.path, name));
    if (!locations.length) locations.push(...await inheritedMembers(opened.text, name, load, seen));
  }
  return locations;
}

async function resolveField(text, symbol, load) {
  const visible = await visibleTables(text, load);
  const table = visible.find(item => item.name.toLowerCase() === symbol.table.toLowerCase())
    || visible.find(item => item.buffers.some(buffer => buffer.toLowerCase() === symbol.table.toLowerCase()));
  if (!table) return [];
  if (!symbol.field) return [{ path: table.path, line: table.line, character: table.character }];
  const field = table.fields.find(item => item.name.toLowerCase() === symbol.field.toLowerCase());
  if (field) return [{ path: field.path, line: field.line, character: field.character }];
  return [];
}

async function resolveProcedure(text, name, load) {
  const local = locationsFromMembers(text, null, name).filter(item => item.kind === 'procedure' || item.kind === 'function');
  if (local.length) return local;
  if (!load.procedures) return [];
  return load.procedures(name);
}

function classLocation(text, path) {
  const header = classHeaderInfo(text);
  const pos = landingPosition(text, header.fullName);
  return [{ path: path || null, line: pos.line, character: pos.character, kind: 'class' }];
}

async function resolveBareName(text, symbol, load) {
  const variable = findVariable(text, symbol.name);
  if (variable && variable.line !== symbol.line) {
    return [{ path: null, line: variable.line, character: variable.character, kind: 'variable' }];
  }

  const localMember = locationsFromMembers(text, null, symbol.name);
  const onDefinition = localMember.some(item => item.line === symbol.line);
  if (localMember.length && !onDefinition) return localMember;

  if (!/^(tt|ds|buf)/i.test(symbol.name)) {
    if (!onDefinition) return [];
  }

  const visible = await visibleTables(text, load);
  const table = visible.find(item => item.name.toLowerCase() === symbol.name.toLowerCase());
  if (table) return [{ path: table.path, line: table.line, character: table.character, kind: 'temptable' }];
  const dataset = visible.find(item => item.dataset && item.dataset.toLowerCase() === symbol.name.toLowerCase());
  if (dataset && dataset.datasetLine != null) {
    return [{ path: dataset.datasetPath || dataset.path, line: dataset.datasetLine, character: dataset.datasetCharacter || 0, kind: 'dataset' }];
  }

  if (onDefinition) {
    const header = classHeaderInfo(text);
    const locations = [];
    for (const typeName of header.implements.concat(header.inherits)) {
      const opened = await openType(typeName, text, load);
      if (opened) locations.push(...locationsFromMembers(opened.text, opened.path, symbol.name));
    }
    return locations;
  }
  return [];
}

async function openType(typeName, fromText, load) {
  if (!typeName || PRIMITIVE.has(String(typeName).toLowerCase())) return null;
  const header = classHeaderInfo(fromText);
  let full = typeName;
  if (!typeName.includes('.')) {
    const imported = importsOf(fromText).get(typeName.toLowerCase());
    if (imported) full = imported;
    else if (header.fullName && header.fullName.includes('.')) {
      full = header.fullName.split('.').slice(0, -1).concat(typeName).join('.');
    }
  }
  const rel = full.replace(/\./g, '/') + '.cls';
  const opened = await load(rel, typeName);
  return opened || null;
}

function locationsFromMembers(text, path, name) {
  return findMembers(text, name).map(member => ({
    path,
    line: member.line,
    character: member.character,
    kind: member.kind
  }));
}

function findMembers(text, name) {
  if (!name || String(name).length > 200) return [];
  const wanted = String(name || '').toLowerCase();
  return findAllMembers(text).filter(member => member.name.toLowerCase() === wanted);
}

function findAllMembers(text) {
  const found = [];
  walk(parse(text), node => {
    if (!MEMBER_KINDS.has(node.kind)) return;
    found.push({
      name: node.name,
      line: node.line,
      character: node.nameStart || 0,
      kind: node.kind,
      detail: node.detail || '',
      returnType: typeFromDetail(node.detail)
    });
  });
  const lines = String(text).split(/\r?\n/);
  const argRe = /&(METHOD-NAME|PROP|PROPERTY-NAME|FUNCTION-NAME)\s*=\s*"?([\w-]+)"?/gi;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('&')) continue;
    let match;
    while ((match = argRe.exec(line))) {
      const memberName = match[2];
      const iface = line.match(/&(SERVICEINTERFACE|RETURNS)\s*=\s*"([\w.]+)"/i);
      found.push({
        name: memberName,
        line: i,
        character: match.index + match[0].lastIndexOf(memberName),
        kind: ARG_KIND[match[1].toLowerCase()] || 'method',
        detail: '',
        returnType: iface ? iface[2] : null
      });
    }
    argRe.lastIndex = 0;
  }
  return found;
}

function memberReturnType(text, name) {
  const declared = declaredType(text, name);
  if (declared) return declared;
  const member = findMembers(text, name)[0];
  return member ? member.returnType : null;
}

function declaredType(text, name) {
  if (!name || String(name).length > 200) return null;
  const lines = maskLines(text);
  const propRe = new RegExp('\\bproperty\\s+' + escapeRegExp(name) + '\\s+as\\s+(?:class\\s+)?([\\w.]+)', 'i');
  const varRe = new RegExp('\\b(?:variable|var|parameter)\\s+' + escapeRegExp(name) + '\\s+as\\s+(?:class\\s+)?([\\w.]+)', 'i');
  const argRe = new RegExp('\\b(?:input-output|input|output)\\s+' + escapeRegExp(name) + '\\s+as\\s+(?:class\\s+)?([\\w.]+)', 'i');
  for (const line of lines) {
    const match = line.match(propRe) || line.match(varRe) || line.match(argRe);
    if (match && !PRIMITIVE.has(match[1].toLowerCase())) return match[1];
  }
  return null;
}

function findVariable(text, name) {
  const lines = maskLines(text);
  const re = new RegExp('\\b(?:variable|var|parameter|buffer|property)\\s+(' + escapeRegExp(name) + ')\\b', 'i');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(re);
    if (!match) continue;
    return { line: i, character: match.index + match[0].lastIndexOf(match[1]) };
  }
  return null;
}

function classHeaderInfo(text) {
  const match = String(text).match(/(?:^|\n)\s*(?:(?:abstract|final|serializable)\s+)*(class|interface|enum)\s+([\w.]+)([^\n]*)/i);
  if (!match) return { kind: '', fullName: '', inherits: [], implements: [] };
  const rest = match[3] || '';
  return {
    kind: match[1].toLowerCase(),
    fullName: match[2],
    inherits: grabClause(rest, 'inherits'),
    implements: grabClause(rest, 'implements')
  };
}

function grabClause(header, keyword) {
  const match = header.match(new RegExp('\\b' + keyword + '\\s+([^:\\n]+)', 'i'));
  if (!match) return [];
  const segment = match[1].split(/\b(?:inherits|implements|final|abstract|serializable|use-widget-pool)\b/i)[0];
  return segment.split(',').map(part => part.trim()).filter(part => /^[\w.]+$/.test(part));
}

function importsOf(text) {
  const map = new Map();
  const re = /^\s*using\s+((?:[\w-]+\.)+[\w-]+)\s*\./gim;
  let match;
  while ((match = re.exec(text))) {
    const full = match[1];
    map.set(full.split('.').pop().toLowerCase(), full);
  }
  return map;
}

function includeDirectives(text) {
  const found = [];
  const lines = blankComments(text);
  const re = /\{\s*(?![&\d])([^}]+)\}/g;
  for (let i = 0; i < lines.length; i++) {
    let match;
    while ((match = re.exec(lines[i]))) {
      const body = match[1].trim();
      const path = safeRelativePath(body.split(/\s+/)[0]);
      if (!path) continue;
      if (!path.includes('/') && !/\.(i|pi|p|w|cls)$/i.test(path)) continue;
      found.push({ line: i, path, args: includeArgs(body) });
    }
    re.lastIndex = 0;
  }
  return found;
}

function includeArgs(body) {
  const args = {};
  const re = /&([\w-]+)\s*=\s*(?:"([^"]*)"|([\w.-]+))/g;
  let match;
  while ((match = re.exec(body))) {
    const value = match[2] != null && match[2] !== '' ? match[2] : match[3];
    if (value && value.length <= 80 && /^[\w.-]+$/.test(value)) args[match[1].toLowerCase()] = value;
  }
  return args;
}

function blankComments(text) {
  const lines = String(text).split(/\r?\n/);
  const state = { inBlock: false };
  return lines.map(line => {
    const chars = line.split('');
    let i = 0;
    while (i < chars.length) {
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
      const quote = chars[i] === '"' || chars[i] === "'" ? chars[i] : '';
      if (quote) {
        i++;
        while (i < chars.length) {
          if (chars[i] === quote && chars[i + 1] === quote) { i += 2; continue; }
          if (chars[i] === quote) { i++; break; }
          i++;
        }
        continue;
      }
      if (chars[i] === '/' && chars[i + 1] === '*') {
        state.inBlock = true;
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (chars[i] === '/' && chars[i + 1] === '/') {
        for (let j = i; j < chars.length; j++) chars[j] = ' ';
        return chars.join('');
      }
      i++;
    }
    return chars.join('');
  });
}

function applyDefines(name, defines) {
  return String(name).replace(/\{&([\w-]+)\}/gi, (_, key) => {
    const value = defines[String(key).toLowerCase()];
    return value == null ? '' : value;
  });
}

async function visibleTables(text, load) {
  const tables = [];
  collectTables(text, {}, null, tables);
  for (const include of includeDirectives(text)) {
    const opened = await load(include.path);
    if (!opened) continue;
    collectTables(opened.text, include.args, opened.path, tables);
    const regionEnd = new Map();
    for (const table of tables.filter(item => item.path === opened.path)) {
      regionEnd.set(table, statementEnd(opened.text, table.line));
    }
    for (const nested of includeDirectives(opened.text)) {
      const nestedFile = await load(nested.path);
      if (!nestedFile) continue;
      const args = Object.assign({}, include.args, nested.args);
      for (const table of tables.filter(item => item.path === opened.path)) {
        const end = regionEnd.get(table);
        if (nested.line < table.line || nested.line > end) continue;
        for (const field of fieldsIn(nestedFile.text, args)) {
          if (!table.fields.some(item => item.name.toLowerCase() === field.name.toLowerCase())) {
            table.fields.push({ name: field.name, path: nestedFile.path, line: field.line, character: field.character });
          }
        }
      }
    }
  }
  for (const buffer of buffersOf(text)) {
    const table = tables.find(item => item.name.toLowerCase() === buffer.table.toLowerCase());
    if (table && !table.buffers.includes(buffer.name)) table.buffers.push(buffer.name);
  }
  return tables;
}

function collectTables(text, defines, path, into) {
  const lines = String(text).split(/\r?\n/);
  walk(parse(text), node => {
    if (node.kind !== 'temptable' && node.kind !== 'dataset') return;
    const expanded = applyDefines(node.name, defines);
    if (node.kind === 'dataset') {
      const owner = into.find(item => item.path === path && Math.abs(item.line - node.line) < 80);
      if (owner && !owner.dataset) {
        owner.dataset = expanded;
        owner.datasetPath = path;
        owner.datasetLine = node.line;
        owner.datasetCharacter = node.nameStart || 0;
      }
      into.push({
        name: expanded,
        path,
        line: node.line,
        character: node.nameStart || 0,
        fields: [],
        buffers: [],
        dataset: expanded,
        datasetPath: path,
        datasetLine: node.line,
        datasetCharacter: node.nameStart || 0
      });
      return;
    }
    into.push({
      name: expanded,
      path,
      line: node.line,
      character: node.nameStart || 0,
      fields: fieldsOfNode(node, lines, path),
      buffers: []
    });
  });
}

function fieldsOfNode(node, lines, path) {
  const fields = [];
  walk(node.children, child => {
    if (child.kind !== 'field') return;
    fields.push({ name: child.name, path, line: child.line, character: child.nameStart || 0 });
  });
  const end = statementEnd(lines.join('\n'), node.line);
  for (let i = node.line; i <= end && i < lines.length; i++) {
    const match = lines[i].match(/^\s*field\s+(\S+)/i);
    if (!match) continue;
    if (fields.some(field => field.line === i && field.name.toLowerCase() === match[1].toLowerCase())) continue;
    fields.push({ name: match[1], path, line: i, character: lines[i].toLowerCase().indexOf(match[1].toLowerCase()) });
  }
  return fields;
}

function fieldsIn(text, defines) {
  const fields = [];
  const lines = String(text).split(/\r?\n/);
  walk(parse(text), node => {
    if (node.kind !== 'field') return;
    fields.push({ name: applyDefines(node.name, defines), line: node.line, character: node.nameStart || 0 });
  });
  if (fields.length) return fields;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*field\s+(\S+)/i);
    if (match) fields.push({ name: applyDefines(match[1], defines), line: i, character: lines[i].toLowerCase().indexOf(match[1].toLowerCase()) });
  }
  return fields;
}

function buffersOf(text) {
  const found = [];
  const re = /\b(?:define|def)\s+buffer\s+([\w-]+)\s+for\s+([\w${}&-]+)/gi;
  for (const line of maskLines(text)) {
    let match;
    while ((match = re.exec(line))) found.push({ name: match[1], table: applyDefines(match[2], {}) });
    re.lastIndex = 0;
  }
  return found;
}

function statementEnd(text, start) {
  const lines = String(text).split(/\r?\n/);
  const state = { inBlock: false, inString: false, quote: '' };
  for (let i = 0; i < start && i < lines.length; i++) stripLine(lines[i], state);
  for (let i = start; i < lines.length; i++) {
    const code = stripLine(lines[i], state);
    if (/\.\s*$/.test(code)) return i;
  }
  return start;
}

function stripLine(line, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];
    if (state.inBlock) {
      const end = line.indexOf('*/', i);
      if (end < 0) return out;
      state.inBlock = false;
      i = end + 2;
      continue;
    }
    if (state.inString) {
      if (ch === state.quote) {
        if (next === state.quote) { i += 2; continue; }
        state.inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { state.inString = true; state.quote = ch; i++; continue; }
    if (ch === '/' && next === '*') { state.inBlock = true; i += 2; continue; }
    if (ch === '/' && next === '/') break;
    out += ch;
    i++;
  }
  return out;
}

function tokensOnLine(line) {
  const tokens = [];
  const re = /[A-Za-z_][\w-]*/g;
  let match;
  while ((match = re.exec(line))) tokens.push({ name: match[0], start: match.index, end: match.index + match[0].length });
  return tokens;
}

function chainAcross(tokens, line, index, operator) {
  const chain = [tokens[index]];
  let cursor = index;
  while (cursor > 0) {
    const between = line.slice(tokens[cursor - 1].end, tokens[cursor].start);
    const pattern = operator === ':' ? /^\s*(?:\(\s*\))?\s*:\s*$/ : /^\s*\.\s*$/;
    if (!pattern.test(between)) break;
    chain.unshift(tokens[cursor - 1]);
    cursor--;
  }
  return chain;
}

function typeFromDetail(detail) {
  const tokens = String(detail || '').split(/\s+/).filter(Boolean);
  const last = tokens.filter(token => !ACCESS.has(token.toLowerCase()) && !PRIMITIVE.has(token.toLowerCase())).pop();
  return last || null;
}

module.exports = {
  collectTargets,
  targetAt,
  landingPosition,
  findSourceFiles,
  safeRelativePath,
  cursorSymbol,
  resolveCursor,
  findAllMembers,
  findMembers,
  classHeaderInfo,
  includeDirectives,
  applyDefines,
  declaredType,
  sourceScore
};

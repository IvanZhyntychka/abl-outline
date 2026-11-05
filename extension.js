'use strict';

const vscode = require('vscode');
const { parse, maskLines } = require('./parser');
const { emptyNames, listIncludes, mergeNames, structuralNames, tokenSpans } = require('./highlight');
const { classHeaderInfo, cursorSymbol, findMembers, findSourceFiles, landingPosition, resolveCursor, safeRelativePath, sourceScore, targetAt } = require('./navigate');

const KINDS = {
  class: vscode.SymbolKind.Class,
  interface: vscode.SymbolKind.Interface,
  enum: vscode.SymbolKind.Enum,
  method: vscode.SymbolKind.Method,
  constructor: vscode.SymbolKind.Constructor,
  destructor: vscode.SymbolKind.Method,
  property: vscode.SymbolKind.Property,
  procedure: vscode.SymbolKind.Function,
  function: vscode.SymbolKind.Function,
  include: vscode.SymbolKind.File,
  temptable: vscode.SymbolKind.Struct,
  dataset: vscode.SymbolKind.Struct,
  field: vscode.SymbolKind.Field,
  index: vscode.SymbolKind.Key
};

const TOKEN_TYPES = [
  'class', 'variable', 'parameter', 'property', 'method', 'function',
  'table', 'field', 'dataset', 'buffer'
];
const LEGEND = new vscode.SemanticTokensLegend(TOKEN_TYPES);
const includeCache = new Map();
const fileCache = new Map();
const CACHE_LIMIT = 200;
const MAX_NAME = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SCAN_FILES = 400;

function activate(context) {
  const selector = { language: 'abl' };
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols(document) {
        return parse(document.getText()).map(node => toSymbol(document, node));
      }
    }),
    vscode.languages.registerDefinitionProvider(selector, {
      async provideDefinition(document, position) {
        const text = document.getText();
        const hit = targetAt(text, position.line, position.character);
        if (hit) {
          const uris = await locate(hit.rel, hit.kind === 'class-simple');
          const locations = [];
          for (const uri of uris) locations.push(await locationFor(uri, hit));
          if (locations.length) return locations.length === 1 ? locations[0] : locations;
        }
        return placesToLocations(document, await resolveCursor(text, position.line, position.character, loadSource));
      }
    }),
    vscode.languages.registerReferenceProvider(selector, {
      provideReferences(document, position, context) {
        return findReferences(document, position, context);
      }
    }),
    vscode.languages.registerImplementationProvider(selector, {
      provideImplementation(document, position) {
        return findImplementations(document, position);
      }
    }),
    vscode.languages.registerDocumentSemanticTokensProvider(selector, {
      async provideDocumentSemanticTokens(document) {
        const extra = await namesFromIncludes(document);
        const builder = new vscode.SemanticTokensBuilder(LEGEND);
        for (const span of tokenSpans(document.getText(), extra)) {
          const type = TOKEN_TYPES.indexOf(span.type);
          if (type >= 0) builder.push(span.line, span.start, span.length, type, 0);
        }
        return builder.build();
      }
    })
  );
}

async function locate(rel, broad) {
  const safe = safeRelativePath(rel);
  if (!safe) return [];
  const key = (broad ? 'broad:' : 'path:') + safe.toLowerCase();
  if (fileCache.has(key)) return fileCache.get(key);
  const glob = '**/' + safe;
  const found = await vscode.workspace.findFiles(glob, '**/{.git,node_modules,tmp}/**', broad ? 8 : 10);
  const suffix = '/' + safe.toLowerCase();
  const exact = found.filter(uri => uri.fsPath.replace(/\\/g, '/').toLowerCase().endsWith(suffix));
  let picks = exact.length ? exact : (broad ? found : []);
  picks.sort((a, b) => sourceScore(a.fsPath) - sourceScore(b.fsPath));
  if (!picks.length) {
    const folders = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
    const external = findSourceFiles(safe, folders);
    if (external.length) picks = [vscode.Uri.file(external[0])];
  }
  remember(fileCache, key, picks);
  return picks;
}

async function locationFor(uri, hit) {
  if (hit.kind === 'include') return new vscode.Location(uri, new vscode.Position(0, 0));
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = new TextDecoder('utf-8').decode(bytes);
  const pos = landingPosition(text, hit.simpleName);
  return new vscode.Location(uri, new vscode.Position(pos.line, pos.character));
}

async function namesFromIncludes(document) {
  const merged = emptyNames();
  const self = document.uri.fsPath.replace(/\\/g, '/').toLowerCase();
  for (const includePath of listIncludes(document.getText())) {
    const key = includePath.toLowerCase();
    if (self.endsWith('/' + key) || self.endsWith(key)) continue;
    mergeNames(merged, await namesForInclude(includePath, key));
  }
  return merged;
}

async function namesForInclude(includePath, key) {
  const safe = safeRelativePath(includePath);
  if (!safe) return emptyNames();
  const open = vscode.workspace.textDocuments.find(doc => {
    const path = doc.uri.fsPath.replace(/\\/g, '/').toLowerCase();
    return path.endsWith('/' + key) || path.endsWith(key);
  });
  if (open) {
    const cached = includeCache.get(key);
    if (cached && cached.version === open.version) return cached.names;
    const names = structuralNames(open.getText());
    remember(includeCache, key, { version: open.version, names });
    return names;
  }

  const cached = includeCache.get(key);
  if (cached) return cached.names;
  const found = await vscode.workspace.findFiles('**/' + safe, '**/{.git,node_modules,tmp}/**', 3);
  let names = emptyNames();
  if (found.length) {
    const bytes = await vscode.workspace.fs.readFile(found[0]);
    names = structuralNames(new TextDecoder('utf-8').decode(bytes));
  }
  remember(includeCache, key, { version: -1, names });
  return names;
}

function toSymbol(document, node) {
  const start = node.line;
  const end = Math.min(document.lineCount - 1, Math.max(node.endLine, start));
  const endChar = document.lineAt(end).text.length;
  const nameEnd = Math.min(document.lineAt(start).text.length, Math.max(node.nameStart, node.nameEnd));
  const symbol = new vscode.DocumentSymbol(
    node.name,
    node.detail || '',
    KINDS[node.kind] || vscode.SymbolKind.Method,
    new vscode.Range(start, 0, end, endChar),
    new vscode.Range(start, node.nameStart, start, nameEnd)
  );
  symbol.children = (node.children || []).map(child => toSymbol(document, child));
  return symbol;
}

async function loadSource(rel) {
  const uris = await locate(rel, false);
  if (!uris.length) return null;
  return { text: await readText(uris[0]), path: uris[0].fsPath, uri: uris[0] };
}

async function readText(uri) {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return new TextDecoder('utf-8').decode(bytes);
}

function placesToLocations(document, places) {
  if (!places || !places.length) return null;
  const locations = places.map(place => new vscode.Location(
    place.path ? vscode.Uri.file(place.path) : document.uri,
    new vscode.Position(place.line, Math.max(0, place.character || 0))
  ));
  return locations.length === 1 ? locations[0] : locations;
}

function symbolNameAt(text, position) {
  const symbol = cursorSymbol(text, position.line, position.character);
  if (symbol && symbol.name) return symbol.name;
  const hit = targetAt(text, position.line, position.character);
  return hit && hit.simpleName ? hit.simpleName : '';
}

async function findReferences(document, position, context) {
  const name = symbolNameAt(document.getText(), position);
  if (!isSafeName(name)) return [];
  const files = await vscode.workspace.findFiles('**/*.{cls,p,i,w,pi}', '**/{.git,node_modules,tmp}/**', MAX_SCAN_FILES);
  const re = new RegExp('(?<![\\w-])' + escapeRegExp(name) + '(?![\\w-])', 'gi');
  const locations = [];
  for (const uri of files) {
    let text = '';
    try {
      if ((await vscode.workspace.fs.stat(uri)).size > MAX_FILE_BYTES) continue;
      text = await readText(uri);
    } catch (error) {
      continue;
    }
    const lines = maskLines(text);
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(lines[i]))) {
        if (!context.includeDeclaration && uri.toString() === document.uri.toString() && i === position.line && match.index === position.character) continue;
        locations.push(new vscode.Location(uri, new vscode.Position(i, match.index)));
        if (locations.length >= 250) return locations;
      }
    }
  }
  return locations;
}

async function findImplementations(document, position) {
  const text = document.getText();
  const symbol = cursorSymbol(text, position.line, position.character);
  if (!symbol || !isSafeName(symbol.name) || symbol.kind === 'field') return null;
  const places = await resolveCursor(text, position.line, position.character, loadSource);
  const locations = [];
  const seen = new Set();
  for (const place of places) {
    const body = place.path ? await readText(vscode.Uri.file(place.path)) : text;
    const header = classHeaderInfo(body);
    const shortName = header.fullName.split('.').pop();
    if (!isSafeName(shortName) || (header.kind !== 'interface' && header.kind !== 'class')) continue;
    const files = await vscode.workspace.findFiles('**/*.cls', '**/{.git,node_modules,tmp}/**', MAX_SCAN_FILES);
    const typeRe = new RegExp('\\b(?:implements|inherits)\\s+[^\\n:]*\\b' + escapeRegExp(shortName) + '\\b', 'i');
    for (const uri of files) {
      let source = '';
      try {
        if ((await vscode.workspace.fs.stat(uri)).size > MAX_FILE_BYTES) continue;
        source = await readText(uri);
      } catch (error) {
        continue;
      }
      if (!typeRe.test(source)) continue;
      for (const member of findMembers(source, symbol.name)) {
        const key = uri.fsPath + ':' + member.line;
        if (seen.has(key)) continue;
        seen.add(key);
        locations.push(new vscode.Location(uri, new vscode.Position(member.line, member.character)));
      }
    }
  }
  return locations.length ? locations : null;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSafeName(name) {
  return typeof name === 'string' && name.length >= 2 && name.length <= MAX_NAME && /^[\w.-]+$/.test(name);
}

function remember(map, key, value) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_LIMIT) map.delete(map.keys().next().value);
}

function deactivate() {}

module.exports = { activate, deactivate };

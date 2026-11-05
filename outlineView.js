'use strict';

const vscode = require('vscode');
const { parse, sortOutline } = require('./parser');

const THEME_ICONS = {
  class: 'symbol-class',
  interface: 'symbol-interface',
  enum: 'symbol-enum',
  method: 'symbol-method',
  constructor: 'symbol-constructor',
  destructor: 'symbol-method',
  property: 'symbol-property',
  procedure: 'symbol-function',
  function: 'symbol-function',
  include: 'file',
  field: 'symbol-field',
  index: 'symbol-key'
};

const KIND_LABEL = {
  class: 'class',
  interface: 'interface',
  enum: 'enum',
  constructor: 'constructor',
  destructor: 'destructor',
  procedure: 'procedure',
  temptable: 'temp-table',
  dataset: 'dataset',
  index: 'index'
};

class OutlineProvider {
  constructor(icons) {
    this.icons = icons;
    this.document = undefined;
    this.version = -1;
    this.nodes = [];
    this.view = undefined;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
  }

  bind(view) {
    this.view = view;
  }

  show(document) {
    if (!document || document.languageId !== 'abl' || document.isClosed) return;
    const same = this.document
      && this.document.uri.toString() === document.uri.toString()
      && this.version === document.version;
    if (same) return;
    this.document = document;
    this.version = document.version;
    this.nodes = sortOutline(parse(document.getText()));
    if (this.view) this.view.description = document.fileName.split(/[/\\]/).pop();
    vscode.commands.executeCommand('setContext', 'ablOutline.hasDocument', true);
    this._onDidChange.fire();
  }

  clear() {
    if (!this.document && !this.nodes.length) return;
    this.document = undefined;
    this.version = -1;
    this.nodes = [];
    if (this.view) this.view.description = '';
    vscode.commands.executeCommand('setContext', 'ablOutline.hasDocument', false);
    this._onDidChange.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (!this.document) return [];
    const nodes = element ? element.node.children : this.nodes;
    return (nodes || []).map(node => new OutlineNode(node, this.document, this.icons));
  }
}

class OutlineNode extends vscode.TreeItem {
  constructor(node, document, icons) {
    const hasChildren = node.children && node.children.length;
    super(node.name, hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.node = node;
    this.id = document.uri.toString() + ':' + node.kind + ':' + node.line + ':' + node.nameStart + ':' + node.name;
    this.contextValue = node.kind;
    this.iconPath = iconFor(node, icons);
    this.description = descriptionFor(node);
    this.tooltip = tooltipFor(node);
    this.command = {
      command: 'abl.outline.reveal',
      title: 'Reveal',
      arguments: [document.uri, node.line, node.nameStart || 0]
    };
  }
}

function iconFor(node, icons) {
  if (node.kind === 'temptable') return icons.temptable;
  if (node.kind === 'dataset') return icons.dataset;
  const id = THEME_ICONS[node.kind] || 'symbol-misc';
  if (node.kind === 'method' && isPrivateMethod(node)) {
    return new vscode.ThemeIcon(id, new vscode.ThemeColor('abl.privateMethod'));
  }
  return new vscode.ThemeIcon(id);
}

function isPrivateMethod(node) {
  return /(?:^|\s)private(?:\s|$)/i.test(node.detail || '');
}

function descriptionFor(node) {
  const detail = (node.detail || '').trim();
  if (!detail || detail.toLowerCase() === KIND_LABEL[node.kind]) return undefined;
  return detail;
}

function tooltipFor(node) {
  const detail = (node.detail || '').trim();
  const kind = KIND_LABEL[node.kind] || node.kind;
  return detail && detail.toLowerCase() !== kind ? node.name + ' — ' + detail : node.name + ' — ' + kind;
}

function iconPair(root, name) {
  return {
    light: vscode.Uri.joinPath(root, 'icons', name + '-light.svg'),
    dark: vscode.Uri.joinPath(root, 'icons', name + '-dark.svg')
  };
}

function registerOutline(context) {
  const icons = {
    temptable: iconPair(context.extensionUri, 'temptable'),
    dataset: iconPair(context.extensionUri, 'dataset')
  };
  const provider = new OutlineProvider(icons);
  const view = vscode.window.createTreeView('abl.outline', {
    treeDataProvider: provider,
    showCollapseAll: true
  });
  provider.bind(view);

  const pending = { id: null };
  let token = 0;

  async function sync() {
    const current = ++token;
    const next = await selectedDocument(provider);
    if (current !== token) return;
    if (next === undefined) return;
    if (next) provider.show(next);
    else provider.clear();
  }

  function schedule(document) {
    clearTimeout(pending.id);
    pending.id = setTimeout(() => {
      if (document && provider.document && document.uri.toString() === provider.document.uri.toString()) {
        provider.show(document);
      }
    }, 200);
  }

  context.subscriptions.push(
    view,
    provider._onDidChange,
    { dispose() { clearTimeout(pending.id); } },
    vscode.commands.registerCommand('abl.outline.reveal', revealSymbol),
    vscode.window.onDidChangeActiveTextEditor(() => sync()),
    vscode.window.onDidChangeVisibleTextEditors(() => sync()),
    vscode.window.tabGroups.onDidChangeTabs(() => sync()),
    vscode.workspace.onDidChangeTextDocument(event => schedule(event.document)),
    vscode.workspace.onDidCloseTextDocument(document => {
      if (provider.document && document.uri.toString() === provider.document.uri.toString()) {
        provider.clear();
        sync();
      }
    })
  );
  vscode.commands.executeCommand('setContext', 'ablOutline.hasDocument', false);
  sync();
}

async function selectedDocument(provider) {
  const active = vscode.window.activeTextEditor;
  if (active) return active.document.languageId === 'abl' ? active.document : null;

  const tab = vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.activeTab;
  if (tab && tab.input instanceof vscode.TabInputText) {
    try {
      const doc = await vscode.workspace.openTextDocument(tab.input.uri);
      return doc.languageId === 'abl' ? doc : null;
    } catch (error) {
      return undefined;
    }
  }

  const visible = vscode.window.visibleTextEditors.find(editor => editor.document.languageId === 'abl' && !editor.document.isClosed);
  if (visible) return visible.document;
  if (provider.document && !provider.document.isClosed) return undefined;
  return null;
}

async function revealSymbol(uri, line, character) {
  const document = await vscode.workspace.openTextDocument(uri);
  const position = new vscode.Position(Math.max(0, line || 0), Math.max(0, character || 0));
  await vscode.window.showTextDocument(document, {
    selection: new vscode.Range(position, position),
    preserveFocus: false
  });
}

module.exports = { registerOutline, isPrivateMethod };

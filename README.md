# ABL Outline

A local Cursor and VS Code extension for OpenEdge ABL. It highlights `.cls`, `.p`, `.w`, `.i`, and `.pi` files, builds an outline of the current file, and jumps to class and include definitions.

## What it does

**Outline** (`Ctrl+Shift+O`) lists classes, interfaces, enums, methods, constructors, destructors, properties, procedures, functions, temp-tables, datasets, fields, indexes, and includes.

**ABL Outline** in the Explorer shows that list for the selected file and keeps it when the editor is not focused. Siblings are sorted by name. Temp-tables and datasets use small table icons. A private method uses a dimmer method icon.

**Highlighting** colors the file directly. On a dark theme keywords are orange, strings are green, numbers are blue, line comments are gray, and block comments are green. Classes are bold, methods are gold, fields and properties are purple, temp-tables are blue, and datasets are olive. On a light theme keywords are navy, strings are green, numbers are blue, comments are gray, and fields are purple. Names brought in by included files are colored too.

**Go to Definition** (`F12`, `Ctrl+click`, `Ctrl+Shift+R`, or `Alt+F12` to peek) works for:

- an include in braces, such as `{com/qad/distribution/orders/dsDistOrderLine.i}`
- a fully qualified class name, such as `com.qad.distribution.orders.DistOrderLineBE`
- a short name imported with `using`
- a type after `new`, `inherits`, `implements`, or `as`
- `this-object:Method`, `super:Method`, and `ClassName:Method`, including methods declared with `&METHOD-NAME`
- a property or variable used as the receiver, then the member called on its type
- `table.field`, including a temp-table brought in with `&PREFIX`
- `run procedure` in the same procedure file

`Alt+F7` finds references. `Ctrl+Alt+B` jumps to an implementation in a class that inherits or implements the resolved type. `Alt+Left` goes back.

The extension looks in the open workspace first. If the file is not there, it searches the workspace folder and the directories next to it, using the `src/api`, `src/impl`, and `src` layouts. Paths with `..` or wildcard characters are ignored. Sources under `src/api` and `src/impl` are preferred over test and temporary copies.

## Install in VS Code

The package is `vsix/abl-outline-1.1.0.vsix`.

1. Open the Extensions view with `Ctrl+Shift+X`.
2. Open the `...` menu at the top of that view and choose **Install from VSIX...**.
3. Select `vsix/abl-outline-1.1.0.vsix`.
4. Run **Developer: Reload Window**.

From a terminal, in the repository folder:

```powershell
code --install-extension .\vsix\abl-outline-1.1.0.vsix
```

In Cursor, use the same VSIX command with `cursor` instead of `code`:

```powershell
cursor --install-extension .\vsix\abl-outline-1.1.0.vsix
```

After changing the extension source, pack it again and reinstall:

```powershell
npx @vscode/vsce package --allow-missing-repository --skip-license -o vsix/abl-outline-1.1.0.vsix
```

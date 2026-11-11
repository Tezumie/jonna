// The `vscode` shim's tree views, webview panels and terminals (D256): VS Code's TreeDataProvider
// on the IDE's tree views (rows keep the extension's elements, so menus get them back), webview
// panels with VS Code's page API (`acquireVsCodeApi`, plain messages) bridged onto the IDE's, and
// terminals (shells and pseudoterminals). DOM-free and unit-tested.

import { INITIAL_STATE_SLOT, INITIAL_THEME_SLOT, STATE_KEY_SLOT } from "../../themes/webviewVars";
import type { TreeItem as IdeTreeItem, WorkerApi } from "../rpc";
import type { ShimCommands } from "./commands";
import { markdownOf, pathOf } from "./convert";
import type { Command, TreeItem } from "./languageTypes";
import { createTerminals } from "./terminals";
import {
  Disposable,
  type Event,
  EventEmitter,
  eventOf,
  NONE_TOKEN,
  ThemeIcon,
  Uri,
  ViewColumn,
} from "./types";

export { splitCommandLine, toIdePty, type VsPseudoterminal } from "./terminals";

type TreeDataProvider = {
  getChildren(
    element?: unknown,
  ): unknown[] | null | undefined | Promise<unknown[] | null | undefined>;
  getTreeItem(element: unknown): TreeItem | Promise<TreeItem>;
  getParent?(element: unknown): unknown;
  resolveTreeItem?(item: TreeItem, element: unknown, token: unknown): TreeItem | Promise<TreeItem>;
  onDidChangeTreeData?: Event<unknown>;
};

const MAX_ROWS = 20_000;
/** resolveTreeItem: rows asked per listing, and how long each may take. */
const RESOLVE_ROWS = 50;
const RESOLVE_MS = 300;

/** A tree row's icon: VS Code's ThemeIcon id (the IDE's set follows the same names). */
function iconOf(item: TreeItem): string | undefined {
  const icon = item.iconPath;
  if (
    icon instanceof ThemeIcon ||
    (icon && typeof icon === "object" && typeof (icon as unknown as ThemeIcon).id === "string")
  )
    return (icon as unknown as ThemeIcon).id;
  return undefined;
}

/** An image file as a row's icon (D258): a path, a Uri, or `{ light, dark }`. */
function iconFiles(item: TreeItem): { iconPath?: string; iconPathDark?: string } {
  const icon = item.iconPath as unknown;
  const path = (v: unknown) =>
    typeof v === "string" ? v : Uri.isUri(v) && v.scheme === "file" ? v.fsPath : undefined;
  if (typeof icon === "string" || Uri.isUri(icon)) {
    const p = path(icon);
    return p ? { iconPath: p } : {};
  }
  if (icon && typeof icon === "object" && ("light" in icon || "dark" in icon)) {
    const { light, dark } = icon as { light?: unknown; dark?: unknown };
    const l = path(light);
    const d = path(dark);
    return { ...(l && { iconPath: l }), ...(d && { iconPathDark: d }) };
  }
  return {};
}

function labelOf(item: TreeItem): string {
  if (typeof item.label === "string") return item.label;
  if (item.label && typeof item.label === "object") return item.label.label;
  if (item.resourceUri) return item.resourceUri.path.split("/").pop() ?? "";
  return "";
}

export function createViews(
  ide: WorkerApi,
  commands: ShimCommands,
  extensionPath: string,
  unsupported: (name: string) => void,
) {
  /** Each view's rows: the IDE's id → the extension's element. */
  const trees = new Map<string, Map<string, unknown>>();
  /** The selection of views made with canSelectMany (their menus' second argument). */
  const selections = new Map<string, () => readonly unknown[]>();
  commands.treeArgument = (item) =>
    trees.get(String(item.view ?? ""))?.get(String(item.id ?? "")) ?? item;
  // VS Code's: with canSelectMany a row's command gets the selected elements too (the clicked
  // one alone when it isn't among them).
  commands.treeSelection = (item, element) => {
    const selected = selections.get(String(item.view ?? ""))?.();
    if (!selected) return undefined;
    return selected.includes(element) ? [...selected] : [element];
  };

  const createTreeView = (
    viewId: string,
    options: {
      treeDataProvider: TreeDataProvider;
      showCollapseAll?: boolean;
      canSelectMany?: boolean;
      dragAndDropController?: unknown;
    },
  ) => {
    const provider = options.treeDataProvider;
    const elements = new Map<string, unknown>();
    trees.set(viewId, elements);
    const ids = new WeakMap<object, string>();
    const onDidChangeSelection = new EventEmitter<{ selection: readonly unknown[] }>();
    const onDidChangeVisibility = new EventEmitter<{ visible: boolean }>();
    const onDidExpandElement = new EventEmitter<{ element: unknown }>();
    const onDidCollapseElement = new EventEmitter<{ element: unknown }>();
    const onDidChangeCheckboxState = new EventEmitter<{ items: readonly [unknown, number][] }>();

    const rowOf = async (
      element: unknown,
      parentId: string,
      index: number,
      taken: Set<string>,
    ): Promise<IdeTreeItem> => {
      const item = await provider.getTreeItem(element);
      const label = labelOf(item);
      const known = element && typeof element === "object" ? ids.get(element) : undefined;
      let id = item.id ?? known ?? `${parentId}/${label || index}`;
      for (let n = 2; taken.has(id); n++) id = `${item.id ?? `${parentId}/${label || index}`}~${n}`;
      taken.add(id);
      if (element && typeof element === "object") ids.set(element, id);
      if (elements.size < MAX_ROWS) elements.set(id, element);
      const command = commands.ref(item.command as Command | undefined);
      // A tooltip the provider fills in on demand (resolveTreeItem, VS Code's on hover): asked
      // now for the first rows, briefly (the IDE's rows carry their tooltip).
      if (item.tooltip === undefined && provider.resolveTreeItem && resolveBudget.left > 0) {
        resolveBudget.left--;
        const resolved = await Promise.race([
          Promise.resolve(provider.resolveTreeItem(item, element, NONE_TOKEN)).catch(
            () => undefined,
          ),
          new Promise<undefined>((r) => setTimeout(r, RESOLVE_MS)),
        ]);
        if (resolved?.tooltip !== undefined) item.tooltip = resolved.tooltip;
      }
      const tooltip = markdownOf(item.tooltip);
      const files = iconFiles(item);
      // A row for a file without an icon of its own: the file or folder icon (VS Code's).
      const icon =
        iconOf(item) ??
        (!files.iconPath && !files.iconPathDark && item.resourceUri
          ? (item.collapsibleState ?? 0) > 0
            ? "folder"
            : "file"
          : undefined);
      const checkbox =
        typeof item.checkboxState === "object" ? item.checkboxState.state : item.checkboxState;
      const description =
        typeof item.description === "string"
          ? item.description
          : item.description === true && item.resourceUri
            ? pathOf(item.resourceUri)
            : undefined;
      return {
        id,
        label,
        ...(description && { description }),
        ...(tooltip && { tooltip }),
        ...(icon && { icon }),
        ...files,
        ...((item.collapsibleState ?? 0) > 0 && { collapsible: true }),
        ...(command && {
          command: {
            id: command.command,
            ...(command.input !== undefined && { input: command.input }),
          },
        }),
        ...(item.contextValue && { contextValue: item.contextValue }),
        ...(checkbox !== undefined && { checkboxState: checkbox === 1 ? 1 : 0 }),
      };
    };

    /** Rows whose tooltip resolveTreeItem may fill, per listing. */
    const resolveBudget = { left: 0 };
    const handle = ide.ui.registerTreeView(viewId, {
      getChildren: async (parent) => {
        const parentElement = parent ? elements.get(parent.id) : undefined;
        if (parent && parentElement === undefined) return [];
        resolveBudget.left = RESOLVE_ROWS;
        const children = (await provider.getChildren(parent ? parentElement : undefined)) ?? [];
        const taken = new Set<string>();
        const rows: IdeTreeItem[] = [];
        for (const [i, child] of children.entries())
          rows.push(await rowOf(child, parent?.id ?? viewId, i, taken));
        return rows;
      },
      onDidChangeCheckboxState: (changes) =>
        onDidChangeCheckboxState.fire({
          items: changes.map(
            (c) => [elements.get(c.item.id), c.checked ? 1 : 0] as [unknown, number],
          ),
        }),
    });
    const subscription = provider.onDidChangeTreeData?.(() => handle.refresh());
    let message: string | undefined;
    let title: string | undefined;
    let description: string | undefined;
    let badge: { value: number; tooltip?: string } | undefined;
    let selection: readonly unknown[] = [];
    handle.onDidChangeSelection((items) => {
      selection = items.map((i) => elements.get(i.id)).filter((e) => e !== undefined);
      onDidChangeSelection.fire({ selection });
    });
    if (options.canSelectMany) selections.set(viewId, () => selection);
    // The user expanding or collapsing a row (not a refresh loading its children).
    handle.onDidChangeExpansion((item, expanded) => {
      const element = elements.get(item.id);
      if (element === undefined) return;
      (expanded ? onDidExpandElement : onDidCollapseElement).fire({ element });
    });
    let visible = false;
    const watching = ide.ui.watchView(viewId, (now) => {
      if (now === visible) return;
      visible = now;
      onDidChangeVisibility.fire({ visible });
    });
    void watching.visible.then((now) => {
      if (now === visible) return;
      visible = now;
      onDidChangeVisibility.fire({ visible });
    });
    /** An element's row id; its siblings are listed (as the IDE would) when it isn't known yet. */
    const idOf = async (element: unknown, parent: unknown, parentId: string) => {
      const known = (e: unknown) =>
        e && typeof e === "object" ? ids.get(e) : [...elements].find(([, v]) => v === e)?.[0];
      const id = known(element);
      if (id) return id;
      const kids = (await provider.getChildren(parent)) ?? [];
      const taken = new Set<string>();
      for (const [i, kid] of kids.entries()) await rowOf(kid, parentId, i, taken);
      return known(element);
    };
    return {
      get visible() {
        return visible;
      },
      get selection(): readonly unknown[] {
        return selection;
      },
      get message() {
        return message;
      },
      set message(v: string | undefined) {
        message = v;
        handle.setMessage(v ?? "");
      },
      // The view's header shows them in place of its manifest title (VS Code's).
      get title() {
        return title;
      },
      set title(v: string | undefined) {
        title = typeof v === "string" ? v : undefined;
        ide.ui.setViewTitle(viewId, { title, description });
      },
      get description() {
        return description;
      },
      set description(v: string | undefined) {
        description = typeof v === "string" ? v : undefined;
        ide.ui.setViewTitle(viewId, { title, description });
      },
      // A number on the view's activity bar icon (VS Code's ViewBadge).
      get badge() {
        return badge;
      },
      set badge(v: { value: number; tooltip?: string } | undefined) {
        badge = v;
        handle.setBadge(v && typeof v.value === "number" ? v : undefined);
      },
      onDidChangeSelection: onDidChangeSelection.event,
      onDidChangeVisibility: onDidChangeVisibility.event,
      onDidExpandElement: onDidExpandElement.event,
      onDidCollapseElement: onDidCollapseElement.event,
      onDidChangeCheckboxState: onDidChangeCheckboxState.event,
      /** VS Code's reveal (D258): the element's parents come from the provider's getParent. */
      reveal: async (
        element: unknown,
        options: { select?: boolean; focus?: boolean; expand?: boolean | number } = {},
      ) => {
        if (!provider.getParent) {
          unsupported("TreeView.reveal without getParent");
          return;
        }
        const chain = [element];
        for (let p = await provider.getParent(element); p !== undefined && p !== null; ) {
          chain.unshift(p);
          if (chain.length > 50) break;
          p = await provider.getParent(p);
        }
        const path: string[] = [];
        let parent: unknown;
        let parentId = viewId;
        for (const el of chain) {
          const id = await idOf(el, parent, parentId);
          if (!id) return;
          path.push(id);
          parent = el;
          parentId = id;
        }
        await handle.reveal(path, {
          select: options.select !== false,
          focus: options.focus === true,
          expand: !!options.expand,
        });
      },
      dispose: () => {
        subscription?.dispose();
        watching.dispose();
        if (badge) handle.setBadge(undefined);
        handle.dispose();
        trees.delete(viewId);
        selections.delete(viewId);
      },
    };
  };

  type PanelOptions = {
    enableScripts?: boolean;
    retainContextWhenHidden?: boolean;
    localResourceRoots?: readonly Uri[];
  };
  type IdePanel = ReturnType<WorkerApi["ui"]["createWebviewPanel"]>;

  const createWebviewPanel = (
    viewType: string,
    title: string,
    showOptions: ViewColumn | { viewColumn: ViewColumn; preserveFocus?: boolean },
    options?: PanelOptions,
  ) => {
    const column = typeof showOptions === "object" ? showOptions.viewColumn : showOptions;
    const panel = ide.ui.createWebviewPanel(
      viewType,
      title,
      {
        // Beside, Active (the main group) or a column by number (that editor group).
        viewColumn:
          column === ViewColumn.Beside
            ? "beside"
            : typeof column === "number" && column >= 1
              ? column
              : "main",
        ...(typeof showOptions === "object" &&
          showOptions.preserveFocus && { preserveFocus: true }),
      },
      {
        enableScripts: options?.enableScripts ?? false,
        retainContextWhenHidden: true,
        // Folders its page may read besides the extension's and the workspace's.
        ...(options?.localResourceRoots && {
          localResourceRoots: options.localResourceRoots.map((u) => pathOf(u)),
        }),
      },
    );
    return wrapPanel(panel, viewType, options);
  };

  /** VS Code's WebviewPanel over the IDE's (a new one, or one restored by its serializer). */
  const wrapPanel = (panel: IdePanel, viewType: string, options?: PanelOptions) => {
    let html = "";
    const onDidDispose = new EventEmitter<void>();
    const onDidChangeViewState = new EventEmitter<{ webviewPanel: unknown }>();
    const webview = {
      get html() {
        return html;
      },
      set html(value: string) {
        html = value;
        panel.webview.html = withVscodeBridge(value);
      },
      options: options ?? {},
      cspSource: panel.webview.cspSource,
      postMessage: (message: unknown) => panel.webview.postMessage(message),
      // `disposables` too: the panel's own list (VS Code's webview sample) disposes it.
      onDidReceiveMessage: eventOf<unknown>((listener) =>
        panel.webview.onDidReceiveMessage(listener),
      ),
      asWebviewUri: (uri: Uri) => safeWebviewUri(uri, (path) => panel.webview.asWebviewUri(path)),
    };
    let iconPath: unknown;
    const shim = {
      viewType,
      get title() {
        return panel.title;
      },
      set title(v: string) {
        panel.title = v;
      },
      // Its tab's icon (D263): a file of the extension, or a light / dark pair (the dark one).
      get iconPath(): unknown {
        return iconPath;
      },
      set iconPath(value: unknown) {
        iconPath = value;
        const pick = (v: unknown) => (Uri.isUri(v) ? pathOf(v) : undefined);
        const file =
          pick(value) ??
          pick((value as { dark?: unknown } | undefined)?.dark) ??
          pick((value as { light?: unknown } | undefined)?.light);
        panel.iconPath = file;
      },
      webview,
      options: options ?? {},
      get visible() {
        return panel.visible;
      },
      get active() {
        return panel.active;
      },
      // Its editor group (1 until the host has said, as VS Code's for a new panel).
      get viewColumn() {
        return panel.viewColumn ?? ViewColumn.One;
      },
      reveal: (viewColumn?: ViewColumn, preserveFocus?: boolean) =>
        panel.reveal(viewColumn === ViewColumn.Beside ? "beside" : undefined, preserveFocus),
      onDidDispose: onDidDispose.event,
      onDidChangeViewState: onDidChangeViewState.event,
      dispose: () => panel.dispose(),
    };
    panel.onDidDispose(() => onDidDispose.fire());
    panel.onDidChangeViewState(() => onDidChangeViewState.fire({ webviewPanel: shim }));
    return shim;
  };

  const terminals = createTerminals(ide, unsupported);

  return {
    createTreeView,
    registerTreeDataProvider: (viewId: string, treeDataProvider: TreeDataProvider) => {
      const view = createTreeView(viewId, { treeDataProvider });
      return new Disposable(() => view.dispose());
    },
    createWebviewPanel,
    /**
     * VS Code's registerWebviewPanelSerializer: its panels of `viewType` open after a restart
     * with the state their page last saved (`acquireVsCodeApi().setState`), and
     * deserializeWebviewPanel fills them.
     */
    registerWebviewPanelSerializer: (
      viewType: string,
      serializer: { deserializeWebviewPanel(panel: unknown, state: unknown): unknown },
    ) => {
      const registration = ide.ui.registerWebviewPanelSerializer(viewType, {
        deserialize: (panel, state) =>
          serializer.deserializeWebviewPanel(
            wrapPanel(panel, viewType, { enableScripts: true }),
            state,
          ),
      });
      return new Disposable(() => registration.dispose());
    },
    get terminals() {
      return terminals.terminals;
    },
    get activeTerminal() {
      return terminals.activeTerminal;
    },
    createTerminal: terminals.createTerminal,
    onDidOpenTerminal: terminals.onDidOpenTerminal,
    onDidCloseTerminal: terminals.onDidCloseTerminal,
    onDidChangeActiveTerminal: terminals.onDidChangeActiveTerminal,
    onDidChangeTerminalState: terminals.onDidChangeTerminalState,
    onDidChangeTerminalShellIntegration: terminals.onDidChangeTerminalShellIntegration,
    onDidStartTerminalShellExecution: terminals.onDidStartTerminalShellExecution,
    onDidEndTerminalShellExecution: terminals.onDidEndTerminalShellExecution,
    extensionPath,
  };
}

/**
 * VS Code's asWebviewUri, which never throws: a file of the extension, of a workspace folder or of
 * a declared local resource root as the page addresses it; anything else is returned as it is
 * (the page can't load it, as VS Code's wouldn't outside its localResourceRoots).
 */
export function safeWebviewUri(uri: Uri, address: (path: string) => string): Uri {
  try {
    return webviewUriOf(address(pathOf(uri)));
  } catch {
    return uri;
  }
}

/** A page address the IDE gave, as VS Code's Uri-like value (it prints as that address). */
export function webviewUriOf(address: string): Uri {
  const uri = Uri.from({ scheme: "", path: address });
  return Object.assign(Object.create(uri) as Uri, {
    toString: () => address,
    toJSON: () => address,
  });
}

/**
 * VS Code's own defaults for a webview's page (its body's font and colors, links, code, quotes,
 * keys), in a cascade layer so the page's rules win. Added through CSSOM, which a page's CSP
 * doesn't block.
 */
const WEBVIEW_DEFAULTS =
  "@layer vscode-defaults{body{background-color:transparent;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-weight:var(--vscode-font-weight);font-size:var(--vscode-font-size);margin:0;padding:0 20px}img,video{max-width:100%;max-height:100%}a,a code{color:var(--vscode-textLink-foreground)}a:hover{color:var(--vscode-textLink-activeForeground)}code{color:var(--vscode-textPreformat-foreground);background-color:var(--vscode-textPreformat-background);padding:1px 3px;border-radius:4px}pre code{padding:0;background-color:transparent}blockquote{background:var(--vscode-textBlockQuote-background);border-color:var(--vscode-textBlockQuote-border)}kbd{background-color:var(--vscode-keybindingLabel-background);color:var(--vscode-keybindingLabel-foreground);border:1px solid var(--vscode-keybindingLabel-border);border-bottom-color:var(--vscode-keybindingLabel-bottomBorder);border-radius:3px;padding:1px 4px;vertical-align:middle}}";

/**
 * VS Code's page side on the IDE's: `acquireVsCodeApi()` (postMessage, getState, setState: the
 * state is also sent to the IDE, which keeps a panel's across restarts), and
 * the IDE's `{ ns, message }` messages delivered to the page as VS Code delivers them (the
 * message itself as `event.data`). Put first in the page, with its CSP nonce when it has one.
 * The theme (D260): VS Code's `--vscode-*` variables, `color-scheme`, its body class
 * ("vscode-dark") and default styles, from the first line (the IDE fills INITIAL_THEME_SLOT when
 * it serves the page) and again on every theme message. The IDE's own design tokens too
 * (`--bg-surface`, `--fg-muted`, `--radius-sm`…, D420): VS Code's variables have no radius,
 * shadow or type scale, so a page written for this IDE can look like it and still fall back to
 * VS Code's in VS Code (`var(--bg-surface, var(--vscode-sideBar-background))`).
 */
export function withVscodeBridge(html: string, options: { editorKeys?: boolean } = {}): string {
  const nonce = /nonce-([A-Za-z0-9+/=_-]+)/.exec(html)?.[1];
  const script = `<script${nonce ? ` nonce="${nonce}"` : ""}>(function(){
var NS="ide-webview",KEY=${STATE_KEY_SLOT},state;try{state=JSON.parse(sessionStorage.getItem(KEY)||"null")||undefined}catch(e){}if(state===undefined)state=${INITIAL_STATE_SLOT};
var api={postMessage:function(m){parent.postMessage({ns:NS,message:m},"*")},getState:function(){return state},setState:function(s){state=s;try{sessionStorage.setItem(KEY,JSON.stringify(s))}catch(e){}try{parent.postMessage({ns:NS,state:s},"*")}catch(e){}return s}};
var taken=false;window.acquireVsCodeApi=function(){if(taken)throw new Error("An instance of the VS Code API has already been acquired");taken=true;return api};
var kind="vscode-dark",KINDS=["vscode-dark","vscode-light","vscode-high-contrast","vscode-high-contrast-light"];
function mark(){var b=document.body;if(!b)return;b.classList.remove.apply(b.classList,KINDS);b.classList.add(kind);b.setAttribute("data-vscode-theme-kind",kind)}
function apply(t){if(!t||typeof t!=="object")return;var s=document.documentElement.style,v=t.vscode||{},w=t.vars||{};for(var k in v)if(k.indexOf("--vscode-")===0&&typeof v[k]==="string")s.setProperty(k,v[k]);for(var j in w)if(j.indexOf("--")===0&&j.indexOf("--vscode-")!==0&&typeof w[j]==="string")s.setProperty(j,w[j]);if(KINDS.indexOf(t.vscodeClass)>=0)kind=t.vscodeClass;s.setProperty("color-scheme",/light/.test(kind)?"light":"dark");mark()}
apply(${INITIAL_THEME_SLOT});
try{var sheet=new CSSStyleSheet();sheet.replaceSync(${JSON.stringify(WEBVIEW_DEFAULTS)});document.adoptedStyleSheets=[sheet].concat(document.adoptedStyleSheets)}catch(e){}
document.addEventListener("DOMContentLoaded",mark);
window.addEventListener("message",function(e){var d=e.data;if(!d||d.ns!==NS||e.source!==parent)return;e.stopImmediatePropagation();
if(d.theme)apply(d.theme);
if("message" in d)window.dispatchEvent(new MessageEvent("message",{data:d.message}))},true);
${
  options.editorKeys
    ? 'document.addEventListener("keydown",function(e){if(!(e.ctrlKey||e.metaKey)||e.altKey)return;var k=e.key.toLowerCase(),c=k==="s"?"save":k==="z"&&!e.shiftKey?"undo":k==="y"||(k==="z"&&e.shiftKey)?"redo":"";if(!c)return;e.preventDefault();parent.postMessage({ns:NS,message:{__ide:c}},"*")},true);'
    : ""
}})();</script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head)
    return (
      html.slice(0, head.index + head[0].length) + script + html.slice(head.index + head[0].length)
    );
  return script + html;
}

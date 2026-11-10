// The disassembly view (D229), a dock tab like VS Code's: the paused frame's instructions
// (address, bytes, instruction, symbol and source line), the current one marked, more loaded as
// it scrolls to either end (disassemblyModel.ts), a breakpoint glyph per row (instruction
// breakpoints, DAP `setInstructionBreakpoints`), and while it has the focus F10 / F11 / Shift+F11
// step one instruction (`instructionStepping`, VS Code's `disassemblyViewFocus`). It follows the
// focused session's selected frame. Every action is a command.
import { h, on, replaceChildren } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect, type Signal, signal } from "../../core/reactive/index";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import type { DebugController } from "./controller";
import { DisassemblyModel, instructionLine, rowOf } from "./disassemblyModel";
import { sameAddress } from "./otherBreakpoints";

/** What the open view shows (ide://debug `disassembly`), null when it's closed. */
export interface DisassemblyState {
  at: string | null;
  rows: number;
  first: string | null;
  last: string | null;
  /** The lines around the current instruction. */
  around: string[];
}

export const disassemblyState: Signal<DisassemblyState | null> = signal(null);

export function disassemblyDescriptor(
  services: WorkbenchServices,
  debug: DebugController,
): DockViewDescriptor {
  return {
    type: "disassembly",
    title: () => "Disassembly",
    icon: () => "cpu",
    singleton: true,
    defaultPlacement: "main",
    create: () => new DisassemblyView(services, debug),
  };
}

/** The paused frame's instruction address in the focused session, if it has one. */
export function currentInstruction(debug: DebugController): string | null {
  const rs = debug.focused.peek();
  if (!rs || rs.state.peek() !== "stopped") return null;
  return rs.frames.peek()[rs.frameIndex.peek()]?.instructionPointerReference ?? null;
}

class DisassemblyView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly list: HTMLElement;
  private readonly note: HTMLElement;
  private model: DisassemblyModel | null = null;
  private sessionId: string | null = null;
  /** Bumped per open: an older open's answer is dropped. */
  private generation = 0;

  constructor(
    services: WorkbenchServices,
    private readonly debug: DebugController,
  ) {
    this.note = h("div", { class: "disasm-note" });
    this.list = h("div", {
      class: "disasm-list",
      role: "list",
      "aria-label": "Instructions",
    });
    this.element = h("div", { class: "disasm", tabindex: "-1" }, this.note, this.list);
    // Steps go by instruction while the view has the focus (VS Code's disassemblyViewFocus).
    this.store.add(on(this.element, "focusin", () => (debug.instructionStepping.value = true)));
    this.store.add(
      on(this.element, "focusout", (e) => {
        if (!this.element.contains(e.relatedTarget as Node | null))
          debug.instructionStepping.value = false;
      }),
    );
    this.store.add({ dispose: () => (debug.instructionStepping.value = false) });
    this.store.add(on(this.list, "scroll", () => void this.onScroll()));
    this.store.add(
      on(this.list, "click", (e) => {
        const glyph = (e.target as HTMLElement).closest<HTMLElement>(".disasm-bp");
        const address = glyph?.closest<HTMLElement>(".disasm-row")?.dataset.address;
        if (!address) return;
        void services.dispatcher
          .execute("debug.toggleInstructionBreakpoint", { address })
          .catch((err: unknown) =>
            services.notifications.show("error", err instanceof Error ? err.message : String(err)),
          );
      }),
    );
    // The focused session's paused frame.
    this.store.add(
      effect(() => {
        const rs = debug.focused.value;
        rs?.state.value;
        rs?.frames.value;
        rs?.frameIndex.value;
        void this.follow();
        return undefined;
      }),
    );
    this.store.add(
      effect(() => {
        debug.other.instructions.value;
        this.render(false);
        return undefined;
      }),
    );
    this.store.add({ dispose: () => (disassemblyState.value = null) });
  }

  private async follow(): Promise<void> {
    const rs = this.debug.focused.peek();
    const at = currentInstruction(this.debug);
    const session = rs?.session;
    if (!rs || !session?.disassemble || !rs.capabilities.peek().disassemble) {
      this.show(
        rs && rs.state.peek() === "stopped"
          ? `This debugger (${rs.config.type}) can't disassemble.`
          : "Pause a native program (lldb-dap, GDB…) to see its instructions.",
      );
      return;
    }
    if (!at) {
      this.show(
        rs.state.peek() === "stopped"
          ? "The selected frame has no instruction address."
          : "Running: the instructions show when it pauses.",
      );
      return;
    }
    if (this.model && this.sessionId === rs.id && this.model.moveTo(at)) {
      this.show(null);
      this.render(true);
      return;
    }
    const disassemble = session.disassemble.bind(session);
    const model = new DisassemblyModel(disassemble);
    const generation = ++this.generation;
    try {
      await model.open(at);
    } catch (err) {
      if (generation === this.generation)
        this.show(`Couldn't disassemble: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (generation !== this.generation) return;
    this.model = model;
    this.sessionId = rs.id;
    this.show(model.rows.length ? null : "No instructions here.");
    this.render(true);
  }

  private show(message: string | null): void {
    this.note.textContent = message ?? "";
    this.note.hidden = message === null;
    if (message !== null) {
      replaceChildren(this.list);
      this.model = null;
      disassemblyState.value = { at: null, rows: 0, first: null, last: null, around: [] };
    }
  }

  /** Draws the rows; `reveal` scrolls the current one into view. */
  private render(reveal: boolean): void {
    const model = this.model;
    if (!model) return;
    const bps = this.debug.other.instructions.peek();
    const current = model.current;
    const rows = model.rows.map((i) => {
      const bp = bps.find((b) => sameAddress(b.address, i.address));
      const isCurrent = current !== null && sameAddress(current, i.address);
      return h(
        "div",
        {
          class: `disasm-row${isCurrent ? " is-current" : ""}`,
          role: "listitem",
          "data-address": i.address,
          ...(isCurrent ? { "aria-current": "true" } : {}),
        },
        h(
          "button",
          {
            class: `disasm-bp${bp ? (bp.enabled ? " is-on" : " is-disabled") : ""}${bp?.verified === false ? " is-unverified" : ""}`,
            type: "button",
            "aria-label": bp
              ? `Remove the breakpoint at ${i.address}`
              : `Add a breakpoint at ${i.address}`,
          },
          h("span", { class: "disasm-bp-dot" }),
        ),
        h("span", { class: "disasm-address" }, i.address),
        h("span", { class: "disasm-bytes" }, i.bytes ?? ""),
        h("span", { class: "disasm-instruction" }, i.instruction),
        h(
          "span",
          { class: "disasm-where" },
          [
            i.symbol ?? "",
            i.line !== undefined
              ? `${i.path ? `${i.path.split(/[\\/]/).pop()}:` : ""}${i.line}`
              : "",
          ]
            .filter(Boolean)
            .join("  "),
        ),
      );
    });
    replaceChildren(this.list, ...rows);
    const at = current ? rowOf(model.rows, current) : -1;
    disassemblyState.value = {
      at: current,
      rows: model.rows.length,
      first: model.rows[0]?.address ?? null,
      last: model.rows.at(-1)?.address ?? null,
      around: model.rows
        .slice(Math.max(0, at - 5), Math.max(0, at) + 15)
        .map((i) => instructionLine(i, current !== null && sameAddress(current, i.address))),
    };
    if (reveal && at >= 0) rows[at]?.scrollIntoView({ block: "center" });
  }

  /** Near an end: more instructions there (the view keeps its place when rows go above). */
  private async onScroll(): Promise<void> {
    const model = this.model;
    if (!model) return;
    const list = this.list;
    if (list.scrollTop < 60) {
      const height = list.scrollHeight;
      const added = await model.loadBefore().catch(() => 0);
      if (added && model === this.model) {
        this.render(false);
        list.scrollTop += list.scrollHeight - height;
      }
    } else if (list.scrollTop + list.clientHeight > list.scrollHeight - 60) {
      const added = await model.loadAfter().catch(() => 0);
      if (added && model === this.model) {
        const top = list.scrollTop;
        this.render(false);
        list.scrollTop = top;
      }
    }
  }

  focus(): void {
    this.element.focus();
  }

  serialize(): null {
    return null;
  }

  persist(): boolean {
    return false;
  }

  dispose(): void {
    this.store.dispose();
    this.element.remove();
  }
}

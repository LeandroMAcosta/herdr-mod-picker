import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, readTextFile, keys, run, theme, props, focused, window, closeOverlay, appHome, shared, setShared } from "herdr";
import {
  modEntries, rankEntries, openAction, besideAction, prettyKeys,
  parseUses, recordUse, parseHidden, toggleHidden, visibleEntries, countHidden,
} from "./entries.js";

const WINDOW = 10;
const USES_KEY = "mod-picker.uses.v1";
const HIDDEN_KEY = "mod-picker.hidden.v1";

const firstLine = (text) => (text ?? "").trim().split("\n")[0];
const quote = (text) => "'" + text.replaceAll("'", "''") + "'";

// Herdr has no API that lists installed mods (installed.json holds only its own), so read the folder.
async function modFolders(dir) {
  if (window()?.platform === "windows") {
    const script = "& { param($p) Get-ChildItem -LiteralPath $p -Directory -Name -ErrorAction Stop } " + quote(dir);
    const r = await exec("powershell", ["-NoProfile", "-Command", script]);
    if (r.code !== 0) throw new Error(firstLine(r.stderr) || "Cannot list the mods folder");
    return r.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  // -p marks folders with a slash and -L counts a linked mod folder as one. A broken link makes
  // ls exit nonzero while it still lists the rest, so only an empty listing is an error.
  const r = await exec("ls", ["-1pL", dir]);
  const names = r.stdout.split("\n").filter((line) => line.endsWith("/")).map((line) => line.slice(0, -1));
  if (!names.length && r.code !== 0) throw new Error(firstLine(r.stderr) || `ls exited ${r.code}`);
  return names;
}

async function loadEntries() {
  const dir = `${appHome()}/mods`;
  const names = await modFolders(dir);
  const specs = await Promise.all(names.map((name) => readTextFile(`${dir}/${name}/mod.json`)));
  return modEntries(names.map((name, i) => ({ name, modJson: specs[i] })), keys());
}

const KEYS = {
  escape: (picker) => picker.close(),
  enter: (picker, picked) => picker.go(picked, false),
  up: (picker, _picked, count) => picker.move(-1, count),
  down: (picker, _picked, count) => picker.move(1, count),
};

export default class ModPicker extends View {
  init(_props, cx) {
    this.query = "";
    this.at = 0;
    this.done = false;
    this.entries = null;
    this.rows = [];
    this.error = null;
    // The pane under the popup, read before anything moves focus; a split needs it by id.
    this.pane = focused()?.pane ?? null;
    this.mac = window()?.platform === "macos";
    this.uses = parseUses(shared(USES_KEY));
    this.hidden = parseHidden(shared(HIDDEN_KEY));
    this.showHidden = false;
    this.input = InputState.new({ placeholder: "Mod…" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      this.at = 0;
      this.rank();
      cx.notify();
    });
    this.input.on("submit", () => this.go(this.rows[this.at], false));
    // Bound as actions so the Input never sees these chords; the app keymap has no unbind and
    // init runs on every open, so bind once per app run.
    globalThis.__modPickerKeys ||= cx.bind_keys([
      { keystroke: "shift-enter", action: "mod_picker.open_beside", context: "ModPicker" },
      { keystroke: "ctrl-h", action: "mod_picker.toggle_hidden", context: "ModPicker" },
      { keystroke: "ctrl-.", action: "mod_picker.toggle_show_hidden", context: "ModPicker" },
    ]);
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();

    cx.spawn(async (cx) => {
      try {
        this.entries = await loadEntries();
      } catch (e) {
        this.entries = [];
        this.error = firstLine(e?.message ?? String(e));
      }
      this.rank();
      cx.notify();
    });
  }

  rank() {
    this.rows = rankEntries(visibleEntries(this.entries ?? [], this.hidden, this.showHidden), this.query, this.uses);
  }

  close() {
    closeOverlay(props().overlay);
  }

  // Enter can reach both the key handler and the input's submit; only the first acts.
  go(entry, beside) {
    if (!entry || this.done || (beside && !this.pane)) return;
    this.done = true;
    setShared(USES_KEY, Object.fromEntries(recordUse(this.uses, entry.name, Date.now())));
    this.close();
    const { command, args } = beside ? besideAction(entry, this.pane) : openAction(entry);
    run(command, args);
  }

  move(step, count) {
    if (count) this.at = (this.at + step + count) % count;
  }

  // Hiding drops the row unless hidden rows are shown; render clamps the index if it was the last.
  toggleRowHidden(entry) {
    if (!entry) return;
    this.hidden = toggleHidden(this.hidden, entry.name);
    this.rank();
    setShared(HIDDEN_KEY, [...this.hidden]);
  }

  // Rows appear or vanish around the selection, so stay on the same mod when it is still listed.
  toggleShowHidden(selected) {
    this.showHidden = !this.showHidden;
    this.rank();
    const at = this.rows.indexOf(selected);
    if (at >= 0) this.at = at;
  }

  chip(t, text) {
    return div().px(6).h(18).flex_none().rounded(5).text_size(10.5).text_color(t.muted).bg(t.raised).child(text);
  }

  status() {
    if (this.error) return `Cannot list mods: ${this.error}`;
    if (this.entries === null) return "Loading mods…";
    if (this.rows.length) return null;
    if (!this.entries.length) return "No mods installed";
    return this.query.trim() ? `No mod matches "${this.query.trim()}"` : "Every mod is hidden";
  }

  render() {
    const t = theme();
    const rows = this.rows;
    this.at = Math.max(0, Math.min(this.at, rows.length - 1));
    const selected = rows[this.at];
    const start = Math.max(0, Math.min(this.at - Math.floor(WINDOW / 2), rows.length - WINDOW));
    const shown = rows.slice(start, start + WINDOW);
    const status = this.status();
    const hiddenCount = countHidden(this.entries ?? [], this.hidden);

    const rowView = (entry) => {
      const hidden = this.hidden.has(entry.name);
      return h_flex()
        .id(`mod-${entry.name}`)
        .mx(4)
        .px(10)
        .h(32)
        .flex_none()
        .rounded(7)
        .gap(10)
        .items_center()
        .cursor_pointer()
        .when(entry === selected, (el) => el.bg(t.selected))
        .when(hidden, (el) => el.opacity(0.5))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.go(entry, false))
        .child(div().flex_none().max_w(260).truncate().text_color(t.foreground).child(entry.title))
        .child(div().flex_1().truncate().text_size(11.5).text_color(t.dim).child(entry.name !== entry.title.toLowerCase() ? entry.name : ""))
        .when(hidden, (el) => el.child(this.chip(t, "hidden")))
        .child(this.chip(t, entry.kind))
        .child(div().w(64).flex_none().text_size(11).text_color(t.dim).child(entry.shortcut ? prettyKeys(entry.shortcut, this.mac) : ""));
    };

    return v_flex()
      .id("mod-picker")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .key_context("ModPicker")
      .on_action("mod_picker.open_beside", () => this.go(selected, true))
      .on_action("mod_picker.toggle_hidden", (_e, cx) => {
        this.toggleRowHidden(selected);
        cx.notify();
      })
      .on_action("mod_picker.toggle_show_hidden", (_e, cx) => {
        this.toggleShowHidden(selected);
        cx.notify();
      })
      .on_key_down((e, cx) => {
        const action = KEYS[e.keystroke];
        if (!action) return;
        action(this, selected, rows.length);
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(10)
          .items_center()
          .rounded(9)
          .border_1()
          .border_color(t.accent)
          .bg(t.background)
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)),
      )
      .when(status !== null, (el) => el.child(div().px(14).text_size(12).text_color(t.muted).child(status)))
      .child(v_flex().min_h(0).children(shown.map(rowView)))
      .child(
        h_flex()
          .pt(6)
          .gap(14)
          .border_t(1)
          .border_color(t.border)
          .text_size(11)
          .text_color(t.dim)
          .child("↵ open")
          .when(this.pane !== null, (el) => el.child(`${this.mac ? "⇧" : "Shift+"}↵ beside`))
          .child(`${prettyKeys("ctrl-h", this.mac)} ${selected && this.hidden.has(selected.name) ? "unhide" : "hide"}`)
          .child("esc close")
          .child(div().flex_1())
          .when(hiddenCount > 0, (el) =>
            el.child(
              div()
                .id("show-hidden")
                .px(6)
                .rounded(5)
                .cursor_pointer()
                .text_color(this.showHidden ? t.foreground : t.dim)
                .bg(this.showHidden ? t.selected : t.raised)
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => {
                  this.toggleShowHidden(selected);
                  cx.notify();
                })
                .child(`${hiddenCount} hidden`),
            ),
          )
          .child(this.entries ? `${rows.length} of ${this.entries.length}` : ""),
      );
  }
}

// No imports from "herdr" or "gpui-kit": node can load this file to check it against real mods.

// Internal popups, layout chrome and mods that need props to make sense. A denylist, so a
// newly installed mod shows up without editing this file. machine-add needs a target.
export const HIDDEN = new Set([
  "confirm", "prompt", "toast", "menu", "new-menu", "t3-new-menu", "help", "peek", "pane", "t3-pane",
  "terminals-pane", "terminals-bar", "spaces", "agents", "tabs", "t3-spaces", "t3-agents", "t3-tabs",
  "t3-chrome", "t3-focus", "workspace-chrome", "workspace-status", "win98", "worktree", "machine-add",
  "mod-picker",
]);

const OPEN = {
  overlay: (entry) => ({ command: "mod.open", args: { name: entry.name } }),
  pane: (entry) => ({ command: "tab.new", args: { name: entry.title, mod: entry.name } }),
};

export const openAction = (entry) => OPEN[entry.kind](entry);
export const besideAction = (entry, pane) => ({ command: "pane.split", args: { direction: "right", pane, mod: entry.name } });

function parseSpec(text) {
  try {
    const spec = JSON.parse(text ?? "{}");
    return spec && typeof spec === "object" ? spec : {};
  } catch {
    return {};
  }
}

// bindings: what keys() returns, one { section, keys, action } per binding.
export function modEntry(name, modJson, bindings) {
  const spec = parseSpec(modJson);
  const bound = bindings.find((b) => b.section === "global" && b.action === `mod.open:${name}`);
  return {
    name,
    title: typeof spec.title === "string" && spec.title.trim() ? spec.title.trim() : name,
    kind: "overlay" in spec ? "overlay" : "pane",
    shortcut: bound?.keys.trim() || null,
  };
}

// mods: one { name, modJson } per folder, modJson the file's text or null.
export function modEntries(mods, bindings) {
  return mods
    .filter((m) => !HIDDEN.has(m.name) && !m.name.startsWith("."))
    .map((m) => modEntry(m.name, m.modJson, bindings));
}

// shared() returns whatever was saved last, maybe by another version, so an entry of any other
// shape counts as never used.
const isUse = (use) => Number.isFinite(use?.count) && Number.isFinite(use?.last);

// uses: name to { count, last } (last in ms since the epoch), as saved under "mod-picker.uses.v1".
export function parseUses(value) {
  const saved = value !== null && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];
  return new Map(saved.filter(([, use]) => isUse(use)).map(([name, use]) => [name, { count: use.count, last: use.last }]));
}

const NEVER = { count: 0, last: 0 };

export const recordUse = (uses, name, now) => new Map(uses).set(name, { count: (uses.get(name) ?? NEVER).count + 1, last: now });

// hidden: the mod names the user hid, as saved under "mod-picker.hidden.v1".
export const parseHidden = (value) => new Set(Array.isArray(value) ? value.filter((name) => typeof name === "string") : []);

export function toggleHidden(hidden, name) {
  const next = new Set(hidden);
  if (!next.delete(name)) next.add(name);
  return next;
}

export const visibleEntries = (entries, hidden, showHidden) => (showHidden ? entries : entries.filter((e) => !hidden.has(e.name)));

// Names of mods no longer installed stay saved but do not count: the chip promises rows it can show.
export const countHidden = (entries, hidden) => entries.filter((e) => hidden.has(e.name)).length;

function isSubsequence(needle, hay) {
  let at = 0;
  for (const ch of needle) {
    at = hay.indexOf(ch, at) + 1;
    if (!at) return false;
  }
  return true;
}

function tokenScore(token, text) {
  if (text === token) return 100;
  if (text.startsWith(token)) return 80;
  if (text.includes(token)) return 60;
  if (isSubsequence(token, text)) return 30;
  return -1;
}

function matchScore(tokens, entry) {
  const title = entry.title.toLowerCase();
  const name = entry.name.toLowerCase();
  let sum = 0;
  for (const token of tokens) {
    const score = Math.max(tokenScore(token, title), tokenScore(token, name));
    if (score < 0) return -1;
    sum += score;
  }
  return sum;
}

const compare = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

// Not localeCompare: the app's JS engine ignores its sensitivity option, which sorted "files" after "Vitals".
const byTitle = (a, b) => compare(a.title.toLowerCase(), b.title.toLowerCase()) || compare(a.name, b.name);

// Best match first (an empty query matches all equally), then most used, most recent, title.
export function rankEntries(entries, query, uses) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries
    .map((entry) => ({ entry, score: matchScore(tokens, entry), use: uses.get(entry.name) ?? NEVER }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score || b.use.count - a.use.count || b.use.last - a.use.last || byTitle(a.entry, b.entry))
    .map((r) => r.entry);
}

const GLYPHS = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" };
const WORDS = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super" };

// keys.json spelling ("cmd-alt-v", "cmd--", chords split by spaces) to what the keyboard shows.
export function prettyKeys(keys, mac) {
  const names = mac ? GLYPHS : WORDS;
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd", option: "alt" };
  return keys
    .trim()
    .split(/\s+/)
    .map((stroke) => {
      const parts = stroke.split("-");
      let key = parts.pop();
      if (key === "") {
        key = "-";
        parts.pop();
      }
      const held = new Set(parts.map((m) => alias[m.toLowerCase()] ?? m.toLowerCase()));
      const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
      return [...Object.keys(names).filter((m) => held.has(m)).map((m) => names[m]), label].join(mac ? "" : "+");
    })
    .join(" ");
}

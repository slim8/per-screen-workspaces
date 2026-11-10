// SPDX-License-Identifier: GPL-2.0-or-later

// Per-Screen Workspaces — macOS-like "Spaces" per monitor for GNOME 46.
//
// Mutter has ONE active workspace shared by all monitors, so we fake it:
//
//   * Only two real workspaces are used:
//       0 = "stage"   (always the active one: whatever is here is visible)
//       1 = "parking" (every hidden window lives here)
//   * Each monitor has its own ordered list of spaces (its own count, added
//     and removed independently, remembered across sessions). Every window
//     is tagged with a space id. A window is on the stage iff its tag is the
//     current space of its monitor, otherwise it is parked.
//   * Switching a space on one monitor only moves THAT monitor's windows,
//     the real active workspace never changes -> nothing ever "jumps".
//   * Fullscreen / maximize opens a new space right after the current one
//     (like the macOS green button). Restoring or closing the window
//     removes that space and goes back to where it came from.
//   * Every monitor gets a top bar with a spaces indicator (scroll = switch,
//     click = go to, drag = reorder, right click = remove, "+" = add).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Windows that open maximized get their own space after this delay (µs).
const NEW_WINDOW_GRACE = 400 * 1000;
const SCROLL_COOLDOWN_MS = 180;
const DRAG_THRESHOLD = 6;  // px before a press on a space becomes a drag

const STAGE = 0;
const PARKING = 1;
const FADE_MS = 180;
const KEY_MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

const SWITCH_BINDINGS = {
    'switch-to-workspace-left': -1,
    'switch-to-workspace-right': 1,
    'switch-to-workspace-up': -1,
    'switch-to-workspace-down': 1,
};
const MOVE_BINDINGS = {
    'move-to-workspace-left': -1,
    'move-to-workspace-right': 1,
    'move-to-workspace-up': -1,
    'move-to-workspace-down': 1,
};
const INDEX_BINDINGS = [1, 2, 3, 4];

const isMaximized = w => w.get_maximized() === Meta.MaximizeFlags.BOTH;

// ---- logging ---------------------------------------------------------------
//
// Log file: ~/.local/state/per-screen-workspaces/extension.log
// (rotated to extension.log.1 at 1 MB). Errors are also sent to the journal.
// Set the `debug-log` setting to true to also log every switch/space change.

const LOG_MAX_BYTES = 1024 * 1024;

class Logger {
    constructor() {
        const dir = GLib.build_filenamev([GLib.get_user_state_dir(), 'per-screen-workspaces']);
        GLib.mkdir_with_parents(dir, 0o755);
        this.path = GLib.build_filenamev([dir, 'extension.log']);
        this._file = Gio.File.new_for_path(this.path);
        this._buffer = [];
        this._flushId = 0;
        this.debugEnabled = false;
    }

    _write(level, msg) {
        const ts = GLib.DateTime.new_now_local().format('%Y-%m-%d %H:%M:%S.%f').slice(0, 23);
        this._buffer.push(`${ts} [${level}] ${msg}\n`);
        if (level === 'ERROR')
            this.flush();
        else if (!this._flushId)
            this._flushId = GLib.timeout_add(GLib.PRIORITY_LOW, 2000, () => {
                this._flushId = 0;
                this.flush();
                return GLib.SOURCE_REMOVE;
            });
    }

    info(msg) {
        this._write('INFO', msg);
    }

    debug(msg) {
        if (this.debugEnabled)
            this._write('DEBUG', msg);
    }

    error(where, e) {
        const text = `${where}: ${e?.message ?? e}\n${e?.stack ?? ''}`.trimEnd();
        console.error(`[per-screen-workspaces] ${text}`);
        this._write('ERROR', text);
    }

    flush() {
        if (!this._buffer.length)
            return;
        const data = this._buffer.join('');
        this._buffer = [];
        try {
            const info = this._file.query_exists(null)
                ? this._file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null)
                : null;
            if (info && info.get_size() > LOG_MAX_BYTES) {
                const old = Gio.File.new_for_path(`${this.path}.1`);
                this._file.move(old, Gio.FileCopyFlags.OVERWRITE, null, null);
            }
            const stream = this._file.append_to(Gio.FileCreateFlags.NONE, null);
            stream.write_all(new TextEncoder().encode(data), null);
            stream.close(null);
        } catch (e) {
            console.error(`[per-screen-workspaces] cannot write log: ${e.message}`);
        }
    }

    destroy() {
        if (this._flushId)
            GLib.source_remove(this._flushId);
        this._flushId = 0;
        this.flush();
    }
}

let log = null;

// Run fn, log any exception instead of letting it break GNOME Shell.
function guard(where, fn, fallback = undefined) {
    return (...args) => {
        try {
            return fn(...args);
        } catch (e) {
            log?.error(where, e);
            return typeof fallback === 'function' ? fallback(...args) : fallback;
        }
    };
}

// ---- UI --------------------------------------------------------------------

const SpacesIndicator = GObject.registerClass(
class SpacesIndicator extends St.BoxLayout {
    _init(ext, monitor) {
        super._init({
            style_class: 'pswp-indicator',
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._ext = ext;
        this._monitor = monitor;
        this.connect('scroll-event', guard('indicator-scroll', (_a, event) => this._ext._onScroll(this._monitor, event), Clutter.EVENT_STOP));
        // Drag to reorder: press a space, move left/right, release.
        this.connect('motion-event', guard('indicator-motion', (_a, event) => this._onDragMotion(event), Clutter.EVENT_STOP));
        this.connect('button-release-event', guard('indicator-release', (_a, event) => this._onRelease(event), Clutter.EVENT_STOP));
        this.connect('destroy', () => this._endDrag());
        this._drag = null;
        this._items = [];
        this.update();
    }

    update() {
        if (this._drag) {
            this._pendingUpdate = true;
            return;
        }
        this._pendingUpdate = false;
        this.destroy_all_children();
        this._items = [];
        const ext = this._ext;
        const m = this._monitor;
        const list = ext._ensureMonitor(m);
        const cur = ext._cur.get(m);

        list.forEach(s => {
            let item;
            if (s.owner) {
                const app = Shell.WindowTracker.get_default().get_window_app(s.owner);
                item = new St.Bin({
                    style_class: 'pswp-full',
                    reactive: true,
                    track_hover: true,
                    y_align: Clutter.ActorAlign.CENTER,
                    child: app
                        ? app.create_icon_texture(14)
                        : new St.Icon({icon_name: 'view-fullscreen-symbolic', icon_size: 14}),
                });
            } else {
                item = new St.Widget({
                    style_class: 'pswp-dot',
                    reactive: true,
                    track_hover: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
            }
            item._pswpSpace = s;
            if (s.id === cur)
                item.add_style_class_name('pswp-active');
            item.connect('button-press-event', guard('indicator-press', (_a, event) => {
                if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                    return Clutter.EVENT_PROPAGATE;
                this._beginPress(item, event);
                return Clutter.EVENT_STOP;
            }, Clutter.EVENT_STOP));
            item.connect('button-release-event', guard('indicator-click', (_a, event) => {
                if (event.get_button() === Clutter.BUTTON_PRIMARY)
                    return Clutter.EVENT_PROPAGATE;  // handled by _onRelease
                if (!this._drag)
                    ext._removeSpace(m, s);
                return Clutter.EVENT_STOP;
            }, Clutter.EVENT_STOP));
            this.add_child(item);
            this._items.push(item);
        });

        const add = new St.Label({
            text: '+',
            style_class: 'pswp-add',
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        add.connect('button-release-event', guard('indicator-add', () => {
            if (!this._drag)
                ext._addSpace(m);
            return Clutter.EVENT_STOP;
        }, Clutter.EVENT_STOP));
        this.add_child(add);
    }

    _beginPress(item, event) {
        this._endDrag();
        const [x] = event.get_coords();
        this._drag = {item, x0: x, moved: false, grab: global.stage.grab(this)};
    }

    _onDragMotion(event) {
        const d = this._drag;
        if (!d)
            return Clutter.EVENT_PROPAGATE;
        const [x] = event.get_coords();
        if (!d.moved) {
            if (Math.abs(x - d.x0) < DRAG_THRESHOLD)
                return Clutter.EVENT_STOP;
            d.moved = true;
            d.item.add_style_class_name('pswp-dragging');
        }
        // Target slot = number of other spaces whose center is left of the pointer.
        let target = 0;
        for (const it of this._items) {
            if (it === d.item)
                continue;
            const [ix] = it.get_transformed_position();
            const [iw] = it.get_transformed_size();
            if (ix + iw / 2 < x)
                target++;
        }
        const from = this._items.indexOf(d.item);
        if (target !== from) {
            this._items.splice(from, 1);
            this._items.splice(target, 0, d.item);
            this.set_child_at_index(d.item, target);
            this._ext._moveSpace(this._monitor, d.item._pswpSpace, target);
        }
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        const d = this._drag;
        if (!d || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._endDrag();
        if (!d.moved) {
            const i = this._ext._ensureMonitor(this._monitor).indexOf(d.item._pswpSpace);
            if (i >= 0)
                this._ext._switchToIndex(this._monitor, i);
        }
        if (this._pendingUpdate)
            this.update();
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        const d = this._drag;
        if (!d)
            return;
        this._drag = null;
        d.grab?.dismiss();
        d.item.remove_style_class_name?.('pswp-dragging');
    }
});

// Top-bar button holding the indicator on the primary monitor.
const PrimaryButton = GObject.registerClass(
class PrimaryButton extends PanelMenu.Button {
    _init(indicator) {
        super._init(0.5, 'Spaces', true);
        this.add_child(indicator);
        this.indicator = indicator;
    }
});

// Top bar for a secondary monitor.
const SecondaryPanel = GObject.registerClass(
class SecondaryPanel extends St.BoxLayout {
    _init(ext, monitor) {
        const geo = Main.layoutManager.monitors[monitor];
        const height = Math.max(Main.panel.height, 28);
        const primary = Main.layoutManager.primaryMonitor;
        const atBottom = primary &&
            Main.layoutManager.panelBox.y > primary.y + primary.height / 2;

        super._init({
            name: 'panel',
            style_class: 'pswp-panel',
            reactive: true,
            x: geo.x,
            y: atBottom ? geo.y + geo.height - height : geo.y,
            width: geo.width,
            height,
        });

        const left = new St.BoxLayout({x_expand: true, x_align: Clutter.ActorAlign.START});
        const center = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
        const right = new St.BoxLayout({x_expand: true, x_align: Clutter.ActorAlign.END});
        this.add_child(left);
        this.add_child(center);
        this.add_child(right);

        this.indicator = new SpacesIndicator(ext, monitor);
        const indicatorBin = new St.Bin({style_class: 'panel-button', child: this.indicator});
        left.add_child(indicatorBin);

        this._clockLabel = new St.Label({
            style_class: 'pswp-clock',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const clockBin = new St.Bin({style_class: 'panel-button', child: this._clockLabel});
        center.add_child(clockBin);

        this._clock = new GnomeDesktop.WallClock();
        this._clockId = this._clock.connect('notify::clock', () => this._updateClock());
        this._updateClock();

        this.connect('destroy', () => {
            this._clock.disconnect(this._clockId);
            this._clock = null;
        });
    }

    _updateClock() {
        this._clockLabel.text = this._clock.clock;
    }
});

// ---- extension ----------------------------------------------------------------

export default class PerScreenWorkspaces extends Extension {
    enable() {
        log = new Logger();
        try {
            this._enable();
        } catch (e) {
            log.error('enable', e);
            throw e;
        }
    }

    // The 'unlock-dialog' session mode is used on purpose: disabling on screen
    // lock would move every window back onto real workspaces and destroy the
    // per-monitor space layout (and the "own space" of maximized/fullscreen
    // windows). Keybindings only run in NORMAL/OVERVIEW action modes, so
    // nothing is reachable from the lock screen.
    disable() {
        try {
            this._disable();
            log?.info('disabled');
        } catch (e) {
            log?.error('disable', e);
        } finally {
            log?.destroy();
            log = null;
        }
    }

    _enable() {
        this._settings = this.getSettings();
        log.debugEnabled = this._settings.get_boolean('debug-log');
        this._debugId = this._settings.connect('changed::debug-log',
            () => (log.debugEnabled = this._settings.get_boolean('debug-log')));
        this._wsm = global.workspace_manager;
        this._mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._wmPrefs = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});

        this._spaces = new Map();  // monitor -> [{id, owner, origin}]
        this._cur = new Map();     // monitor -> current space id
        this._tags = new Map();    // Meta.Window -> space id
        this._winfo = new Map();   // Meta.Window -> {ids, created, idle}
        this._indicators = new Map();  // monitor -> SpacesIndicator
        this._panels = [];
        this._primaryButton = null;
        this._nextId = 1;
        this._internal = 0;
        this._relayoutId = 0;
        this._activeFixId = 0;
        this._uiId = 0;
        this._swipe = null;
        this._scrollLock = 0;
        this._scrollAcc = 0;

        // Adopt the current layout: real workspace i -> space i of each monitor.
        const active = this._wsm.get_active_workspace_index();
        const nReal = this._wsm.get_n_workspaces();
        const saved = this._settings.get_value('space-counts').deep_unpack();
        for (let m = 0; m < global.display.get_n_monitors(); m++) {
            const count = saved[this._monKey(m)] ?? saved[String(m)] ?? nReal;
            this._ensureMonitor(m, count, active);
        }
        for (const w of this._allWindows()) {
            const list = this._ensureMonitor(w.get_monitor());
            const normals = list.filter(s => !s.owner);
            const i = Math.min(w.get_workspace().index(), normals.length - 1);
            this._tags.set(w, normals[i].id);
        }
        this._saveCounts();

        this._oldDynamic = this._mutter.get_boolean('dynamic-workspaces');
        this._oldOnlyPrimary = this._mutter.get_boolean('workspaces-only-on-primary');
        this._oldNum = this._wmPrefs.get_int('num-workspaces');
        this._mutter.set_boolean('dynamic-workspaces', false);
        this._mutter.set_boolean('workspaces-only-on-primary', false);
        this._wmPrefs.set_int('num-workspaces', 2);

        for (const a of global.get_window_actors())
            this._track(a.meta_window, false);

        this._signals = [
            [global.display, global.display.connect('window-created', guard('window-created', (_d, w) => this._track(w, true)))],
            [global.display, global.display.connect('window-entered-monitor', guard('window-entered-monitor', () => this._queueRelayout()))],
            [this._wsm, this._wsm.connect('active-workspace-changed', guard('active-workspace-changed', () => this._onActiveChanged()))],
            [this._wsm, this._wsm.connect('notify::n-workspaces', guard('n-workspaces', () => this._queueRelayout()))],
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed', guard('monitors-changed', () => this._onMonitorsChanged()))],
            [this._settings, this._settings.connect('changed::panel-on-all-monitors', guard('build-ui', () => this._buildUi()))],
        ];

        for (const [name, dir] of Object.entries(SWITCH_BINDINGS))
            Main.wm.setCustomKeybindingHandler(name, KEY_MODES, guard(name, () => this._switchRelative(dir)));
        for (const [name, dir] of Object.entries(MOVE_BINDINGS))
            Main.wm.setCustomKeybindingHandler(name, KEY_MODES, guard(name, () => this._moveFocused(dir)));
        for (const i of INDEX_BINDINGS) {
            Main.wm.setCustomKeybindingHandler(`switch-to-workspace-${i}`, KEY_MODES,
                guard(`switch-to-workspace-${i}`, () => this._switchToIndex(this._pointerMonitor(), i - 1)));
        }
        Main.wm.addKeybinding('add-space', this._settings, Meta.KeyBindingFlags.NONE, KEY_MODES,
            guard('add-space', () => this._addSpace(this._pointerMonitor())));
        Main.wm.addKeybinding('remove-space', this._settings, Meta.KeyBindingFlags.NONE, KEY_MODES, guard('remove-space', () => {
            const m = this._pointerMonitor();
            const s = this._ensureMonitor(m).find(x => x.id === this._cur.get(m));
            if (s)
                this._removeSpace(m, s);
        }));

        this._installPatches();
        this._relayout();
        this._buildUi();

        const mons = Main.layoutManager.monitors.map(g => `${g.index}:${g.width}x${g.height}+${g.x}+${g.y}`).join(' ');
        const counts = [...this._spaces].map(([m, l]) => `${m}=${l.length}`).join(' ');
        log.info(`enabled v${this.metadata.version} — GNOME Shell ${Config.PACKAGE_VERSION}, ` +
            `monitors [${mons}], primary ${Main.layoutManager.primaryIndex}, spaces [${counts}], ` +
            `windows ${this._tags.size}, old settings dynamic=${this._oldDynamic} ` +
            `onlyPrimary=${this._oldOnlyPrimary} num=${this._oldNum}`);
    }

    _disable() {
        this._settings.disconnect(this._debugId);
        for (const id of [this._relayoutId, this._activeFixId, this._uiId, this._scrollLock])
            if (id)
                GLib.source_remove(id);
        this._relayoutId = this._activeFixId = this._uiId = this._scrollLock = 0;

        this._destroyUi();

        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        for (const w of [...this._winfo.keys()])
            this._untrack(w);

        this._removePatches();

        Main.wm.removeKeybinding('add-space');
        Main.wm.removeKeybinding('remove-space');
        const native = Main.wm._showWorkspaceSwitcher.bind(Main.wm);
        for (const name of [...Object.keys(SWITCH_BINDINGS), ...Object.keys(MOVE_BINDINGS)])
            Main.wm.setCustomKeybindingHandler(name, KEY_MODES, native);
        for (const i of INDEX_BINDINGS)
            Main.wm.setCustomKeybindingHandler(`switch-to-workspace-${i}`, KEY_MODES, native);

        // Give every window back a real workspace = index of its space.
        const num = Math.max(2, this._oldNum);
        const time = global.get_current_time();
        while (this._wsm.get_n_workspaces() < num)
            this._wsm.append_new_workspace(false, time);
        for (const [w, id] of this._tags) {
            const normals = (this._spaces.get(w.get_monitor()) ?? []).filter(s => !s.owner);
            const idx = Math.max(0, normals.findIndex(s => s.id === id));
            w.change_workspace_by_index(Math.min(idx, num - 1), false);
        }
        this._wsm.get_workspace_by_index(0)?.activate(time);

        this._wmPrefs.set_int('num-workspaces', this._oldNum);
        this._mutter.set_boolean('dynamic-workspaces', this._oldDynamic);
        this._mutter.set_boolean('workspaces-only-on-primary', this._oldOnlyPrimary);

        this._settings = this._mutter = this._wmPrefs = this._wsm = null;
        this._spaces = this._cur = this._tags = this._winfo = this._indicators = null;
        this._swipe = null;
    }

    // ---- patches ---------------------------------------------------------

    _installPatches() {
        const self = this;
        const WsProto = Meta.Workspace.prototype;
        const WinProto = Meta.Window.prototype;
        this._orig = {
            wsActivate: WsProto.activate,
            wsActivateWithFocus: WsProto.activate_with_focus,
            winActivate: WinProto.activate,
            winActivateWithWs: WinProto.activate_with_workspace,
        };

        // Alt-Tab / dash / overview / notifications activating a parked
        // window: bring its space forward on ITS monitor only.
        WsProto.activate_with_focus = function (win, time) {
            if (this.index() !== STAGE && win && self._tags.has(win)) {
                self._safeReveal(win, 'Workspace.activate_with_focus');
                return self._orig.winActivate.call(win, time);
            }
            return self._orig.wsActivateWithFocus.call(this, win, time);
        };
        WsProto.activate = function (time) {
            if (this.index() !== STAGE && !self._internal)
                return undefined;
            return self._orig.wsActivate.call(this, time);
        };
        WinProto.activate = function (time) {
            if (self._tags.has(this) && this.get_workspace()?.index() !== STAGE)
                self._safeReveal(this, 'Window.activate');
            return self._orig.winActivate.call(this, time);
        };
        WinProto.activate_with_workspace = function (time, ws) {
            if (self._tags.has(this) && this.get_workspace()?.index() !== STAGE) {
                self._safeReveal(this, 'Window.activate_with_workspace');
                return self._orig.winActivate.call(this, time);
            }
            return self._orig.winActivateWithWs.call(this, time, ws);
        };

        // No global slide animation between the real workspaces.
        this._anim = Main.wm._workspaceAnimation;
        this._anim.animateSwitch = (_from, _to, _dir, onComplete) => onComplete();

        // Hijack the native 3-finger swipe (normal mode; the overview has its own).
        this._tracker = this._anim._swipeTracker;
        const origEmit = this._tracker.emit;
        const swipeBegin = guard('swipe-begin', (...a) => this._swipeBegin(...a));
        const swipeUpdate = guard('swipe-update', p => this._swipeUpdate(p));
        const swipeEnd = guard('swipe-end', (d, p) => this._swipeEnd(d, p));
        this._tracker.emit = (signal, ...args) => {
            if (signal === 'begin')
                return swipeBegin(this._tracker, args[0]);
            if (signal === 'update')
                return swipeUpdate(args[0]);
            if (signal === 'end')
                return swipeEnd(args[0], args[1]);
            return origEmit.call(this._tracker, signal, ...args);
        };
    }

    _removePatches() {
        const WsProto = Meta.Workspace.prototype;
        const WinProto = Meta.Window.prototype;
        WsProto.activate = this._orig.wsActivate;
        WsProto.activate_with_focus = this._orig.wsActivateWithFocus;
        WinProto.activate = this._orig.winActivate;
        WinProto.activate_with_workspace = this._orig.winActivateWithWs;
        delete this._tracker.emit;
        delete this._anim.animateSwitch;
        this._tracker = this._anim = this._orig = null;
    }

    // ---- top bars ------------------------------------------------------------

    _buildUi() {
        this._destroyUi();
        const primary = Main.layoutManager.primaryIndex;
        for (let m = 0; m < global.display.get_n_monitors(); m++) {
            if (m === primary) {
                const ind = new SpacesIndicator(this, m);
                this._primaryButton = new PrimaryButton(ind);
                this._primaryButton.connect('scroll-event', guard('panel-scroll', (_a, e) => this._onScroll(m, e), Clutter.EVENT_STOP));
                Main.panel.addToStatusArea(this.uuid, this._primaryButton, 0, 'left');
                this._indicators.set(m, ind);
            } else if (this._settings.get_boolean('panel-on-all-monitors')) {
                const panel = new SecondaryPanel(this, m);
                Main.layoutManager.addChrome(panel, {affectsStruts: true, trackFullscreen: true});
                this._panels.push(panel);
                this._indicators.set(m, panel.indicator);
            }
        }
    }

    _destroyUi() {
        this._primaryButton?.destroy();
        this._primaryButton = null;
        for (const p of this._panels) {
            Main.layoutManager.removeChrome(p);
            p.destroy();
        }
        this._panels = [];
        this._indicators?.clear();
    }

    _updateUi() {
        if (this._uiId)
            return;
        this._uiId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._uiId = 0;
            try {
                for (const ind of this._indicators.values())
                    ind.update();
            } catch (e) {
                log.error('update-ui', e);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _onScroll(m, event) {
        let dir = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            dir = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            dir = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            this._scrollAcc += Math.abs(dy) > Math.abs(dx) ? dy : dx;
            if (Math.abs(this._scrollAcc) >= 1) {
                dir = Math.sign(this._scrollAcc);
                this._scrollAcc = 0;
            }
            break;
        }
        }
        if (dir === 0 || this._scrollLock)
            return Clutter.EVENT_STOP;

        this._scrollLock = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_COOLDOWN_MS, () => {
            this._scrollLock = 0;
            return GLib.SOURCE_REMOVE;
        });
        this._switchToIndex(m, this._curIndex(m) + dir);
        return Clutter.EVENT_STOP;
    }

    _onMonitorsChanged() {
        const n = global.display.get_n_monitors();
        log.info(`monitors changed: ${n} monitor(s), primary ${Main.layoutManager.primaryIndex}`);
        for (const m of [...this._spaces.keys()]) {
            if (m >= n) {
                this._spaces.delete(m);
                this._cur.delete(m);
            }
        }
        const saved = this._settings.get_value('space-counts').deep_unpack();
        for (let m = 0; m < n; m++)
            this._ensureMonitor(m, saved[this._monKey(m)] ?? saved[String(m)]);
        this._relayout();
        this._buildUi();
    }

    // ---- window tracking -------------------------------------------------

    _eligible(w) {
        return w &&
            !w.is_override_redirect() &&
            !w.is_always_on_all_workspaces() &&
            !w.get_transient_for() &&
            w.get_workspace() !== null &&
            w.get_window_type() !== Meta.WindowType.DESKTOP &&
            w.get_window_type() !== Meta.WindowType.DOCK &&
            w.get_monitor() >= 0;
    }

    _allWindows() {
        return global.get_window_actors().map(a => a.meta_window).filter(w => this._eligible(w));
    }

    _track(w, isNew) {
        if (!w || this._winfo.has(w) || w.is_override_redirect())
            return;
        const info = {created: isNew ? GLib.get_monotonic_time() : 0, idle: 0, ids: []};
        const onMax = guard('maximize-notify', () => this._queueMaxCheck(w));
        info.ids = [
            w.connect('notify::maximized-horizontally', onMax),
            w.connect('notify::maximized-vertically', onMax),
            w.connect('notify::fullscreen', onMax),
            w.connect('workspace-changed', guard('workspace-changed', () => this._onWindowWorkspaceChanged(w))),
            w.connect('unmanaged', guard('unmanaged', () => {
                this._untrack(w);
                this._tags.delete(w);
                this._queueRelayout();
            })),
        ];
        this._winfo.set(w, info);
        this._queueRelayout();
    }

    _untrack(w) {
        const info = this._winfo.get(w);
        if (!info)
            return;
        if (info.idle)
            GLib.source_remove(info.idle);
        if (info.graceId)
            GLib.source_remove(info.graceId);
        for (const id of info.ids)
            w.disconnect(id);
        this._winfo.delete(w);
    }

    _onWindowWorkspaceChanged(w) {
        if (this._internal || !this._eligible(w))
            return;
        // Someone else put a window on the stage: it joins the current space.
        if (w.get_workspace().index() === STAGE)
            this._tags.set(w, this._cur.get(w.get_monitor()));
        this._queueRelayout();
    }

    // ---- spaces model ----------------------------------------------------

    _newSpace(owner = null, origin = null) {
        return {id: this._nextId++, owner, origin};
    }

    _ensureMonitor(m, count, currentIndex = 0) {
        if (!this._spaces.has(m)) {
            count = Math.max(1, count ?? this._settings.get_int('default-spaces'));
            const list = [];
            for (let i = 0; i < count; i++)
                list.push(this._newSpace());
            this._spaces.set(m, list);
            this._cur.set(m, list[Math.min(currentIndex, count - 1)].id);
        }
        return this._spaces.get(m);
    }

    // Stable screen id: geometry (e.g. "1920x1080+0+0"), not the index,
    // which changes when the primary monitor changes.
    _monKey(m) {
        const g = global.display.get_monitor_geometry(m);
        return `${g.width}x${g.height}+${g.x}+${g.y}`;
    }

    _saveCounts() {
        const counts = this._settings.get_value('space-counts').deep_unpack();
        for (const [m, list] of this._spaces)
            counts[this._monKey(m)] = list.filter(s => !s.owner).length;
        this._settings.set_value('space-counts', new GLib.Variant('a{si}', counts));
    }

    _curIndex(m) {
        return this._ensureMonitor(m).findIndex(s => s.id === this._cur.get(m));
    }

    _spaceOwnedBy(w) {
        for (const [m, list] of this._spaces) {
            const s = list.find(x => x.owner === w);
            if (s)
                return [m, s];
        }
        return [null, null];
    }

    // Reorder: move space `s` to position `index` on monitor m. Only the
    // order changes; windows keep their space, the visible space stays.
    _moveSpace(m, s, index) {
        const list = this._ensureMonitor(m);
        const from = list.indexOf(s);
        if (from < 0)
            return;
        index = Math.max(0, Math.min(list.length - 1, index));
        if (from === index)
            return;
        list.splice(from, 1);
        list.splice(index, 0, s);
        log.info(`monitor ${m}: space moved ${from + 1} -> ${index + 1}`);
        this._updateUi();
    }

    _addSpace(m) {
        this._ensureMonitor(m).push(this._newSpace());
        log.info(`monitor ${m}: space added (now ${this._spaces.get(m).length})`);
        this._saveCounts();
        this._updateUi();
    }

    _removeSpace(m, s) {
        const list = this._ensureMonitor(m);
        if (s.owner) {
            // Like macOS: closing a full-screen space exits full screen.
            const w = s.owner;
            if (w.is_fullscreen())
                w.unmake_fullscreen();
            if (isMaximized(w))
                w.unmaximize(Meta.MaximizeFlags.BOTH);
            return;
        }
        const normals = list.filter(x => !x.owner);
        if (normals.length <= 1)
            return;
        const ni = normals.indexOf(s);
        const target = normals[ni > 0 ? ni - 1 : 1];
        for (const [w, id] of this._tags)
            if (id === s.id)
                this._tags.set(w, target.id);
        for (const x of list)
            if (x.origin === s.id)
                x.origin = target.id;
        list.splice(list.indexOf(s), 1);
        log.info(`monitor ${m}: space removed (now ${list.length})`);
        const wasCurrent = this._cur.get(m) === s.id;
        if (wasCurrent)
            this._cur.set(m, target.id);
        this._saveCounts();
        this._relayout();
        if (wasCurrent)
            this._fadeIn(m);
    }

    _openFullSpace(w) {
        const m = w.get_monitor();
        const list = this._ensureMonitor(m);
        // Origin = the normal space the window was in (where it returns).
        let from = list.find(x => x.id === this._tags.get(w)) ??
            list.find(x => x.id === this._cur.get(m));
        if (from?.owner)
            from = this._normalFor(list, from);
        const shown = this._tags.get(w) === this._cur.get(m) || w.has_focus();
        const s = this._newSpace(w, from?.id ?? null);
        list.splice(from ? list.indexOf(from) + 1 : list.length, 0, s);
        log.info(`monitor ${m}: own space opened for "${w.get_title()}" (${w.is_fullscreen() ? 'fullscreen' : 'maximized'})`);
        this._tags.set(w, s.id);
        if (shown)
            this._cur.set(m, s.id);
        this._relayout();
        if (shown)
            this._fadeIn(m, FADE_MS, w);
    }

    _closeSpace(m, s) {
        const list = this._spaces.get(m);
        const idx = list.indexOf(s);
        const origin = list.find(x => x.id === s.origin && x !== s) ??
            list.slice(0, idx).reverse().find(x => !x.owner) ??
            list.find(x => !x.owner && x !== s);
        for (const [w, id] of this._tags)
            if (id === s.id)
                this._tags.set(w, origin.id);
        list.splice(idx, 1);
        log.info(`monitor ${m}: own space closed (${s.owner.get_title?.() ?? 'window gone'})`);
        if (this._cur.get(m) === s.id) {
            this._cur.set(m, origin.id);
            return m;
        }
        return null;
    }

    // Drop full-screen spaces whose owner is gone / restored / moved away.
    _cleanupSpaces() {
        const changed = [];
        for (const [m, list] of this._spaces) {
            for (const s of [...list]) {
                if (!s.owner)
                    continue;
                const w = s.owner;
                const alive = this._tags.has(w) && this._eligible(w) &&
                    w.get_monitor() === m && this._wantsOwnSpace(w);
                if (!alive) {
                    const cm = this._closeSpace(m, s);
                    if (cm !== null)
                        changed.push(cm);
                }
            }
        }
        return changed;
    }

    _wantsOwnSpace(w) {
        return w.is_fullscreen() ||
            (this._settings.get_boolean('maximize-to-new-space') && isMaximized(w));
    }

    _queueMaxCheck(w) {
        const info = this._winfo.get(w);
        if (!info || info.idle)
            return;
        info.idle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            info.idle = 0;
            try {
                this._maxCheck(w, info);
            } catch (e) {
                log.error('maximize-check', e);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _maxCheck(w, info) {
        if (!this._eligible(w))
            return;
        const [, owned] = this._spaceOwnedBy(w);
        if (this._wantsOwnSpace(w)) {
            if (owned)
                return;
            // Let a just-opened window finish mapping, then re-check.
            const age = GLib.get_monotonic_time() - info.created;
            if (age < NEW_WINDOW_GRACE) {
                if (!info.graceId)
                    info.graceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                        Math.ceil((NEW_WINDOW_GRACE - age) / 1000), () => {
                            info.graceId = 0;
                            this._queueMaxCheck(w);
                            return GLib.SOURCE_REMOVE;
                        });
                return;
            }
            this._openFullSpace(w);
        } else if (owned) {
            const changed = this._cleanupSpaces();
            this._relayout();
            for (const m of changed)
                this._fadeIn(m, FADE_MS, w);
            w.activate(global.get_current_time());
        }
    }

    // ---- layout ------------------------------------------------------------

    _queueRelayout() {
        if (this._relayoutId)
            return;
        this._relayoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._relayoutId = 0;
            try {
                this._relayout();
            } catch (e) {
                log.error('relayout', e);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _relayout() {
        const time = global.get_current_time();
        this._internal++;
        try {
            while (this._wsm.get_n_workspaces() < 2)
                this._wsm.append_new_workspace(false, time);

            this._cleanupSpaces();

            var pendingMax = [];
            for (const w of this._allWindows()) {
                const m = w.get_monitor();
                const list = this._ensureMonitor(m);
                let tag = this._tags.get(w);
                if (tag === undefined || !list.some(s => s.id === tag)) {
                    tag = this._cur.get(m);
                    this._tags.set(w, tag);
                }
                // macOS rule: a maximized/fullscreen space holds only its owner.
                // Any other window landing there goes to a normal space, and
                // the screen follows it if it was the visible space.
                const sp = list.find(x => x.id === tag);
                if (sp?.owner && sp.owner !== w) {
                    const dest = this._normalFor(list, sp);
                    log.info(`monitor ${m}: "${w.get_title()}" kept out of own space of "${sp.owner.get_title()}"`);
                    tag = dest.id;
                    this._tags.set(w, tag);
                    if (this._cur.get(m) === sp.id && !w.minimized)
                        this._cur.set(m, tag);
                }
                if (!w.minimized && this._wantsOwnSpace(w) && !this._spaceOwnedBy(w)[1])
                    pendingMax.push(w);
                const want = tag === this._cur.get(m) ? STAGE : PARKING;
                if (w.get_workspace().index() !== want)
                    w.change_workspace_by_index(want, false);
            }

            if (this._wsm.get_active_workspace_index() !== STAGE)
                this._wsm.get_workspace_by_index(STAGE).activate(time);
        } finally {
            this._internal--;
        }
        this._updateUi();
        // Maximized windows sharing a space (opened maximized, present at
        // startup, moved here...) get their own space.
        for (const w of pendingMax ?? [])
            this._queueMaxCheck(w);
    }

    // Normal (non-owned) space to use instead of owned space `sp`.
    _normalFor(list, sp) {
        const idx = list.indexOf(sp);
        return list.find(x => x.id === sp.origin && !x.owner) ??
            list.slice(0, idx).reverse().find(x => !x.owner) ??
            list.find(x => !x.owner);
    }

    // Something (C side, e.g. an app requesting focus) switched to parking.
    _onActiveChanged() {
        if (this._internal || this._wsm.get_active_workspace_index() === STAGE)
            return;
        if (this._activeFixId)
            return;
        this._activeFixId = GLib.idle_add(GLib.PRIORITY_HIGH, () => {
            this._activeFixId = 0;
            try {
                const w = global.display.focus_window;
                log.info(`real workspace switched from outside, focus "${w?.get_title() ?? '-'}" — fixing up`);
                if (w && this._tags.has(w))
                    this._reveal(w);
                else
                    this._relayout();
            } catch (e) {
                log.error('active-fix', e);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _safeReveal(w, where) {
        try {
            log.debug(`${where}: reveal "${w.get_title()}"`);
            this._reveal(w);
        } catch (e) {
            log.error(`reveal via ${where}`, e);
        }
    }

    _reveal(w) {
        const m = w.get_monitor();
        const tag = this._tags.get(w);
        if (tag === undefined || this._cur.get(m) === tag ||
            !this._ensureMonitor(m).some(s => s.id === tag)) {
            this._relayout();
            return;
        }
        this._cur.set(m, tag);
        this._relayout();
        this._fadeIn(m, FADE_MS, w);
    }

    // ---- actions -------------------------------------------------------------

    _pointerMonitor() {
        return global.display.get_current_monitor();
    }

    _switchToIndex(m, index, animate = true) {
        const list = this._ensureMonitor(m);
        index = Math.max(0, Math.min(list.length - 1, index));
        if (list[index].id === this._cur.get(m))
            return;
        log.debug(`monitor ${m}: switch to space ${index + 1}/${list.length}`);
        this._cur.set(m, list[index].id);
        this._relayout();
        this._focusTop(m);
        if (animate)
            this._fadeIn(m);
    }

    _switchRelative(dir) {
        const m = this._pointerMonitor();
        this._switchToIndex(m, this._curIndex(m) + dir);
    }

    _moveFocused(dir) {
        const w = global.display.focus_window;
        if (!this._eligible(w) || this._spaceOwnedBy(w)[1])
            return;
        const m = w.get_monitor();
        const list = this._ensureMonitor(m);
        const idx = Math.max(0, Math.min(list.length - 1, this._curIndex(m) + dir));
        const target = list[idx];
        if (target.id === this._cur.get(m) || target.owner)
            return;
        this._tags.set(w, target.id);
        this._cur.set(m, target.id);
        this._relayout();
        this._orig.winActivate.call(w, global.get_current_time());
        this._fadeIn(m, FADE_MS, w);
    }

    _focusTop(m) {
        const ws = this._wsm.get_workspace_by_index(STAGE);
        const w = global.display.get_tab_list(Meta.TabList.NORMAL, ws)
            .find(x => x.get_monitor() === m && !x.minimized);
        if (w)
            this._orig.winActivate.call(w, global.get_current_time());
    }

    // ---- visuals ---------------------------------------------------------------

    _visibleActors(m) {
        return this._allWindows()
            .filter(w => w.get_monitor() === m && w.get_workspace().index() === STAGE && !w.minimized)
            .map(w => w.get_compositor_private())
            .filter(a => a);
    }

    _fadeIn(m, duration = FADE_MS, except = null) {
        const skip = except?.get_compositor_private();
        for (const a of this._visibleActors(m)) {
            if (a === skip)
                continue;
            a.remove_all_transitions();
            a.set_pivot_point(0.5, 0.5);
            a.opacity = 0;
            a.scale_x = a.scale_y = 0.96;
            a.ease({
                opacity: 255, scale_x: 1, scale_y: 1,
                duration: Math.max(duration, 120),
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }

    _restoreActors(actors) {
        for (const a of actors) {
            a.remove_all_transitions();
            a.opacity = 255;
            a.scale_x = a.scale_y = 1;
        }
    }

    // ---- touchpad swipe ----------------------------------------------------------

    _swipeBegin(tracker, monitor) {
        if (monitor < 0)
            monitor = this._pointerMonitor();
        const list = this._ensureMonitor(monitor);
        const idx = this._curIndex(monitor);
        const width = Main.layoutManager.monitors[monitor]?.width ?? 1920;

        if (this._swipe)
            this._restoreActors(this._swipe.actors);

        const actors = this._visibleActors(monitor);
        for (const a of actors) {
            a.remove_all_transitions();
            a.set_pivot_point(0.5, 0.5);
        }
        this._swipe = {monitor, idx, actors};

        tracker.orientation = Clutter.Orientation.HORIZONTAL;
        tracker.confirmSwipe(width, list.map((_, i) => i), idx, idx);
    }

    _swipeUpdate(progress) {
        if (!this._swipe)
            return;
        const d = Math.min(1, Math.abs(progress - this._swipe.idx));
        for (const a of this._swipe.actors) {
            a.opacity = Math.round(255 * (1 - d));
            a.scale_x = a.scale_y = 1 - 0.06 * d;
        }
    }

    _swipeEnd(duration, endProgress) {
        const s = this._swipe;
        this._swipe = null;
        if (!s)
            return;

        const target = Math.round(endProgress);
        if (target === s.idx) {
            for (const a of s.actors) {
                a.ease({
                    opacity: 255, scale_x: 1, scale_y: 1,
                    duration: Math.max(duration, 120),
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            }
            return;
        }

        this._restoreActors(s.actors);
        this._switchToIndex(s.monitor, target, false);
        this._fadeIn(s.monitor, duration);
    }
}

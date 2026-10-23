#!/usr/bin/env python3
"""
MARK pill — a floating attention surface for the runtime's own decisions.

Stolen (in spirit) from the notch-companion idea, deliberately un-Mochi:
it does not decorate. It exists for four moments only:
  1. MARK needs YOU (pending confirmations) — expands instantly with a
     sound, then keeps a quiet pulse until you decide.
  2. Activity pulse — the last thing MARK did, one small line.
  3. Window control — the 'wnd' button: show / maximize / minimize any
     visible X window (same verbs as MARK's desktop.window_* tools).
  4. Nothing to say — a dim dot in the corner. Invisible when idle.

Honest boundaries: read-only polling of GET /api/pill; decisions go through
POST /api/confirmations with the user's token; window control uses the same
reversible xdotool/EWMH verbs, never kills a window's process.
Drag: grab the ● dot. Click the line: expand/collapse. Frameless, sticky,
above everything, skipped by the taskbar.
"""
import glob
import json
import os
import re
import subprocess
import threading
import time

import urllib.request

import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk, GLib, Pango

BASE = os.environ.get('MARK_API', 'http://localhost:3001')
POLL_MS = 3000
COLLAPSE_AFTER = 18.0


def load_token():
    direct = os.environ.get('API_TOKEN', '').strip()
    if direct:
        return direct
    # walk up from cwd like the TS loaders do (npm doesn't export .env)
    here = os.getcwd()
    for _ in range(3):
        p = os.path.join(here, '.env')
        if os.path.isfile(p):
            try:
                for line in open(p, encoding='utf8', errors='ignore'):
                    if line.startswith('API_TOKEN='):
                        return line.split('=', 1)[1].strip()
            except OSError:
                pass
        parent = os.path.dirname(here.rstrip('/') or '/')
        if parent == here:
            break
        here = parent
    return ''


TOKEN = load_token()


def api(path, body=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method='POST' if data else 'GET')
    req.add_header('x-api-token', TOKEN)
    if data:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=6) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        return {'success': False, 'error': str(e)}


# ── window control (same verbs as desktop.window_*, locally) ────────────────
def list_windows():
    try:
        out = subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', '.'],
                             capture_output=True, text=True, timeout=8).stdout
        ids = [i for i in out.split() if i.isdigit()][:25]
    except Exception:
        return []
    rows = []
    for wid in ids:
        title = ''
        try:
            title = subprocess.run(['xdotool', 'getwindowname', wid],
                                   capture_output=True, text=True, timeout=5).stdout.strip()
        except Exception:
            pass
        if title:
            rows.append((wid, title))
    return rows


def window_op(op, wid):
    here = os.path.dirname(os.path.abspath(__file__))
    if op == 'show':
        subprocess.run(['xdotool', 'windowactivate', '--sync', wid], timeout=8)
    elif op == 'minimize':
        subprocess.run(['xdotool', 'windowminimize', wid], timeout=8)
    elif op == 'maximize':
        subprocess.run(['python3', os.path.join(here, 'ewmh.py'), 'maximize', wid], timeout=8)


def alert_sound():
    candidates = (glob.glob('/usr/share/sounds/freedesktop/stereo/*attention*')
                  or glob.glob('/usr/share/sounds/freedesktop/stereo/dialog-*'))
    for c in candidates:
        try:
            subprocess.Popen(['paplay', c],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        except Exception:
            continue


def tool_label(tool_id):
    labels = {
        'desktop.open.thunar': 'Open File Manager',
        'desktop.open.org.xfce.catfish': 'Open File Search',
        'desktop.open.system-config-printer': 'Open Printer Settings',
        'container.restart.jarvis-db': 'Restart Jarvis Database',
    }
    if tool_id in labels:
        return labels[tool_id]
    label = str(tool_id or 'Unknown action').replace('.', ' · ')
    return label[:1].upper() + label[1:]


def confirmation_summary(confirmation):
    reason = str(confirmation.get('reason', ''))
    marker = 'requires explicit confirmation:'
    if marker in reason:
        reason = reason.split(marker, 1)[1].strip()
    match = re.search(r'evaluated as ["\']([^"\']+)["\'] risk', reason, re.IGNORECASE)
    if match:
        return f'Risk: {match.group(1).lower()}. Approve once, or always trust this tool.'
    risk = 'reversible' if 'reversible' in reason.lower() else 'protected'
    return f'Risk: {risk}. {reason[:150]}'


# ── pill ─────────────────────────────────────────────────────────────────────
class Pill(Gtk.Window):
    def __init__(self):
        super().__init__(title='MARK pill')
        self.set_decorated(False)
        self.set_keep_above(True)
        self.set_skip_taskbar_hint(True)
        self.set_skip_pager_hint(True)
        # NOTE: resizable(False) would fix min=max size hints and the WM then
        # clamps every programmatic resize() — the wnd/expand panels would
        # never grow (observed live). Keep resizable; the window is small,
        # undecorated and the panels are the intended size changes.
        self.set_type_hint(Gdk.WindowTypeHint.UTILITY)
        self.set_accept_focus(False)  # never steal keyboard focus; clicks still deliver
        self.stick()
        self.set_opacity(0.9)

        css = Gtk.CssProvider()
        css.load_from_data(b"""
.pill { background: rgba(24,26,32,0.92); border-radius: 18px;
        border: 1px solid rgba(120,180,255,0.30); }
.pilldot { font-size: 14px; color: rgba(150,170,200,0.90); }
.pendingdot { color: rgb(255,190,60); }
.okdot { color: rgb(90,220,140); }
.pilltext { color: rgb(225,235,255); font-size: 11.5px; font-family: monospace; }
.cardhead { color: rgb(255,205,120); font-size: 11.5px; font-weight: 600; }
.cardbody { color: rgb(210,220,240); font-size: 10.5px; }
.muted { color: rgb(160,175,200); font-size: 10.5px; }
.btn { border-radius: 10px; padding: 1px 7px; font-size: 10px; }
.allow { color: rgb(120,235,165); }
.deny { color: rgb(255,145,145); }
.always { color: rgb(155,205,255); }
""")
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

        self.expanded = False
        self.pending_ids = set()
        self.collapse_at = 0.0
        self.windows_shown = False
        self.windows_dirty = True

        self.box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.box.get_style_context().add_class('pill')
        self.box.set_margin_start(10)
        self.box.set_margin_end(10)
        self.box.set_margin_top(5)
        self.box.set_margin_bottom(7)
        self.add(self.box)

        strip = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        strip.set_margin_start(4)
        self.box.pack_start(strip, False, False, 0)

        self.dot = Gtk.EventBox()
        dot_label = Gtk.Label(label='●')
        dot_label.get_style_context().add_class('pilldot')
        self.dot.add(dot_label)
        self._dot_label = dot_label
        # the dot is the drag handle
        self.dot.connect('button-press-event', self.on_drag_press)
        strip.pack_start(self.dot, False, False, 0)

        self.line = Gtk.EventBox()
        self._line_label = Gtk.Label(label='MARK is watching')
        self._line_label.set_ellipsize(Pango.EllipsizeMode.END)
        self._line_label.set_max_width_chars(40)
        self._line_label.set_xalign(0)
        self._line_label.get_style_context().add_class('pilltext')
        self.line.add(self._line_label)
        self.line.connect('button-press-event', self.on_line_press)
        strip.pack_start(self.line, True, True, 0)

        self.win_btn = Gtk.Button(label='▣')
        self.win_btn.set_relief(Gtk.ReliefStyle.NONE)
        self.win_btn.get_style_context().add_class('btn')
        self.win_btn.set_tooltip_text('Window controls: show · maximize · minimize')
        self.win_btn.connect('clicked', self.toggle_windows)
        strip.pack_end(self.win_btn, False, False, 0)

        quit_btn = Gtk.Button(label='×')
        quit_btn.set_relief(Gtk.ReliefStyle.NONE)
        quit_btn.get_style_context().add_class('btn')
        quit_btn.set_tooltip_text('Hide the pill (relaunch with npm run pill)')
        quit_btn.connect('clicked', lambda _b: Gtk.main_quit())
        strip.pack_end(quit_btn, False, False, 0)

        self.detail = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=5)
        self.detail.set_visible(False)
        self.box.pack_start(self.detail, False, False, 0)

        self.windows_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        self.windows_box.set_visible(False)
        self.box.pack_start(self.windows_box, False, False, 0)

        self.resize(340, 44)
        GLib.idle_add(self.poll_once)
        GLib.timeout_add(POLL_MS, self.poll_tick)
        GLib.timeout_add(1500, self.collapse_tick)

        # QA hook: PILL_TEST=1 spawns a throwaway instance at (600,300) with
        # the window panel pre-opened, so the wnd rendering path can be
        # screenshot-verified without hand interaction.
        if os.environ.get('PILL_TEST'):
            self.move(600, 300)
            GLib.timeout_add(1200, self._wc_test)  # pending ask → goto False

    def _wc_test(self):
        self.toggle_windows(None)
        return False

    # ── drag handling ────────────────────────────────────────────────────────
    def on_drag_press(self, widget, event):
        if event.button == 1:
            self.begin_move_drag(event.button,
                                 int(event.x_root), int(event.y_root),
                                 event.time)

    def on_line_press(self, widget, event):
        if event.button == 1 and self.windows_shown is False:
            self.set_expanded(not self.expanded)

    # ── expansion ────────────────────────────────────────────────────────────
    def set_expanded(self, expanded):
        self.expanded = expanded
        self.collapse_at = time.monotonic() + COLLAPSE_AFTER if expanded else 0.0
        self.detail.set_visible(expanded)
        GLib.idle_add(self._resize_to_content)

    def _resize_to_content(self):
        loriz, h = self.get_size()
        if self.expanded or self.windows_shown:
            req = self.detail.get_preferred_size()[0].height * (self.detail.get_visible() and 1 or 0)
            wh = self.windows_box.get_preferred_size()[0].height * (self.windows_shown and 1 or 0)
            self.resize(360, max(44, 44 + req + wh + 8))
        else:
            self.resize(340, 44)
        return False

    def collapse_tick(self):
        if self.expanded and self.collapse_at and time.monotonic() > self.collapse_at:
            self.set_expanded(False)
        return True

    # ── poll ─────────────────────────────────────────────────────────────────
    def poll_tick(self):
        self.poll_once()
        return True

    def poll_once(self):
        threading.Thread(target=self._bg_poll, daemon=True).start()
        return False

    def _bg_poll(self):
        data = api('/api/pill')
        if not data.get('success'):
            GLib.idle_add(self._render_offline, str(data.get('error', 'unreachable')))
            return
        GLib.idle_add(self._render, data)

    def _render_offline(self, err):
        self._dot_state('offline')
        self._line_label.set_text('MARK is offline · click to retry')
        return False

    # ── render ───────────────────────────────────────────────────────────────
    GLYPHS = {'ok': '●', 'error': '✖', 'refused': '⊘', 'pending': '⏳'}

    def _dot_state(self, cls):
        label = self._dot_label.get_style_context()
        for c in ('pendingdot', 'okdot'):
            label.remove_class(c)
        if cls:
            label.add_class(cls)

    def _render(self, data):
        pending = data.get('confirmations') or []
        activity = data.get('activity') or []
        stale_count = int(data.get('staleCount') or 0)
        pending_ids = {str(c.get('id')) for c in pending}
        fresh = pending_ids - self.pending_ids
        self.pending_ids = pending_ids

        if pending:
            self._dot_state('pendingdot')
            self._line_label.set_text(f'{len(pending)} decision{"s" if len(pending) != 1 else ""} need you')
            if fresh:
                if not self.expanded:
                    self.set_expanded(True)
                alert_sound()
                # demand attention briefly; no focus steal beyond present
                self.present_with_time(Gdk.CURRENT_TIME)
                self.set_opacity(1.0)
        else:
            if activity:
                a = activity[0]
                self._dot_state('okdot' if a.get('status') == 'ok' else None)
                verb = 'Done' if a.get('status') == 'ok' else 'Needs attention'
                self._line_label.set_text(f"{verb} · {a.get('command','')[:40]}")
            else:
                for c in ('okdot',):
                    self._dot_label.get_style_context().remove_class(c)
                self._line_label.set_text('MARK is idle')

        self._render_detail(pending, activity, stale_count)
        self._refresh_windows()
        return False

    def _render_detail(self, pending, activity, stale_count=0):
        for child in self.detail.get_children():
            self.detail.remove(child)

        if pending:
            head = Gtk.Label(label=f'{len(pending)} decision{"s" if len(pending) != 1 else ""} need your attention')
            head.set_xalign(0)
            head.get_style_context().add_class('cardhead')
            self.detail.pack_start(head, False, False, 0)

            if stale_count:
                backlog = Gtk.Label(label=f'{stale_count} older decision{"s" if stale_count != 1 else ""} kept in the backlog')
                backlog.set_xalign(0)
                backlog.set_line_wrap(True)
                backlog.get_style_context().add_class('muted')
                self.detail.pack_start(backlog, False, False, 0)

            for c in pending[:3]:
                row = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
                title = Gtk.Label(label=tool_label(c.get('toolId', '')))
                title.set_xalign(0)
                title.get_style_context().add_class('cardhead')
                reason = Gtk.Label(label=confirmation_summary(c))
                reason.set_xalign(0)
                reason.set_line_wrap(True)
                reason.get_style_context().add_class('cardbody')
                row.pack_start(title, False, False, 0)
                row.pack_start(reason, False, False, 0)

                btns = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
                cid = str(c.get('id', ''))

                def send_decision(_b, approved, _cid=cid, _always=False):
                    threading.Thread(
                        target=api, daemon=True,
                        args=('/api/confirmations',
                              {'confirmationId': _cid, 'approved': approved,
                               'always': _always})).start()

                allow = Gtk.Button(label='✔ Allow')
                allow.get_style_context().add_class('btn')
                allow.get_style_context().add_class('allow')
                allow.connect('clicked', lambda b: (send_decision(b, True), self.set_expanded(False)))
                btns.pack_start(allow, False, False, 0)

                always = Gtk.Button(label='Always')
                always.set_tooltip_text('Allow this tool automatically in future')
                always.get_style_context().add_class('btn')
                always.get_style_context().add_class('always')
                always.connect('clicked', lambda b: (send_decision(b, True, _always=True), self.set_expanded(False)))
                btns.pack_start(always, False, False, 0)

                deny = Gtk.Button(label='✘ Deny')
                deny.get_style_context().add_class('btn')
                deny.get_style_context().add_class('deny')
                deny.connect('clicked', lambda b: (send_decision(b, False), self.set_expanded(False)))
                btns.pack_start(deny, False, False, 0)
                row.pack_start(btns, False, False, 0)
                self.detail.pack_start(row, False, False, 0)
        elif activity:
            head = Gtk.Label(label='recent · click line to hide')
            head.set_xalign(0)
            head.get_style_context().add_class('muted')
            self.detail.pack_start(head, False, False, 0)
            for a in activity[:5]:
                row = Gtk.Label(
                    label=f"{a.get('status','ok'):7} {str(a.get('route',''))[:9]:9} {str(a.get('command',''))[:34]}")
                row.set_xalign(0)
                row.get_style_context().add_class('cardbody')
                self.detail.pack_start(row, False, False, 0)

        # only surface children when the panel itself is open; a blind
        # show_all() here would force the detail panel open every poll
        if self.detail.get_visible():
            self.detail.show_all()
        self._resize_to_content()

    # ── windows section ──────────────────────────────────────────────────────
    def toggle_windows(self, _btn):
        self.windows_shown = not self.windows_shown
        self.windows_box.set_visible(self.windows_shown)
        if self.windows_shown:
            # fill now — waiting for the next 3s poll made the panel feel dead
            threading.Thread(target=self._bg_windows, daemon=True).start()
            self.windows_dirty = False
        self._resize_to_content()

    def _refresh_windows(self):
        if self.windows_shown and self.windows_dirty:
            self.windows_dirty = False
            threading.Thread(target=self._bg_windows, daemon=True).start()

    def _bg_windows(self):
        rows = list_windows()
        GLib.idle_add(self._fill_windows, rows)

    def _fill_windows(self, rows):
        for child in self.windows_box.get_children():
            self.windows_box.remove(child)
        head = Gtk.Label(label='windows · show / max / min')
        head.set_xalign(0)
        head.get_style_context().add_class('muted')
        self.windows_box.pack_start(head, False, False, 0)
        for wid, title in rows[:12]:
            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=3)
            label = Gtk.Label(label=f'{title[:30]}')
            label.set_xalign(0)
            label.set_ellipsize(Pango.EllipsizeMode.END)
            label.get_style_context().add_class('cardbody')
            row.pack_start(label, True, True, 0)
            for op in ('show', 'max', 'min'):
                b = Gtk.Button(label='↑' if op == 'show' else '□' if op == 'max' else '─')
                b.set_relief(Gtk.ReliefStyle.NONE)
                b.get_style_context().add_class('btn')
                b.set_tooltip_text(op)
                b.connect('clicked', lambda _b, o=op, _w=wid: window_op(o, _w))
                row.pack_end(b, False, False, 0)
            self.windows_box.pack_start(row, False, False, 0)
        if self.windows_box.get_visible():
            self.windows_box.show_all()
        self._resize_to_content()
        return False


def main():
    import signal
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    pill = Pill()
    pill.show_all()
    Gtk.main()


if __name__ == '__main__':
    main()


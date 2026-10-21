#!/usr/bin/env python3
"""
EWMH window-state helper for MARK (no wmctrl on this machine, xdotool has no
maximize). Speaks Extended Window Manager Hints directly to the running WM
(xfwm4 et al.) with a small ctypes X11 ClientMessage — the same thing wmctrl
does.

Usage:
  ewmh.py maximize <window-id>            # add vert+horz maximize
  ewmh.py restore  <window-id>            # remove both (unmaximize)
Exit 0 on success, 1 with a message when the WM/display refuses.
"""
import ctypes
import sys

TYPE = 33  # X ClientMessage
SUBSTRUCTURE_REDIRECT = 1 << 20
SUBSTRUCTURE_NOTIFY = 1 << 19
_STATE_ADD, _STATE_REMOVE = 1, 0


class _ClientMessageEvent(ctypes.Structure):
    # Wire-relevant prefix of XEvent; cast into a full 192-byte XEvent buffer.
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("window", ctypes.c_ulong),
        ("message_type", ctypes.c_ulong),
        ("format", ctypes.c_int),
        ("data", ctypes.c_long * 5),
    ]


def _atom(x11, dpy, name):
    x11.XInternAtom.restype = ctypes.c_ulong
    x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    return x11.XInternAtom(dpy, name.encode(), False)


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in ("maximize", "restore"):
        print("usage: ewmh.py maximize|restore <window-id>", file=sys.stderr)
        return 1
    try:
        wid = int(sys.argv[2])
    except ValueError:
        print(f"invalid window id: {sys.argv[2]}", file=sys.stderr)
        return 1

    try:
        x11 = ctypes.CDLL("libX11.so.6")
    except OSError as e:
        print(f"libX11 unavailable: {e}", file=sys.stderr)
        return 1

    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    dpy = x11.XOpenDisplay(None)
    if not dpy:
        print("cannot open X display (DISPLAY is not accessible from here)", file=sys.stderr)
        return 1

    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    root = x11.XDefaultRootWindow(dpy)  # client messages are sent TO the root

    action = _STATE_ADD if sys.argv[1] == "maximize" else _STATE_REMOVE
    # EWMH _NET_WM_STATE: serde — the WINDOW field of the event carries the
    # target window; data.l[0]=action, l[1]/l[2]=the state atoms, l[3]=source.
    vert = _atom(x11, dpy, "_NET_WM_STATE_MAXIMIZED_VERT")
    horz = _atom(x11, dpy, "_NET_WM_STATE_MAXIMIZED_HORZ")
    state_atom = _atom(x11, dpy, "_NET_WM_STATE")

    buf = (ctypes.c_char * 192)()  # sizeof(XEvent) on x86_64
    ev = ctypes.cast(buf, ctypes.POINTER(_ClientMessageEvent)).contents
    ev.type = TYPE
    ev.send_event = True
    ev.display = dpy
    ev.window = wid            # target window in the window field (EWMH)
    ev.message_type = state_atom
    ev.format = 32
    ev.data[0] = action        # _NET_WM_STATE_ADD / _NET_WM_STATE_REMOVE
    ev.data[1] = vert
    ev.data[2] = horz
    ev.data[3] = 0             # source indication: normal application

    x11.XSendEvent.restype = ctypes.c_int
    x11.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong,
                               ctypes.c_int, ctypes.c_long, ctypes.c_void_p]
    sent = x11.XSendEvent(dpy, root, False,
                          SUBSTRUCTURE_REDIRECT | SUBSTRUCTURE_NOTIFY,
                          ctypes.cast(buf, ctypes.c_void_p))
    x11.XFlush(dpy)
    if not sent:
        print("XSendEvent refused (WM may not support _NET_WM_STATE)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

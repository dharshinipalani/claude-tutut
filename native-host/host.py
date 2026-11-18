#!/usr/bin/python3
"""
tutut — Native Messaging Host for Claude Permission Watcher

Chrome extension  ⇄  this host  ⇄  the tutut island on your desktop.

Chrome Native Messaging protocol: 4-byte little-endian length + JSON,
over stdin/stdout. Logs go to stderr.

The island is a borderless, transparent, always-on-top GTK window that
never takes focus, with a WebKit view showing ui/island.html (the
character + Allow/Deny buttons). On GNOME/Wayland it runs through XWayland
(GDK_BACKEND=x11) so it can sit at the top-centre and stay above other
windows. If GTK/WebKit aren't available it falls back to a Tkinter popup.

Usage:
  host.py            — started by Chrome
  host.py --demo     — show sample requests without Chrome (for testing/design)
  TUTUT_UI=tk        — force the Tkinter fallback
  TUTUT_DEBUG=1      — enable the WebKit inspector (right-click → Inspect)
"""

import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
UI_DIR = os.path.join(HERE, "ui")
CHAR_DIR = os.path.join(UI_DIR, "character")

# ----------------------------------------------------------
# CHROME NATIVE MESSAGING I/O
# ----------------------------------------------------------

def read_message():
    """Read a single message from Chrome (stdin)."""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        return None
    length = struct.unpack("<I", raw_length)[0]
    if length == 0:
        return None
    raw_message = sys.stdin.buffer.read(length)
    return json.loads(raw_message.decode("utf-8"))


def send_message(message):
    """Send a single message to Chrome (stdout)."""
    encoded = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


LOG_FILE = os.path.join(HERE, "tutut.log")


def log(msg):
    """Log to stderr and native-host/tutut.log (stdout belongs to Chrome)."""
    line = f"[tutut] {msg}"
    sys.stderr.write(line + "\n")
    sys.stderr.flush()
    try:
        import time
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 512_000:
            os.replace(LOG_FILE, LOG_FILE + ".old")
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(time.strftime("%H:%M:%S ") + line + "\n")
    except OSError:
        pass


# ----------------------------------------------------------
# REQUEST QUEUE — toolkit-free; one request on screen at a time
# ----------------------------------------------------------

def request_from_message(message):
    """Turn a Chrome message into a request dict, or None."""
    t = message.get("type")
    if t == "PERMISSION_REQUEST":
        return {
            "kind": "permission",
            "dialogId": message.get("dialogId", "unknown"),
            "tool": message.get("tool", "a tool"),
            "fullText": message.get("fullText", ""),
            "timestamp": message.get("timestamp", ""),
            "hasAllowOnce": message.get("hasAllowOnce", True) is not False,
            "hasAlways": bool(message.get("hasAlways")),
        }
    if t == "INPUT_NEEDED":
        return {
            "kind": "input",
            "dialogId": message.get("dialogId", "unknown"),
            "tool": message.get("tool", "a chat"),
            "fullText": message.get("fullText", ""),
            "timestamp": message.get("timestamp", ""),
        }
    return None


class RequestQueue:
    """Shows one request at a time; the rest wait in line.

    on_show(req, queued_count) and on_hide() are called on the UI thread.
    """

    def __init__(self, on_show, on_hide, send=send_message):
        self.on_show = on_show
        self.on_hide = on_hide
        self.send = send
        self.current = None
        self.waiting = []

    def _known(self, dialog_id):
        return (self.current and self.current["dialogId"] == dialog_id) or any(
            w["dialogId"] == dialog_id for w in self.waiting
        )

    def enqueue(self, req):
        if self._known(req["dialogId"]):
            return
        if self.current is None:
            self.current = req
            self.on_show(req, len(self.waiting))
        else:
            self.waiting.append(req)
            self.on_show(self.current, len(self.waiting))  # refresh "+N more"

    def dismiss(self, dialog_id):
        """Answered elsewhere (on the page) — drop it."""
        self.waiting = [w for w in self.waiting if w["dialogId"] != dialog_id]
        if self.current and self.current["dialogId"] == dialog_id:
            self._next()
        elif self.current:
            self.on_show(self.current, len(self.waiting))

    def decide(self, dialog_id, decision):
        """The user clicked a button on the island."""
        if not self.current or self.current["dialogId"] != dialog_id:
            log(f"Ignoring stale decision for {dialog_id}")
            return
        self.send({"type": "DECISION", "dialogId": dialog_id, "decision": decision})
        log(f"Sent decision: {decision} for {dialog_id}")
        self._next()

    def _next(self):
        self.current = None
        if self.waiting:
            self.current = self.waiting.pop(0)
            self.on_show(self.current, len(self.waiting))
        else:
            self.on_hide()


# ----------------------------------------------------------
# CHARACTER — built-in SVG, or the user's own tutut image
# ----------------------------------------------------------

IMAGE_EXTS = ("png", "webp", "gif", "svg", "jpg", "jpeg")
MOODS = ("alert", "waiting", "yes", "no")


def character_config():
    """Pick the character: character/tutut.<ext> wins over default.svg."""
    def find(name):
        for ext in IMAGE_EXTS:
            p = os.path.join(CHAR_DIR, f"{name}.{ext}")
            if os.path.isfile(p):
                return p
        return None

    custom = find("tutut")
    if custom:
        uri = "file://" + custom
        states = {m: "file://" + p for m in MOODS if (p := find(f"tutut-{m}"))}
        masked = custom.lower().endswith((".jpg", ".jpeg"))  # no transparency
        if custom.endswith(".svg") and not states:
            with open(custom, encoding="utf-8") as f:
                return {"svg": f.read()}  # inline so ear/eye ids can animate
        return {"image": uri, "states": states, "masked": masked}

    with open(os.path.join(CHAR_DIR, "default.svg"), encoding="utf-8") as f:
        return {"svg": f.read()}


def play_sound():
    """A short chime, if the desktop has one. Never blocks."""
    try:
        if shutil.which("canberra-gtk-play"):
            subprocess.Popen(["canberra-gtk-play", "-i", "message-new-instant"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif shutil.which("paplay"):
            snd = "/usr/share/sounds/freedesktop/stereo/message-new-instant.oga"
            if os.path.exists(snd):
                subprocess.Popen(["paplay", snd],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


# ----------------------------------------------------------
# UI 1: the tutut island (GTK3 + WebKit2)
# ----------------------------------------------------------

def load_gtk():
    if os.environ.get("TUTUT_UI") == "tk":
        return None
    # XWayland: only X11 windows may choose their position and stay on top on GNOME
    os.environ["GDK_BACKEND"] = "x11"
    os.environ.setdefault("DISPLAY", ":0")
    try:
        import gi
        gi.require_version("Gtk", "3.0")
        gi.require_version("Gdk", "3.0")
        gi.require_version("WebKit2", "4.1")
        from gi.repository import Gdk, GLib, Gtk, WebKit2
        ok, _ = Gtk.init_check(sys.argv)
        if not ok:
            log("GTK could not open a display")
            return None
        return Gdk, GLib, Gtk, WebKit2
    except Exception as e:
        log(f"GTK/WebKit unavailable ({e}); using Tkinter fallback")
        return None


class IslandUI:
    WIDTH, HEIGHT = 680, 240   # room for the card + its shadow; the rest is click-through

    def __init__(self, mods):
        self.Gdk, self.GLib, self.Gtk, self.WebKit2 = mods
        Gdk, Gtk, WebKit2 = self.Gdk, self.Gtk, self.WebKit2
        self.queue = None
        self.page_ready = False
        self.pending_js = []
        self.shown_id = None

        win = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
        win.set_title("tutut")
        win.set_decorated(False)
        win.set_resizable(False)
        win.set_default_size(self.WIDTH, self.HEIGHT)
        win.set_keep_above(True)
        win.set_accept_focus(False)       # never steal the keyboard
        win.set_focus_on_map(False)
        win.set_skip_taskbar_hint(True)
        win.set_skip_pager_hint(True)
        win.set_type_hint(Gdk.WindowTypeHint.DOCK)
        win.stick()                        # on every workspace
        win.set_app_paintable(True)
        visual = win.get_screen().get_rgba_visual()
        if visual is not None:
            win.set_visual(visual)         # per-pixel transparency
        else:
            log("No RGBA visual (no compositor?) — corners won't be transparent")
        win.connect("draw", self._clear_background)
        self.win = win

        manager = WebKit2.UserContentManager()
        manager.connect("script-message-received::tutut", self._on_page_message)
        manager.register_script_message_handler("tutut")
        view = WebKit2.WebView.new_with_user_content_manager(manager)
        view.set_background_color(Gdk.RGBA(0, 0, 0, 0))
        settings = view.get_settings()
        settings.set_allow_file_access_from_file_urls(True)
        if os.environ.get("TUTUT_DEBUG"):
            settings.set_enable_developer_extras(True)
        else:
            view.connect("context-menu", lambda *a: True)  # no right-click menu
        view.load_uri("file://" + os.path.join(UI_DIR, "island.html"))
        win.add(view)
        view.show()
        self.view = view

    # -- window plumbing --
    @staticmethod
    def _clear_background(_widget, cr):
        import cairo
        cr.set_source_rgba(0, 0, 0, 0)
        cr.set_operator(cairo.OPERATOR_SOURCE)
        cr.paint()
        cr.set_operator(cairo.OPERATOR_OVER)
        return False

    def _place(self):
        """Top-centre of the monitor the pointer is on, under the top bar."""
        display = self.Gdk.Display.get_default()
        monitor = None
        try:
            _, x, y = display.get_default_seat().get_pointer().get_position()
            monitor = display.get_monitor_at_point(x, y)
        except Exception:
            pass
        monitor = monitor or display.get_primary_monitor() or display.get_monitor(0)
        area = monitor.get_workarea()  # excludes GNOME's top bar
        self.win.move(area.x + (area.width - self.WIDTH) // 2, area.y)

    def _set_click_area(self, r):
        """Clicks outside the card fall through to the window underneath."""
        try:
            import cairo
            gdk_win = self.win.get_window()
            if gdk_win is None:
                return
            rect = cairo.RectangleInt(int(r["x"]), int(r["y"]), int(r["w"]), int(r["h"]))
            gdk_win.input_shape_combine_region(cairo.Region(rect), 0, 0)
        except Exception as e:
            log(f"Could not set click area: {e}")

    def _js(self, code):
        if not self.page_ready:
            self.pending_js.append(code)
            return
        if hasattr(self.view, "evaluate_javascript"):
            self.view.evaluate_javascript(code, -1, None, None, None, None, None)
        else:
            self.view.run_javascript(code, None, None, None)

    def _on_page_message(self, _manager, result):
        try:
            value = result.get_js_value() if hasattr(result, "get_js_value") else result
            msg = json.loads(value.to_string())
        except Exception as e:
            log(f"Bad message from page: {e}")
            return
        t = msg.get("type")
        if t == "ready":
            self.page_ready = True
            self._js(f"tutut.setCharacter({json.dumps(character_config())})")
            pending, self.pending_js = self.pending_js, []
            for code in pending:
                self._js(code)
        elif t == "decision" and self.queue:
            self.queue.decide(msg.get("dialogId"), msg.get("decision"))
        elif t == "size":
            self._set_click_area(msg)
        elif t == "hidden":
            if self.queue is None or self.queue.current is None:
                self.win.hide()  # nothing on screen → no window, no CPU

    # -- interface used by RequestQueue --
    def show(self, req, queued):
        payload = dict(req, queued=queued)
        if self.shown_id != req["dialogId"]:
            self.shown_id = req["dialogId"]
            play_sound()
        if not self.win.get_visible():
            self._place()
            self.win.show()
        self._js(f"tutut.show({json.dumps(payload)})")

    def hide(self):
        self.shown_id = None
        self._js("tutut.hide()")

    def call_soon(self, fn, *args):
        def run():
            fn(*args)
            return False
        self.GLib.idle_add(run)

    def run(self):
        self.Gtk.main()

    def quit(self):
        self.Gtk.main_quit()


# ----------------------------------------------------------
# UI 2: fallback popup (Tkinter) — used only if GTK/WebKit are missing
# ----------------------------------------------------------

class TkUI:
    def __init__(self):
        import tkinter as tk
        self.tk = tk
        self.queue = None
        root = tk.Tk()
        root.withdraw()
        root.title("tutut")
        root.overrideredirect(True)
        root.attributes("-topmost", True)
        try:
            root.attributes("-type", "notification")
        except tk.TclError:
            pass
        root.configure(bg="#0d0e12")
        w, h = 520, 170
        root.geometry(f"{w}x{h}+{(root.winfo_screenwidth() - w) // 2}+40")
        self.root = root

        frame = tk.Frame(root, bg="#0d0e12", padx=18, pady=14)
        frame.pack(fill="both", expand=True)
        self.title = tk.Label(frame, fg="#ff9f43", bg="#0d0e12", anchor="w",
                              font=("Helvetica", 13, "bold"))
        self.title.pack(fill="x")
        self.body = tk.Label(frame, fg="#9a9cab", bg="#0d0e12", anchor="w", justify="left",
                             wraplength=480, font=("Helvetica", 11))
        self.body.pack(fill="x", pady=(6, 12))
        row = tk.Frame(frame, bg="#0d0e12")
        row.pack(fill="x")

        def mk(text, bg, fg="white"):
            return tk.Button(row, text=text, bg=bg, fg=fg, relief="flat", padx=16, pady=6,
                             font=("Helvetica", 11, "bold"), activebackground=bg)
        self.yes = mk("Allow once", "#f6f6f8", "#111")
        self.always = mk("Always allow", "#262833")
        self.no = mk("Deny", "#262833")
        self.yes.pack(side="right")
        self.no.pack(side="left")

    def _decide(self, decision):
        if self.queue and self.queue.current:
            self.queue.decide(self.queue.current["dialogId"], decision)

    def show(self, req, queued):
        more = f"   (+{queued} more)" if queued else ""
        self.always.pack_forget()
        if req["kind"] == "input":
            self.title.config(text=f"Claude needs your input{more}")
            self.body.config(text=f"Chat: {req['tool']}")
            self.yes.config(text="Open chat", command=lambda: self._decide("open"))
            self.no.config(text="Dismiss", command=lambda: self._decide("dismiss"))
        else:
            self.title.config(text=f"Claude wants to use {req['tool']}{more}")
            self.body.config(text=req["fullText"][:160])
            once = req.get("hasAllowOnce", True)
            self.yes.config(text="Allow once" if once else "Always allow",
                            command=lambda: self._decide("allow"))
            self.no.config(text="Deny", command=lambda: self._decide("deny"))
            if once and req.get("hasAlways"):
                self.always.config(command=lambda: self._decide("always"))
                self.always.pack(side="right", padx=(0, 8))
        self.root.deiconify()
        self.root.lift()

    def hide(self):
        self.root.withdraw()

    def call_soon(self, fn, *args):
        self.root.after(0, fn, *args)

    def run(self):
        self.root.mainloop()

    def quit(self):
        self.root.quit()


# ----------------------------------------------------------
# MAIN
# ----------------------------------------------------------

def stdin_reader(ui, queue):
    """Read Chrome messages on a background thread; hand them to the UI thread."""
    while True:
        try:
            message = read_message()
        except Exception as e:
            log(f"Error reading message: {e}")
            message = None
        if message is None:
            log("Chrome disconnected (stdin closed)")
            ui.call_soon(ui.quit)
            return
        log(f"Received: {message.get('type')} {message.get('dialogId', '')}")
        req = request_from_message(message)
        if req:
            ui.call_soon(queue.enqueue, req)
        elif message.get("type") == "DISMISS":
            ui.call_soon(queue.dismiss, message.get("dialogId"))


def demo_requests():
    return [
        {"type": "PERMISSION_REQUEST", "dialogId": "demo_1", "tool": "Search files (Google Drive)",
         "fullText": "Claude wants to use Search files from Google Drive Query modifiedTime >= "
                     "'2026-11-01' and owner = 'me' Order by modifiedTime desc Page size 25",
         "hasAllowOnce": True, "hasAlways": True},
        {"type": "INPUT_NEEDED", "dialogId": "demo_2", "tool": "Google Drive files this month",
         "fullText": "Claude is waiting for your input in this chat."},
        {"type": "PERMISSION_REQUEST", "dialogId": "demo_3", "tool": "Send email (Gmail)",
         "fullText": "Claude wants to use Send email from Gmail To: team@example.com",
         "hasAllowOnce": True, "hasAlways": False},
    ]


def main():
    demo = "--demo" in sys.argv
    signal.signal(signal.SIGINT, signal.SIG_DFL)  # Ctrl+C quits even inside Gtk.main()
    log("Starting" + (" (demo)" if demo else "") +
        f" pid={os.getpid()} DISPLAY={os.environ.get('DISPLAY')} "
        f"WAYLAND={os.environ.get('WAYLAND_DISPLAY')} XAUTH={'yes' if os.environ.get('XAUTHORITY') else 'no'}")

    mods = load_gtk()
    try:
        ui = IslandUI(mods) if mods else TkUI()
    except Exception as e:
        log(f"Cannot open a window on the screen: {e}")
        log("Run this as the user logged into the desktop (the one running Chrome), "
            "from a terminal on that desktop — not over ssh or as another user.")
        sys.exit(1)

    send = (lambda m: print(f"→ Chrome would receive: {m}", flush=True)) if demo else send_message
    queue = RequestQueue(ui.show, ui.hide, send)
    ui.queue = queue

    if demo:
        def feed():
            for m in demo_requests():
                queue.enqueue(request_from_message(m))
        ui.call_soon(feed)
        print("Demo: answer the island's buttons; Ctrl+C to quit.", flush=True)
    else:
        threading.Thread(target=stdin_reader, args=(ui, queue), daemon=True).start()

    log(f"Ready ({type(ui).__name__}). Waiting for requests…")
    try:
        ui.run()
    except KeyboardInterrupt:
        pass
    log("Shutting down")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        log("CRASH:\n" + traceback.format_exc())
        raise

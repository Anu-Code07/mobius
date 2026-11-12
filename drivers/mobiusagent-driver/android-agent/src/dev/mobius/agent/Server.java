package dev.mobius.agent;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.HandlerThread;
import android.os.Looper;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Mobius on-device helper. Runs as shell via `app_process` (the same way Android's own `uiautomator` tool runs),
 * holds one UiAutomation connection open, and answers screen reads over a local socket in milliseconds instead of
 * paying uiautomator's multi-second start-up on every read.
 *
 *   adb shell CLASSPATH=/data/local/tmp/mobius-agent.dex app_process / dev.mobius.agent.Server
 *   adb forward tcp:PORT localabstract:mobius-agent
 *   → "ping\n"  ← "pong\n"
 *   → "dump\n"  ← one JSON line: {"windows":[...], "width":W, "height":H, "foregroundApp":"pkg"}
 */
public final class Server {
    static final String SOCKET = "mobius-agent";
    static final int FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES = 1; // keep TalkBack etc. running

    static String version = "";

    public static void main(String[] args) throws Exception {
        if (args.length > 0) version = args[0];
        // A bare app_process has no main Looper; the accessibility client needs one to exist (it never has to loop).
        if (Looper.getMainLooper() == null) Looper.prepareMainLooper();
        HandlerThread ht = new HandlerThread("mobius-agent");
        ht.start();
        UiAutomation ua = connect(ht.getLooper());
        AccessibilityServiceInfo info = ua.getServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
                | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        ua.setServiceInfo(info);

        LocalServerSocket server = new LocalServerSocket(SOCKET);
        System.out.println("mobius-agent ready");
        // One thread per client: a second process (CLI next to a long-lived server) must not wait on the first one's
        // open connection. Commands share one UiAutomation, so they run one at a time; ping answers without the lock.
        final Object lock = new Object();
        while (true) {
            final LocalSocket s = server.accept();
            Thread t = new Thread(() -> serve(s, ua, lock), "mobius-client");
            t.setDaemon(true);
            t.start();
        }
    }

    static void serve(LocalSocket s, UiAutomation ua, Object lock) {
        try (LocalSocket sock = s) {
            BufferedReader in = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8));
            OutputStream out = sock.getOutputStream();
            String line;
            while ((line = in.readLine()) != null) {
                String cmd = line.trim();
                String resp;
                if ("ping".equals(cmd)) resp = "pong " + version;
                else synchronized (lock) { resp = handle(ua, cmd); }
                out.write((resp + "\n").getBytes(StandardCharsets.UTF_8));
                out.flush();
            }
        } catch (Throwable ignored) {
            // client went away
        }
    }

    static String handle(UiAutomation ua, String cmd) {
        try {
            return "dump".equals(cmd) ? dump(ua).toString()
                    : cmd.startsWith("text ") ? setText(ua, b64(cmd.substring(5)), false).toString()
                    : cmd.startsWith("fill ") ? setText(ua, b64(cmd.substring(5)), true).toString()
                    : "fill".equals(cmd) ? setText(ua, "", true).toString()
                    : cmd.startsWith("shot ") ? shot(ua, Integer.parseInt(cmd.substring(5).trim())).toString()
                    : "clip_get".equals(cmd) ? clipGet().toString()
                    : cmd.startsWith("clip_set ") ? clipSet(b64(cmd.substring(9))).toString()
                    : cmd.startsWith("pinch ") ? pinch(ua, cmd.substring(6).trim().split(" ")).toString()
                    : cmd.startsWith("tap ") ? tap(ua, cmd.substring(4).trim().split(" ")).toString()
                    : cmd.startsWith("swipe ") ? swipe(ua, cmd.substring(6).trim().split(" ")).toString()
                    : cmd.startsWith("keys ") ? keys(ua, b64(cmd.substring(5))).toString()
                    : cmd.startsWith("key ") ? key(ua, Integer.parseInt(cmd.substring(4).trim())).toString()
                    : "{\"error\":\"unknown command\"}";
        } catch (Throwable t) {
            try { return new JSONObject().put("error", String.valueOf(t)).toString(); }
            catch (Exception e) { return "{\"error\":\"internal\"}"; }
        }
    }

    /** UiAutomation's constructor and connect() are hidden; their shapes differ across Android versions. */
    static UiAutomation connect(Looper looper) throws Exception {
        Class<?> connCls = Class.forName("android.app.UiAutomationConnection");
        Class<?> ifaceCls = Class.forName("android.app.IUiAutomationConnection");
        Constructor<?> cc = connCls.getDeclaredConstructor();
        cc.setAccessible(true);
        Object conn = cc.newInstance();
        Constructor<UiAutomation> uc = UiAutomation.class.getDeclaredConstructor(Looper.class, ifaceCls);
        uc.setAccessible(true);
        UiAutomation ua = uc.newInstance(looper, conn);
        Method m;
        try {
            m = UiAutomation.class.getDeclaredMethod("connectWithTimeout", int.class, long.class);
            m.setAccessible(true);
            m.invoke(ua, FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES, 5000L);
        } catch (NoSuchMethodException e) {
            m = UiAutomation.class.getDeclaredMethod("connect", int.class);
            m.setAccessible(true);
            m.invoke(ua, FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        }
        return ua;
    }

    static JSONObject dump(UiAutomation ua) throws Exception {
        try { ua.waitForIdle(50, 400); } catch (Exception ignored) { /* animating: read what's there */ }
        List<AccessibilityWindowInfo> wins = ua.getWindows();
        JSONArray windows = new JSONArray();
        String fg = null;
        int w = 0, h = 0;
        Rect r = new Rect();
        // getWindows() is top-most first; emit bottom-most first so later nodes are drawn on top.
        for (int i = wins.size() - 1; i >= 0; i--) {
            AccessibilityWindowInfo win = wins.get(i);
            win.getBoundsInScreen(r);
            w = Math.max(w, r.right);
            h = Math.max(h, r.bottom);
            AccessibilityNodeInfo root = win.getRoot();
            if (root == null) continue;
            if (win.isActive() && win.getType() == AccessibilityWindowInfo.TYPE_APPLICATION && root.getPackageName() != null) fg = root.getPackageName().toString();
            JSONObject n = node(root, 0);
            n.put("windowType", win.getType());
            windows.put(n);
        }
        if (fg == null) {
            AccessibilityNodeInfo a = ua.getRootInActiveWindow();
            if (a != null && a.getPackageName() != null) fg = a.getPackageName().toString();
        }
        return new JSONObject().put("windows", windows).put("width", w).put("height", h).put("foregroundApp", fg == null ? JSONObject.NULL : fg);
    }

    /** Screenshot scaled on the phone to `max` px on its longest side and JPEG-encoded here: ~30 KB instead of a ~200 KB PNG. */
    static JSONObject shot(UiAutomation ua, int max) throws Exception {
        android.graphics.Bitmap b = ua.takeScreenshot();
        if (b == null) return new JSONObject().put("error", "screenshot failed (secure screen?)");
        int w = b.getWidth(), h = b.getHeight();
        if (max > 0 && Math.max(w, h) > max) {
            float k = (float) max / Math.max(w, h);
            android.graphics.Bitmap s = android.graphics.Bitmap.createScaledBitmap(b, Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)), true);
            b.recycle();
            b = s;
        }
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        b.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, out);
        b.recycle();
        return new JSONObject().put("data", android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)).put("mimeType", "image/jpeg");
    }

    // ---- input: the same events `adb shell input` injects, without starting a shell process per call ----

    static boolean inject(UiAutomation ua, android.view.InputEvent e) { return inject(ua, e, true); }

    /** Straight into the input system, the way Android's own `input` command does (InputManagerGlobal on 14+,
     *  InputManager before). UiAutomation's injection waits for pending window transactions, ~30 ms per event. */
    static Object inputManager;
    static Method injectDirect;
    static {
        for (String cls : new String[]{"android.hardware.input.InputManagerGlobal", "android.hardware.input.InputManager"}) {
            try {
                Class<?> c = Class.forName(cls);
                Object im = c.getDeclaredMethod("getInstance").invoke(null);
                Method m = c.getMethod("injectInputEvent", android.view.InputEvent.class, int.class);
                inputManager = im; injectDirect = m;
                break;
            } catch (Throwable ignored) { /* try the next, then fall back to UiAutomation */ }
        }
    }
    static final int INJECT_ASYNC = 0, INJECT_WAIT_FOR_RESULT = 1;

    /** sync=false: queue the event and return (events of one gesture keep their order). */
    static boolean inject(UiAutomation ua, android.view.InputEvent e, boolean sync) {
        boolean ok;
        try { ok = injectDirect != null ? (Boolean) injectDirect.invoke(inputManager, e, sync ? INJECT_WAIT_FOR_RESULT : INJECT_ASYNC) : ua.injectInputEvent(e, sync); }
        catch (Throwable ex) { ok = ua.injectInputEvent(e, sync); }
        if (e instanceof android.view.MotionEvent) ((android.view.MotionEvent) e).recycle();
        return ok;
    }

    static android.view.MotionEvent motion(long down, long at, int action, float x, float y) {
        android.view.MotionEvent e = android.view.MotionEvent.obtain(down, at, action, x, y, 0);
        e.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        return e;
    }

    /** tap X Y [holdMs] */
    static JSONObject tap(UiAutomation ua, String[] a) throws Exception {
        float x = Float.parseFloat(a[0]), y = Float.parseFloat(a[1]);
        long hold = a.length > 2 ? Long.parseLong(a[2]) : 0;
        long t = android.os.SystemClock.uptimeMillis();
        boolean ok = inject(ua, motion(t, t, android.view.MotionEvent.ACTION_DOWN, x, y), false);
        if (hold > 0) Thread.sleep(hold);
        long u = android.os.SystemClock.uptimeMillis();
        ok &= inject(ua, motion(t, u, android.view.MotionEvent.ACTION_UP, x, y), false);
        return ok ? new JSONObject().put("ok", true) : new JSONObject().put("error", "touch was not delivered");
    }

    /** swipe X1 Y1 X2 Y2 MS: interpolated moves every ~8 ms, like `input swipe` */
    static JSONObject swipe(UiAutomation ua, String[] a) throws Exception {
        float x1 = Float.parseFloat(a[0]), y1 = Float.parseFloat(a[1]), x2 = Float.parseFloat(a[2]), y2 = Float.parseFloat(a[3]);
        long ms = a.length > 4 ? Math.max(10, Long.parseLong(a[4])) : 300;
        long t = android.os.SystemClock.uptimeMillis();
        boolean ok = inject(ua, motion(t, t, android.view.MotionEvent.ACTION_DOWN, x1, y1));
        long now = t;
        while (ok && (now = android.os.SystemClock.uptimeMillis()) < t + ms) {
            float k = (now - t) / (float) ms;
            ok = inject(ua, motion(t, now, android.view.MotionEvent.ACTION_MOVE, x1 + (x2 - x1) * k, y1 + (y2 - y1) * k));
            Thread.sleep(8);
        }
        now = android.os.SystemClock.uptimeMillis();
        ok &= inject(ua, motion(t, now, android.view.MotionEvent.ACTION_MOVE, x2, y2));
        ok &= inject(ua, motion(t, now, android.view.MotionEvent.ACTION_UP, x2, y2));
        return ok ? new JSONObject().put("ok", true) : new JSONObject().put("error", "swipe was not delivered");
    }

    /** pinch CX CY FROM_DIST TO_DIST MS: two fingers moving apart (zoom in) or together (zoom out) horizontally. */
    static JSONObject pinch(UiAutomation ua, String[] a) throws Exception {
        float cx = Float.parseFloat(a[0]), cy = Float.parseFloat(a[1]), d0 = Float.parseFloat(a[2]) / 2, d1 = Float.parseFloat(a[3]) / 2;
        long ms = a.length > 4 ? Math.max(50, Long.parseLong(a[4])) : 400;
        android.view.MotionEvent.PointerProperties[] pp = new android.view.MotionEvent.PointerProperties[2];
        for (int i = 0; i < 2; i++) { pp[i] = new android.view.MotionEvent.PointerProperties(); pp[i].id = i; pp[i].toolType = android.view.MotionEvent.TOOL_TYPE_FINGER; }
        long t = android.os.SystemClock.uptimeMillis();
        boolean ok = inject(ua, multi(t, t, android.view.MotionEvent.ACTION_DOWN, 1, pp, cx, cy, d0), true);
        ok &= inject(ua, multi(t, t, android.view.MotionEvent.ACTION_POINTER_DOWN | (1 << android.view.MotionEvent.ACTION_POINTER_INDEX_SHIFT), 2, pp, cx, cy, d0), true);
        long now;
        while (ok && (now = android.os.SystemClock.uptimeMillis()) < t + ms) {
            float k = (now - t) / (float) ms;
            ok = inject(ua, multi(t, now, android.view.MotionEvent.ACTION_MOVE, 2, pp, cx, cy, d0 + (d1 - d0) * k), true);
            Thread.sleep(8);
        }
        now = android.os.SystemClock.uptimeMillis();
        ok &= inject(ua, multi(t, now, android.view.MotionEvent.ACTION_POINTER_UP | (1 << android.view.MotionEvent.ACTION_POINTER_INDEX_SHIFT), 2, pp, cx, cy, d1), true);
        ok &= inject(ua, multi(t, now, android.view.MotionEvent.ACTION_UP, 1, pp, cx, cy, d1), true);
        return ok ? new JSONObject().put("ok", true) : new JSONObject().put("error", "pinch was not delivered");
    }

    static android.view.MotionEvent multi(long down, long at, int action, int n, android.view.MotionEvent.PointerProperties[] pp, float cx, float cy, float half) {
        android.view.MotionEvent.PointerCoords[] pc = new android.view.MotionEvent.PointerCoords[n];
        for (int i = 0; i < n; i++) { pc[i] = new android.view.MotionEvent.PointerCoords(); pc[i].x = i == 0 ? cx - half : cx + half; pc[i].y = cy; pc[i].pressure = 1; pc[i].size = 1; }
        return android.view.MotionEvent.obtain(down, at, action, n, java.util.Arrays.copyOf(pp, n), pc, 0, 0, 1, 1, 0, 0, android.view.InputDevice.SOURCE_TOUCHSCREEN, 0);
    }

    /** Key events for ASCII text, exactly what `input text` generates (KeyCharacterMap.VIRTUAL_KEYBOARD). */
    static JSONObject keys(UiAutomation ua, String text) throws Exception {
        android.view.KeyCharacterMap map = android.view.KeyCharacterMap.load(android.view.KeyCharacterMap.VIRTUAL_KEYBOARD);
        android.view.KeyEvent[] evs = map.getEvents(text.toCharArray());
        if (evs == null) return new JSONObject().put("error", "text has characters without key events");
        // Queued in order; the input dispatcher delivers them in sequence (same as `input text`, minus the wait per key).
        for (android.view.KeyEvent e : evs) if (!inject(ua, e, false)) return new JSONObject().put("error", "key was not delivered");
        return new JSONObject().put("ok", true);
    }

    static JSONObject key(UiAutomation ua, int code) throws Exception {
        long t = android.os.SystemClock.uptimeMillis();
        boolean ok = inject(ua, new android.view.KeyEvent(t, t, android.view.KeyEvent.ACTION_DOWN, code, 0), false)
                && inject(ua, new android.view.KeyEvent(t, android.os.SystemClock.uptimeMillis(), android.view.KeyEvent.ACTION_UP, code, 0), false);
        return ok ? new JSONObject().put("ok", true) : new JSONObject().put("error", "key was not delivered");
    }

    // ---- clipboard: the system clipboard service directly (shell holds READ_CLIPBOARD_IN_BACKGROUND) ----

    static Object clipboard() throws Exception {
        Object binder = Class.forName("android.os.ServiceManager").getMethod("getService", String.class).invoke(null, "clipboard");
        return Class.forName("android.content.IClipboard$Stub").getMethod("asInterface", android.os.IBinder.class).invoke(null, binder);
    }

    /** IClipboard's signatures differ by Android version: (pkg[, tag], user[, device]). Fill by parameter type. */
    static Object[] clipArgs(Method m, Object first) {
        Class<?>[] t = m.getParameterTypes();
        Object[] a = new Object[t.length];
        int ints = 0, strings = 0;
        for (int i = 0; i < t.length; i++) {
            if (i == 0 && first != null) { a[i] = first; continue; }
            if (t[i] == String.class) a[i] = strings++ == 0 ? "com.android.shell" : null;
            else if (t[i] == int.class) a[i] = ints++ == 0 ? 0 /* user 0 */ : 0 /* default device */;
            else a[i] = null;
        }
        return a;
    }

    static JSONObject clipGet() throws Exception {
        Object cb = clipboard();
        for (Method m : cb.getClass().getMethods()) {
            if (!m.getName().equals("getPrimaryClip")) continue;
            android.content.ClipData clip = (android.content.ClipData) m.invoke(cb, clipArgs(m, null));
            String text = clip != null && clip.getItemCount() > 0 && clip.getItemAt(0).getText() != null ? clip.getItemAt(0).getText().toString() : "";
            return new JSONObject().put("text", text);
        }
        return new JSONObject().put("error", "clipboard service has no getPrimaryClip");
    }

    static JSONObject clipSet(String text) throws Exception {
        Object cb = clipboard();
        android.content.ClipData clip = android.content.ClipData.newPlainText("mobius", text);
        for (Method m : cb.getClass().getMethods()) {
            if (!m.getName().equals("setPrimaryClip")) continue;
            m.invoke(cb, clipArgs(m, clip));
            return new JSONObject().put("ok", true);
        }
        return new JSONObject().put("error", "clipboard service has no setPrimaryClip");
    }

    static String b64(String s) { return new String(android.util.Base64.decode(s, android.util.Base64.DEFAULT), StandardCharsets.UTF_8); }

    /** Any-language text (Hindi, emoji…) into the focused field: appended, or replacing it (`fill`). adb `input text` is ASCII-only. */
    static JSONObject setText(UiAutomation ua, String text, boolean replace) throws Exception {
        AccessibilityNodeInfo f = ua.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (f == null || !f.isEditable()) return new JSONObject().put("error", "no focused text field");
        String before = replace || f.isShowingHintText() || f.getText() == null ? "" : f.getText().toString();
        android.os.Bundle args = new android.os.Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, before + text);
        if (!f.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return new JSONObject().put("error", "field refused the text");
        return new JSONObject().put("ok", true);
    }

    static JSONObject node(AccessibilityNodeInfo n, int depth) throws Exception {
        JSONObject o = new JSONObject();
        Rect b = new Rect();
        n.getBoundsInScreen(b);
        o.put("class", s(n.getClassName()));
        o.put("text", s(n.getText()));
        o.put("content-desc", s(n.getContentDescription()));
        o.put("resource-id", s(n.getViewIdResourceName()));
        o.put("hint", s(n.getHintText()));
        o.put("package", s(n.getPackageName()));
        o.put("rect", new JSONObject().put("x", b.left).put("y", b.top).put("width", Math.max(0, b.width())).put("height", Math.max(0, b.height())));
        o.put("clickable", n.isClickable());
        o.put("longClickable", n.isLongClickable());
        o.put("checkable", n.isCheckable());
        o.put("checked", n.isChecked());
        o.put("enabled", n.isEnabled());
        o.put("focused", n.isFocused());
        o.put("scrollable", n.isScrollable());
        o.put("selected", n.isSelected());
        o.put("password", n.isPassword());
        o.put("editable", n.isEditable());
        o.put("visible", n.isVisibleToUser());
        JSONArray kids = new JSONArray();
        if (depth < 120) {
            for (int i = 0; i < n.getChildCount(); i++) {
                AccessibilityNodeInfo c = n.getChild(i);
                if (c != null) kids.put(node(c, depth + 1));
            }
        }
        o.put("children", kids);
        return o;
    }

    static String s(CharSequence c) { return c == null ? "" : c.toString(); }
}

#!/usr/bin/env python3
"""CLI vs CLI: mobiusagent-driver against mobilecli (what mobile-mcp runs), one fresh process per command for both.

    python3 bench/compare.py --android emulator-5554 [--android-mobilecli-id Lite_Pool_1080x1920] [--ios <udid>] [--runs 7]

Fair by construction:
- Each tool gets 2 warm-up calls before measuring, and its on-device helper is warm.
- On Android, only one tool's helper runs at a time. Android allows one UiAutomation connection, so the other tool's
  helper is stopped before a tool is measured.
- Same device, same screen, same operations. Reports the median.
"""
import argparse
import os
import shutil
import statistics
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
OURS = os.path.join(HERE, "..", "target", "release", "mobiusagent-driver")


def mobilecli_path():
    """The tool we compare against: `mobilecli` on PATH (npm i -g @mobilenext/mobilecli), or $MOBILECLI."""
    return os.environ.get("MOBILECLI") or shutil.which("mobilecli")


def timed(cmd):
    t = time.perf_counter()
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    ms = (time.perf_counter() - t) * 1000
    return ms, r.returncode == 0 and b'"error"' not in r.stdout[:200]


def median(cmd, runs):
    timed(cmd); timed(cmd)  # warm up
    xs = [timed(cmd) for _ in range(runs)]
    return round(statistics.median(x[0] for x in xs)), all(x[1] for x in xs)


def ops(dev, mdev, app, xy, sw, tmp):
    x, y = xy
    x1, y1, x2, y2 = sw
    return [
        ("read screen (full tree)", ["dump", "ui", "--device", mdev, "--format", "raw", "--full"], ["dump", "--device", dev]),
        ("tap", ["io", "tap", f"{x},{y}", "--device", mdev], ["tap", f"{x},{y}", "--device", dev]),
        ("swipe", ["io", "swipe", f"{x1},{y1},{x2},{y2}", "--device", mdev], ["swipe", f"{x1},{y1},{x2},{y2}", "--ms", "100", "--device", dev]),
        ("type text", ["io", "text", "a", "--device", mdev], ["text", "a", "--device", dev]),
        ("screenshot", ["screenshot", "--device", mdev, "--output", f"{tmp}/mc.png"], ["screenshot", "--max", "768", "--output", f"{tmp}/ma.jpg", "--device", dev]),
        ("foreground app", ["apps", "foreground", "--device", mdev], ["foreground", "--device", dev]),
        ("list apps", ["apps", "list", "--device", mdev], ["apps", "--device", dev]),
        ("launch app", ["apps", "launch", app, "--device", mdev], ["launch", app, "--device", dev]),
        ("orientation", ["device", "orientation", "get", "--device", mdev], ["orientation", "--device", dev]),
    ]


def run(title, dev, mdev, app, xy, sw, runs, android):
    mc = mobilecli_path()
    tmp = os.environ.get("TMPDIR", "/tmp").rstrip("/")
    rows = ops(dev, mdev, app, xy, sw, tmp)
    sh = lambda c: subprocess.run(["adb", "-s", dev, "shell", c], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if android: sh("pkill -f '[d]ev.mobius.agent.Server'"); time.sleep(1)
    theirs = {name: median([mc] + a, runs) for name, a, _ in rows}
    if android: sh("pkill -f '[D]eviceServer'; pkill -f '[U]iDumpServer'"); time.sleep(1)
    ours = {name: median([OURS] + b, runs) for name, _, b in rows}
    print(f"\n### {title}\n\n| Operation | mobilecli | mobiusagent-driver | |\n|---|---|---|---|")
    wins = 0
    for name, _, _ in rows:
        (a, aok), (b, bok) = theirs[name], ours[name]
        verdict = (f"**{a / max(b, 1):.1f}x faster**" if b < a else f"{b / max(a, 1):.1f}x slower") if aok and bok else ("mobilecli failed" if not aok else "ours failed")
        wins += b < a and bok
        print(f"| {name} | {a} ms | {b} ms | {verdict} |")
    print(f"\nmobiusagent-driver faster on {wins}/{len(rows)} operations (median of {runs}, fresh process per command for both).")


def ios_pids(udid, pattern):
    out = subprocess.run(["xcrun", "devicectl", "device", "info", "processes", "--device", udid], capture_output=True, text=True).stdout
    return [l.split()[0] for l in out.splitlines() if pattern in l and l.strip()[:1].isdigit()]


def make_cold(tool, dev, android):
    """Stop everything the tool keeps running (on the Mac and on the phone) and drop its caches."""
    mc = mobilecli_path()
    if tool == "mobilecli":
        subprocess.run([mc, "daemon", "stop"], capture_output=True)
        subprocess.run(["pkill", "-f", "mobilecli-darwin-arm64 daemon"], capture_output=True)
        if android:
            subprocess.run(["adb", "-s", dev, "shell", "pkill -f '[D]eviceServer'; pkill -f '[U]iDumpServer'; true"], capture_output=True)
        else:
            for pid in ios_pids(dev, "devicekit-iosUITests-Runner"):
                subprocess.run(["xcrun", "devicectl", "device", "process", "terminate", "--device", dev, "--pid", pid], capture_output=True)
    else:
        cache = os.path.expanduser(f"~/.mobius/driver/{dev}.json")
        if os.path.exists(cache): os.remove(cache)
        if android:
            subprocess.run(["adb", "-s", dev, "shell", "pkill -f '[d]ev.mobius.agent.Server'; true"], capture_output=True)
        else:
            subprocess.run(["pkill", "-f", "xcodebuild test-without-building"], capture_output=True)
            subprocess.run(["pkill", "-f", "mobiusagent-driver __wda-host"], capture_output=True)
            for pid in ios_pids(dev, "WebDriverAgentRunner-Runner"):
                subprocess.run(["xcrun", "devicectl", "device", "process", "terminate", "--device", dev, "--pid", pid], capture_output=True)
    time.sleep(3)


def cold(title, dev, mdev, android, trials):
    """Cold start = the first command (read the screen) with nothing running for that tool."""
    mc = mobilecli_path()
    res = {}
    for tool, cmd in [("mobilecli", [mc, "dump", "ui", "--device", mdev, "--format", "raw", "--full"]), ("ours", [OURS, "dump", "--device", dev])]:
        xs = []
        for _ in range(trials):
            other = "ours" if tool == "mobilecli" else "mobilecli"
            make_cold(other, dev, android)  # Android allows one accessibility client: free it for this tool
            make_cold(tool, dev, android)
            ms, ok = timed(cmd)
            xs.append(ms if ok else float("nan"))
            warm = [timed(cmd)[0] for _ in range(3)]
        res[tool] = (round(statistics.median(xs)), round(statistics.median(warm)))
    (ac, aw), (bc, bw) = res["mobilecli"], res["ours"]
    fmt = lambda a, b: f"**{a / max(b, 1):.1f}x faster**" if b < a else f"{b / max(a, 1):.1f}x slower"
    print(f"\n### Cold vs warm: {title} (first screen read with nothing running; median of {trials})\n")
    print("| | mobilecli | mobiusagent-driver | |\n|---|---|---|---|")
    print(f"| Cold start (first command) | {ac} ms | {bc} ms | {fmt(ac, bc)} |")
    print(f"| Warm (next commands) | {aw} ms | {bw} ms | {fmt(aw, bw)} |")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--android"); ap.add_argument("--android-mobilecli-id")
    ap.add_argument("--ios"); ap.add_argument("--runs", type=int, default=7)
    ap.add_argument("--cold", type=int, default=0, help="also measure cold start, this many trials per tool")
    a = ap.parse_args()
    if a.cold and a.android: cold(f"Android ({a.android})", a.android, a.android_mobilecli_id or a.android, True, a.cold)
    if a.cold and a.ios: cold(f"iOS ({a.ios[:8]}…)", a.ios, a.ios, False, a.cold)
    if a.android:
        run(f"Android ({a.android})", a.android, a.android_mobilecli_id or a.android, "com.android.settings", (5, 5), (540, 1200, 540, 1100), a.runs, True)
    if a.ios:
        run(f"iOS ({a.ios[:8]}…)", a.ios, a.ios, "com.apple.Preferences", (5, 5), (200, 500, 200, 450), a.runs, False)

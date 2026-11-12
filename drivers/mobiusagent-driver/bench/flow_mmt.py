#!/usr/bin/env python3
"""Real-app flow benchmark: MakeMyTrip flight search up to the checkout page, through mobilecli and mobiusagent-driver.

    python3 bench/flow_mmt.py --ios <udid> [--warm 2] [--cold 1]

The flow stops at the review/checkout page ("CONTINUE"). No traveller details are entered and nothing is paid.
1. Launch MMT and tap Flights.
2. Tap SEARCH FLIGHTS (the form is prefilled).
3. Wait for the results to stop re-sorting, then open the first flight.
4. Tap BOOK NOW.
5. Wait for the checkout page.

Both tools use the same locators and the same wait logic: read the screen until the target is visible and stable, then
tap. Per step and in total, it reports wall time, time spent inside the tool, and screen reads. Wall time includes MMT's
own network and rendering, which is the same for both, so "tool time" is the clean comparison.
"""
import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import compare as c  # noqa: E402

APP = "com.Iphone.MMT"
W, H = 393, 852


class Tool:
    def __init__(self, name, udid):
        self.name, self.udid, self.tool_ms, self.reads = name, udid, 0.0, 0

    def _run(self, args):
        t = time.perf_counter()
        r = subprocess.run(args, capture_output=True, text=True)
        self.tool_ms += (time.perf_counter() - t) * 1000
        return r

    def nodes(self):
        self.reads += 1
        if self.name == "mobilecli":
            r = self._run([c.mobilecli_path(), "dump", "ui", "--device", self.udid, "--format", "raw", "--full"])
            root = json.loads(r.stdout)["data"]["rawData"]
        else:
            r = self._run([c.OURS, "dump", "--device", self.udid])
            root = json.loads(r.stdout)["data"]["tree"]["hierarchy"][0]
        out = []
        def walk(n):
            out.append(n)
            for ch in n.get("children") or []: walk(ch)
        walk(root)
        return out

    def tap(self, x, y):
        cmd = [c.mobilecli_path(), "io", "tap", f"{int(x)},{int(y)}", "--device", self.udid] if self.name == "mobilecli" \
            else [c.OURS, "tap", f"{int(x)},{int(y)}", "--device", self.udid]
        self._run(cmd)

    def app(self, verb):
        cmd = [c.mobilecli_path(), "apps", verb, APP, "--device", self.udid] if self.name == "mobilecli" \
            else [c.OURS, "launch" if verb == "launch" else "terminate", APP, "--device", self.udid]
        self._run(cmd)


def visible(n):
    f = n.get("frame") or {}
    return f.get("Width", 0) > 0 and f.get("Height", 0) > 0 and 0 <= f.get("Y", -1) < H and 0 <= f.get("X", -1) < W


def find(nodes, label, etype=None, contains=False):
    for n in nodes:
        lab = n.get("label") or ""
        if visible(n) and (label in lab if contains else lab == label) and (etype is None or n.get("elementType") == etype):
            return n
    return None


def wait(tool, pred, timeout=40, stable=False):
    """Read the screen until pred(nodes) returns a value (twice in a row if stable)."""
    end, last = time.time() + timeout, None
    while time.time() < end:
        v = pred(tool.nodes())
        if v is not None:
            if not stable or v == last: return v
            last = v
        else:
            last = None
    raise TimeoutError("target never appeared")


def center(n):
    f = n["frame"]
    return f["X"] + f["Width"] / 2, f["Y"] + f["Height"] / 2


def flow(tool):
    steps = []
    def step(name, fn):
        t0, m0, r0 = time.perf_counter(), tool.tool_ms, tool.reads
        try: fn()
        except TimeoutError: raise TimeoutError(f"step '{name}': target never appeared")
        steps.append((name, (time.perf_counter() - t0) * 1000, tool.tool_ms - m0, tool.reads - r0))
    step("launch + tap Flights", lambda: (tool.app("launch"), tool.tap(*center(wait(tool, lambda ns: find(ns, "Flights", 9)))))[1])
    step("search flights", lambda: tool.tap(*center(wait(tool, lambda ns: find(ns, "SEARCH FLIGHTS", 9)))))
    def open_first():
        y = wait(tool, lambda ns: (find(ns, "Sorted by") and min((n["frame"]["Y"] for n in ns if visible(n) and n.get("label") == "/adult"), default=None)), stable=True)
        tool.tap(90, y - 12)
    step("results → open first flight", open_first)
    def book():
        # Wait until the sheet stops animating (same frame twice), tap the left edge (a floating pill covers the middle),
        # and retry once if the sheet is still there: identical for both tools.
        for attempt in range(3):
            fr = wait(tool, lambda ns: (lambda n: n and (round(n["frame"]["X"]), round(n["frame"]["Y"]), round(n["frame"]["Height"])))(find(ns, "BOOK NOW", 9)), stable=True)
            tool.tap(fr[0] + 20, fr[1] + fr[2] / 2)
            try:
                wait(tool, lambda ns: True if not find(ns, "BOOK NOW", 9) else None, timeout=4)
                return
            except TimeoutError:
                pass
        raise TimeoutError("BOOK NOW did not respond")
    step("tap BOOK NOW", book)
    step("checkout page shown", lambda: wait(tool, lambda ns: find(ns, "CONTINUE", contains=True)))
    return steps


def run(udid, warm, cold):
    results = {"mobilecli": {"warm": [], "cold": []}, "ours": {"warm": [], "cold": []}}
    plan = [("cold", t) for _ in range(cold) for t in ("mobilecli", "ours")] + [("warm", t) for _ in range(warm) for t in ("ours", "mobilecli")]
    for kind, name in plan:
        if kind == "cold":
            c.make_cold("ours" if name == "mobilecli" else "mobilecli", udid, False)
            c.make_cold(name, udid, False)
        tool = Tool(name, udid)
        tool.app("terminate"); time.sleep(1.5)
        tool.tool_ms, tool.reads = 0.0, 0
        t = time.perf_counter()
        try:
            steps = flow(tool)
            total = (time.perf_counter() - t) * 1000
            results[name][kind].append((total, tool.tool_ms, tool.reads, steps))
            print(f"{kind:4} {name:10} total {total/1000:5.1f} s   tool {tool.tool_ms/1000:5.1f} s   reads {tool.reads}", flush=True)
        except Exception as e:
            print(f"{kind:4} {name:10} FAILED: {e}", flush=True)
        tool.app("terminate")
        time.sleep(2)
    return results


def report(results):
    print("\n### MMT flight → checkout, iPhone 16 (USB)\n")
    print("| Scenario | | mobilecli | mobiusagent-driver | |\n|---|---|---|---|---|")
    for kind in ("cold", "warm"):
        a, b = results["mobilecli"][kind], results["ours"][kind]
        if not a or not b: continue
        for label, i, unit in (("Total (wall)", 0, "s"), ("Time inside the tool", 1, "s"), ("Screen reads", 2, "")):
            va, vb = statistics.median(x[i] for x in a), statistics.median(x[i] for x in b)
            fa, fb = (f"{va/1000:.1f} s", f"{vb/1000:.1f} s") if unit else (f"{va:.0f}", f"{vb:.0f}")
            verdict = f"**{va/max(vb,1e-9):.1f}x faster**" if vb < va else f"{vb/max(va,1e-9):.1f}x slower"
            print(f"| {kind} | {label} | {fa} | {fb} | {verdict if unit else ''} |")
    print("\nPer step (warm, median): wall / inside the tool\n\n| Step | mobilecli | mobiusagent-driver |\n|---|---|---|")
    a, b = results["mobilecli"]["warm"], results["ours"]["warm"]
    if a and b:
        for i, (name, *_ ) in enumerate(a[0][3]):
            sa = [x[3][i] for x in a]; sb = [x[3][i] for x in b]
            m = lambda s, j: statistics.median(v[j] for v in s) / 1000
            print(f"| {name} | {m(sa,1):.1f} s / {m(sa,2):.1f} s | {m(sb,1):.1f} s / {m(sb,2):.1f} s |")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--ios", required=True); ap.add_argument("--warm", type=int, default=2); ap.add_argument("--cold", type=int, default=1)
    a = ap.parse_args()
    report(run(a.ios, a.warm, a.cold))

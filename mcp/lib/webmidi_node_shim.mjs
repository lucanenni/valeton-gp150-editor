// Minimal Web MIDI API (navigator.requestMIDIAccess) for Node, backed by python_midi_bridge.py.
// Just enough for app/static/webmidi_gp150.js: named inputs/outputs, onmidimessage, send().
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PY = process.env.GP150_MIDI_PYTHON || resolve(here, "../../.venv-midi/bin/python");

export function installWebMidiShim() {
  let proc = null, rl = null;
  const pending = [];          // resolvers waiting for the next event of a given type
  const input = { name: "", onmidimessage: null, type: "input", state: "connected" };
  const output = { name: "", type: "output", state: "connected",
    send(bytes) { proc.stdin.write(JSON.stringify({ op: "send", bytes: Array.from(bytes) }) + "\n"); } };

  const waitFor = (ev) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("bridge timeout waiting for " + ev)), 5000);
    pending.push({ ev, res: (m) => { clearTimeout(t); res(m); }, rej });
  });

  function start() {
    proc = spawn(PY, [resolve(here, "python_midi_bridge.py")], { stdio: ["pipe", "pipe", "inherit"] });
    rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.ev === "midi") { if (input.onmidimessage) input.onmidimessage({ data: Uint8Array.from(m.bytes) }); return; }
      const i = pending.findIndex((p) => p.ev === m.ev || m.ev === "error");
      if (i >= 0) { const p = pending.splice(i, 1)[0]; m.ev === "error" ? p.rej(new Error(m.msg)) : p.res(m); }
    });
  }

  const nav = {
    userAgent: "node-webmidi-shim",
    async requestMIDIAccess() {
      if (!proc) start();
      proc.stdin.write(JSON.stringify({ op: "ports" }) + "\n");
      const ports = await waitFor("ports");
      const inIdx = ports.in.findIndex((n) => n.includes("GP-150"));
      const outIdx = ports.out.findIndex((n) => n.includes("GP-150"));
      const inputs = new Map(), outputs = new Map();
      if (inIdx >= 0 && outIdx >= 0) {
        proc.stdin.write(JSON.stringify({ op: "open", in: inIdx, out: outIdx }) + "\n");
        await waitFor("opened");
        input.name = ports.in[inIdx]; output.name = ports.out[outIdx];
        inputs.set("in0", input); outputs.set("out0", output);
      }
      return { inputs, outputs };
    },
  };
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });
  return { close() { if (proc) { proc.stdin.write(JSON.stringify({ op: "close" }) + "\n"); proc.stdin.end(); } } };
}

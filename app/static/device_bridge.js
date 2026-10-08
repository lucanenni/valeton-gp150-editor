"use strict";
/*
 * device_bridge.js — one device-I/O seam for the Explorer, so the same UI works
 * with a Python backend or as a pure static WebMIDI page.
 *
 * Today it fronts the WebMIDI modules (webmidi_device.js / webmidi_write.js).
 * The /api/* paths still live in explorer.js as the fallback; the bridge is the
 * single place the live editor talks to the pedal, and the natural home for a
 * unified WebMIDI-or-/api router as the rewire proceeds.
 */
(function (root) {
  const dev = () => root.WebMidiDevice;
  const wr = () => root.WebMidiWrite;

  const Bridge = {
    webmidiAvailable: () => !!(navigator.requestMIDIAccess && root.WebMidiDevice && root.WebMidiWrite && root.PRST),
    connected: () => !!(dev() && dev().isConnected()),
    device: () => (dev() ? dev().device() : null),

    // Connect over WebMIDI (must be called from a user gesture the first time —
    // the SysEx permission prompt needs it). Returns {key,name,port}.
    async connect() {
      if (!Bridge.webmidiAvailable()) throw new Error("WebMIDI unavailable (use Chrome or Edge, and load prst.js + the webmidi modules)");
      return dev().connect();
    },

    // Read a slot's live .prst (select + 0x41 + rebuild). Uint8Array.
    async readSlotPrst(slot) {
      if (!Bridge.connected()) throw new Error("not connected");
      return dev().readSlotPrst(slot);
    },

    async selectSlot(slot) {
      if (!Bridge.connected()) throw new Error("not connected");
      return dev().selectSlot(slot);
    },

    async readNames() {
      if (!Bridge.connected()) throw new Error("not connected");
      return dev().readNames();
    },

    async readBankBlob(selector) {
      if (!Bridge.connected()) throw new Error("not connected");
      return dev().readBankBlob(selector);
    },

    // Write a full .prst to a slot. The live-edit opt-in is the confirm.
    async writeSlot(slot, prst) {
      if (!Bridge.connected()) throw new Error("not connected");
      return wr().writeSlot(slot, prst, { confirm: true });
    },

    // WRITE-1: write, then read the slot back and compare byte-for-byte before
    // trusting it. Under a throttled/backgrounded tab a write's own ACK count
    // can undercount (the pedal got the packet, but the ACK message arrived
    // too late for a backgrounded tab's timing window to see it) — so ACKs
    // alone aren't proof, and a real GP-50 write is documented to round-trip
    // byte-identical (re/DEVICE_WRITE.md) when it actually landed. Handles two
    // distinct symptoms separately: a mismatched read that's just STALE (the
    // device hadn't settled yet — retried a few times with a short pause,
    // cheap) vs. a write that genuinely never landed (retried as a full
    // write+verify cycle, up to `writeRetries` times). Throws if verification
    // never succeeds. Used by the higher-stakes one-shot writes (clear,
    // reorder, restore, live-edit keep/restore) — NOT the debounced live-param
    // write, where the extra read round-trip per keystroke would cost more in
    // feel than it's worth and the user already gets live visual feedback.
    async writeSlotVerified(slot, prst, { writeRetries = 1, readRetries = 2, readRetryDelayMs = 200, allowUnverified } = {}) {
      if (!Bridge.connected()) throw new Error("not connected");
      let lastErr = null;
      for (let w = 0; w <= writeRetries; w++) {
        const result = await wr().writeSlot(slot, prst, { confirm: true, allowUnverified });
        for (let r = 0; r <= readRetries; r++) {
          if (r) await new Promise((res) => setTimeout(res, readRetryDelayMs));
          try {
            const readback = await dev().readSlotPrst(slot);
            if (eqBytes(readback, prst)) return { ...result, verified: true };
            lastErr = new Error(`slot ${slot}: read-back didn't match what was written`);
          } catch (e) {
            lastErr = new Error(`slot ${slot}: read-back after write failed: ${e.message}`);
          }
        }
        // read-back never matched after readRetries — the write itself may not
        // have landed; try sending it again from scratch.
      }
      throw lastErr;
    },
  };

  function eqBytes(a, z) {
    if (!a || !z || a.length !== z.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== z[i]) return false;
    return true;
  }

  root.DeviceBridge = Bridge;
})(typeof self !== "undefined" ? self : this);

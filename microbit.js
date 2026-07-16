({
  requires: [],
  provides: {
    values: {
      // Single-board convenience API (operates on one default connection).
      'connect': ["arrow", [], "String"],
      'connect-bluetooth': ["arrow", [], "String"],
      'disconnect': ["arrow", [], "Nothing"],
      'is-connected': ["arrow", [], "Boolean"],
      'transport': ["arrow", [], "String"],
      'latest-line': ["arrow", [], "String"],
      'latest': ["arrow", [], "Any"],
      'await-sample': ["arrow", [], "Any"],
      'sample-count': ["arrow", [], "Number"],
      // Multi-board API: each returns a controller object bound to a named
      // connection. Reusing the same name returns the existing connection
      // (no re-prompt across program re-runs).
      'controller': ["arrow", ["String"], "Any"],
      'controller-bluetooth': ["arrow", ["String"], "Any"],
    },
    types: {}
  },
  nativeRequires: [],
  theModule: function(runtime, _, uri) {
    // All connections live on window, keyed by name, so program re-runs reuse
    // open ports/devices instead of reconnecting. Each record holds one board.
    const G = window.__pyretMicrobit = window.__pyretMicrobit || {};
    if (!G.byName) { G.byName = {}; }

    const MICROBIT_USB_VENDOR = 0x0d28;
    const SAMPLE_TIMEOUT_MS = 10000;

    // Nordic UART Service (serial-over-BLE). NOTE: the micro:bit SWAPS the two
    // characteristic UUIDs relative to the standard Nordic assignment — its
    // notify (device→browser) characteristic is 6e400002, and 6e400003 is
    // write-only. Subscribing on 6e400003 throws "GATT Error: Not supported".
    const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
    const NUS_TX_CHAR = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // micro:bit → browser, notify

    function getRecord(name) {
      if (!G.byName[name]) {
        G.byName[name] = {
          name: name, transport: null,
          port: null, reader: null,      // serial
          device: null, txChar: null,    // bluetooth
          connected: false,
          lastLine: "", lastSample: null, count: 0, waiters: [],
        };
      }
      return G.byName[name];
    }

    function pyAwait(promise) {
      return runtime.pauseStack(function(restarter) {
        promise.then(
          function(v) { restarter.resume(v); },
          function(e) {
            restarter.error(runtime.ffi.makeMessageException(String((e && e.message) || e)));
          });
      });
    }

    // --- shared sample handling (transport-agnostic, per record) ----------
    function handleLine(rec, line) {
      if (!line) { return; }
      rec.lastLine = line;
      const nums = line.split(",").map(Number);
      if (nums.length > 0 && nums.every(Number.isFinite)) {
        rec.lastSample = nums;
        rec.count += 1;
        const ws = rec.waiters;
        rec.waiters = [];
        ws.forEach(function(w) { w.resolve(nums); });
      }
    }

    function makeLineAssembler(rec) {
      const decoder = new TextDecoder();
      let pending = "";
      return function feed(chunk /* Uint8Array | DataView */) {
        const bytes = chunk instanceof DataView
          ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : chunk;
        pending += decoder.decode(bytes, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        lines.forEach(function(l) { handleLine(rec, l.trim()); });
      };
    }

    function markDisconnected(rec, why) {
      rec.connected = false;
      rec.transport = null;
      rec.port = null;
      rec.reader = null;
      rec.device = null;
      rec.txChar = null;
      const ws = rec.waiters;
      rec.waiters = [];
      ws.forEach(function(w) { w.reject(new Error(why)); });
    }

    function resetSampleState(rec) {
      rec.lastLine = "";
      rec.lastSample = null;
      rec.count = 0;
    }

    // requestPort/requestDevice must run inside a user gesture; the Run click's
    // activation is long gone, so put up a button and let its click be it.
    function withGestureButton(label, action) {
      return new Promise(function(resolve, reject) {
        const overlay = document.createElement("div");
        overlay.style.cssText =
          "position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:100000;" +
          "display:flex;align-items:center;justify-content:center;";
        const button = document.createElement("button");
        button.textContent = label;
        button.style.cssText =
          "font-size:22px;padding:18px 30px;cursor:pointer;border-radius:8px;";
        overlay.appendChild(button);
        button.addEventListener("click", async function() {
          try { resolve(await action()); }
          catch (e) { reject(e); }
          finally { overlay.remove(); }
        });
        document.body.appendChild(overlay);
      });
    }

    // --- serial transport (USB) -------------------------------------------
    async function serialPump(rec) {
      const feed = makeLineAssembler(rec);
      try {
        rec.reader = rec.port.readable.getReader();
        while (true) {
          const { value, done } = await rec.reader.read();
          if (done) { break; }
          feed(value);
        }
      } catch (e) {
        console.error("micro:bit serial read error:", e);
      } finally {
        if (rec.reader) { try { rec.reader.releaseLock(); } catch (e) {} }
      }
      markDisconnected(rec, "The micro:bit serial connection closed");
    }

    async function connectSerial(rec) {
      if (rec.connected) { return "already-connected"; }
      if (!navigator.serial) {
        throw new Error("Web Serial is not available in this frame. " +
          "Use Chrome/Edge, and make sure the embedding iframe has allow=\"serial\".");
      }
      // Skip ports already held by another named connection so a second
      // controller doesn't grab the first board.
      const claimed = new Set(Object.keys(G.byName)
        .map(function(k) { return G.byName[k].port; })
        .filter(Boolean));
      const granted = await navigator.serial.getPorts();
      let port = granted.find(function(p) {
        return (p.getInfo().usbVendorId === MICROBIT_USB_VENDOR) && !claimed.has(p);
      });
      if (!port) {
        port = await withGestureButton("🔌 Choose a micro:bit…", function() {
          return navigator.serial.requestPort({
            filters: [{ usbVendorId: MICROBIT_USB_VENDOR }]
          });
        });
      }
      // Opening the port pulses DTR, which resets the micro:bit; the first
      // samples arrive a moment after its program reboots.
      await port.open({ baudRate: 115200 });
      rec.port = port;
      rec.transport = "serial";
      rec.connected = true;
      resetSampleState(rec);
      serialPump(rec);
      return "connected";
    }

    // --- bluetooth transport (BLE Nordic UART) ----------------------------
    async function connectBluetooth(rec) {
      if (rec.connected) { return "already-connected"; }
      if (!navigator.bluetooth) {
        throw new Error("Web Bluetooth is not available in this frame. " +
          "Use Chrome/Edge, and make sure the embedding iframe has allow=\"bluetooth\".");
      }
      // requestDevice ALWAYS needs a gesture + shows the chooser (no gesture-free
      // reconnect like serial's getPorts).
      const device = await withGestureButton("📶 Choose a micro:bit…", function() {
        return navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: "BBC micro:bit" }],
          optionalServices: [NUS_SERVICE]
        });
      });
      device.addEventListener("gattserverdisconnected", function() {
        markDisconnected(rec, "The micro:bit Bluetooth connection dropped");
      });
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(NUS_SERVICE);
      const txChar = await service.getCharacteristic(NUS_TX_CHAR);
      const feed = makeLineAssembler(rec);
      txChar.addEventListener("characteristicvaluechanged", function(e) {
        feed(e.target.value); // DataView
      });
      await txChar.startNotifications();
      rec.device = device;
      rec.txChar = txChar;
      rec.transport = "bluetooth";
      rec.connected = true;
      resetSampleState(rec);
      return "connected";
    }

    async function disconnectRec(rec) {
      if (rec.transport === "serial") {
        if (rec.reader) { try { await rec.reader.cancel(); } catch (e) {} }
        if (rec.port) { try { await rec.port.close(); } catch (e) {} }
      } else if (rec.transport === "bluetooth") {
        if (rec.txChar) { try { await rec.txChar.stopNotifications(); } catch (e) {} }
        if (rec.device && rec.device.gatt.connected) {
          try { rec.device.gatt.disconnect(); } catch (e) {}
        }
      }
      markDisconnected(rec, "disconnected");
      return runtime.nothing;
    }

    function nextSample(rec) {
      if (!rec.connected) {
        throw runtime.throwMessageException(
          "micro:bit \"" + rec.name + "\" is not connected");
      }
      return new Promise(function(resolve, reject) {
        rec.waiters.push({ resolve: resolve, reject: reject });
        setTimeout(function() {
          reject(new Error("No sample arrived for " + (SAMPLE_TIMEOUT_MS / 1000) +
            "s. Is the streaming program flashed on the micro:bit?"));
        }, SAMPLE_TIMEOUT_MS);
      });
    }

    function mkNumList(arr) {
      return runtime.ffi.makeList(arr.map(function(n) { return runtime.makeNumber(n); }));
    }

    // A Pyret object bound to one connection: ctrl.latest(), ctrl.await-sample(), ...
    function makeController(rec) {
      return runtime.makeObject({
        "name": runtime.makeFunction(function() {
          runtime.checkArity(0, arguments, "name", false);
          return runtime.makeString(rec.name);
        }, "name"),
        "latest": runtime.makeFunction(function() {
          runtime.checkArity(0, arguments, "latest", false);
          return mkNumList(rec.lastSample || []);
        }, "latest"),
        "latest-line": runtime.makeFunction(function() {
          runtime.checkArity(0, arguments, "latest-line", false);
          return runtime.makeString(rec.lastLine);
        }, "latest-line"),
        "await-sample": runtime.makeFunction(function() {
          runtime.checkArity(0, arguments, "await-sample", false);
          return pyAwait(nextSample(rec).then(mkNumList));
        }, "await-sample"),
        "sample-count": runtime.makeFunction(function() {
          runtime.checkArity(0, arguments, "sample-count", false);
          return runtime.makeNumber(rec.count);
        }, "sample-count"),
        "is-connected": runtime.makeFunction(function() {
          runtime.checkArity(0, arguments, "is-connected", false);
          return runtime.makeBoolean(rec.connected);
        }, "is-connected"),
        "transport": runtime.makeFunction(function() {
          runtime.checkArity(0, arguments, "transport", false);
          return runtime.makeString(rec.transport || "none");
        }, "transport"),
        "disconnect": runtime.makeFunction(function() {
          runtime.checkArity(0, arguments, "disconnect", false);
          return pyAwait(disconnectRec(rec));
        }, "disconnect"),
      });
    }

    const DEFAULT = "default";
    const vals = {
      // --- single-board convenience (default connection) ---
      "connect": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "connect", false);
        return pyAwait(connectSerial(getRecord(DEFAULT)));
      }, "connect"),
      "connect-bluetooth": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "connect-bluetooth", false);
        return pyAwait(connectBluetooth(getRecord(DEFAULT)));
      }, "connect-bluetooth"),
      "disconnect": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "disconnect", false);
        return pyAwait(disconnectRec(getRecord(DEFAULT)));
      }, "disconnect"),
      "is-connected": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "is-connected", false);
        return runtime.makeBoolean(getRecord(DEFAULT).connected);
      }, "is-connected"),
      "transport": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "transport", false);
        return runtime.makeString(getRecord(DEFAULT).transport || "none");
      }, "transport"),
      "latest-line": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "latest-line", false);
        return runtime.makeString(getRecord(DEFAULT).lastLine);
      }, "latest-line"),
      "latest": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "latest", false);
        return mkNumList(getRecord(DEFAULT).lastSample || []);
      }, "latest"),
      "await-sample": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "await-sample", false);
        return pyAwait(nextSample(getRecord(DEFAULT)).then(mkNumList));
      }, "await-sample"),
      "sample-count": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "sample-count", false);
        return runtime.makeNumber(getRecord(DEFAULT).count);
      }, "sample-count"),

      // --- multi-board (named controllers) ---
      "controller": runtime.makeFunction(function(name) {
        runtime.checkArity(1, arguments, "controller", false);
        const rec = getRecord(String(name));
        return pyAwait(connectSerial(rec).then(function() { return makeController(rec); }));
      }, "controller"),
      "controller-bluetooth": runtime.makeFunction(function(name) {
        runtime.checkArity(1, arguments, "controller-bluetooth", false);
        const rec = getRecord(String(name));
        return pyAwait(connectBluetooth(rec).then(function() { return makeController(rec); }));
      }, "controller-bluetooth"),
    };

    if (runtime.makeModuleReturn) {
      return runtime.makeModuleReturn(vals, {});
    }
    return runtime.makeObject({
      "provide-plus-types": runtime.makeObject({
        values: runtime.makeObject(vals),
        types: {}
      }),
      "answer": runtime.nothing
    });
  }
})

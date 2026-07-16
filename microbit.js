({
  requires: [],
  provides: {
    values: {
      'connect': ["arrow", [], "String"],
      'connect-bluetooth': ["arrow", [], "String"],
      'disconnect': ["arrow", [], "Nothing"],
      'is-connected': ["arrow", [], "Boolean"],
      'transport': ["arrow", [], "String"],
      'latest-line': ["arrow", [], "String"],
      'latest': ["arrow", [], "Any"],
      'await-sample': ["arrow", [], "Any"],
      'sample-count': ["arrow", [], "Number"],
    },
    types: {}
  },
  nativeRequires: [],
  theModule: function(runtime, _, uri) {
    // Connection state lives on window, not in module scope: re-running the
    // program re-evaluates this module, but the connection stays open on the
    // page, so a second connect() must find the first run's connection.
    const S = window.__pyretMicrobit = window.__pyretMicrobit || {
      transport: null,        // "serial" | "bluetooth" | null
      port: null, reader: null,               // serial
      device: null, txChar: null,             // bluetooth
      connected: false,
      lastLine: "", lastSample: null, count: 0, waiters: [],
    };

    const MICROBIT_USB_VENDOR = 0x0d28;
    const SAMPLE_TIMEOUT_MS = 10000;

    // Nordic UART Service (serial-over-BLE). The micro:bit's MakeCode
    // "bluetooth uart" is this profile — BUT the micro:bit SWAPS the two
    // characteristic UUIDs relative to the standard Nordic assignment: its
    // notify (device→browser) characteristic is 6e400002, and 6e400003 is the
    // write (browser→device) one. Subscribing on 6e400003 throws
    // "GATT Error: Not supported" because it has no notify property.
    const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
    const NUS_TX_CHAR = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // micro:bit → browser, notify

    function pyAwait(promise) {
      return runtime.pauseStack(function(restarter) {
        promise.then(
          function(v) { restarter.resume(v); },
          function(e) {
            restarter.error(runtime.ffi.makeMessageException(String((e && e.message) || e)));
          });
      });
    }

    // --- shared sample handling (transport-agnostic) ----------------------
    function handleLine(line) {
      if (!line) { return; }
      S.lastLine = line;
      const nums = line.split(",").map(Number);
      if (nums.length > 0 && nums.every(Number.isFinite)) {
        S.lastSample = nums;
        S.count += 1;
        const ws = S.waiters;
        S.waiters = [];
        ws.forEach(function(w) { w.resolve(nums); });
      }
    }

    // A newline-splitting line assembler shared by both transports.
    function makeLineAssembler() {
      const decoder = new TextDecoder();
      let pending = "";
      return function feed(chunk /* Uint8Array | DataView */) {
        const bytes = chunk instanceof DataView
          ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : chunk;
        pending += decoder.decode(bytes, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        lines.forEach(function(l) { handleLine(l.trim()); });
      };
    }

    function markDisconnected(why) {
      S.connected = false;
      S.transport = null;
      S.port = null;
      S.reader = null;
      S.device = null;
      S.txChar = null;
      const ws = S.waiters;
      S.waiters = [];
      ws.forEach(function(w) { w.reject(new Error(why)); });
    }

    // requestPort/requestDevice must run inside a user gesture, but the Run
    // click's activation is long gone by the time the program executes. So the
    // first connect puts up a button; clicking it is the gesture.
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
    async function serialPump() {
      const feed = makeLineAssembler();
      try {
        S.reader = S.port.readable.getReader();
        while (true) {
          const { value, done } = await S.reader.read();
          if (done) { break; }
          feed(value);
        }
      } catch (e) {
        console.error("micro:bit serial read error:", e);
      } finally {
        if (S.reader) { try { S.reader.releaseLock(); } catch (e) {} }
      }
      markDisconnected("The micro:bit serial connection closed");
    }

    async function doConnectSerial() {
      if (S.connected) { return "already-connected"; }
      if (!navigator.serial) {
        throw new Error("Web Serial is not available in this frame. " +
          "Use Chrome/Edge, and make sure the embedding iframe has allow=\"serial\".");
      }
      const granted = await navigator.serial.getPorts();
      let port = granted.find(function(p) {
        return p.getInfo().usbVendorId === MICROBIT_USB_VENDOR;
      });
      if (!port) {
        port = await withGestureButton("🔌 Choose your micro:bit…", function() {
          return navigator.serial.requestPort({
            filters: [{ usbVendorId: MICROBIT_USB_VENDOR }]
          });
        });
      }
      // Opening the port pulses DTR, which resets the micro:bit; the first
      // samples arrive a moment after its program reboots.
      await port.open({ baudRate: 115200 });
      S.port = port;
      S.transport = "serial";
      S.connected = true;
      resetSampleState();
      serialPump();
      return "connected";
    }

    // --- bluetooth transport (BLE Nordic UART) ----------------------------
    async function doConnectBluetooth() {
      if (S.connected) { return "already-connected"; }
      if (!navigator.bluetooth) {
        throw new Error("Web Bluetooth is not available in this frame. " +
          "Use Chrome/Edge, and make sure the embedding iframe has allow=\"bluetooth\".");
      }
      // requestDevice ALWAYS needs a gesture + shows the chooser (there is no
      // gesture-free getDevices reconnect like serial's getPorts).
      const device = await withGestureButton("📶 Choose your micro:bit…", function() {
        return navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: "BBC micro:bit" }],
          optionalServices: [NUS_SERVICE]
        });
      });
      device.addEventListener("gattserverdisconnected", function() {
        markDisconnected("The micro:bit Bluetooth connection dropped");
      });
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(NUS_SERVICE);
      const txChar = await service.getCharacteristic(NUS_TX_CHAR);
      const feed = makeLineAssembler();
      txChar.addEventListener("characteristicvaluechanged", function(e) {
        feed(e.target.value); // DataView
      });
      await txChar.startNotifications();
      S.device = device;
      S.txChar = txChar;
      S.transport = "bluetooth";
      S.connected = true;
      resetSampleState();
      return "connected";
    }

    function resetSampleState() {
      S.lastLine = "";
      S.lastSample = null;
      S.count = 0;
    }

    async function doDisconnect() {
      if (S.transport === "serial") {
        if (S.reader) { try { await S.reader.cancel(); } catch (e) {} }
        if (S.port) { try { await S.port.close(); } catch (e) {} }
      } else if (S.transport === "bluetooth") {
        if (S.txChar) { try { await S.txChar.stopNotifications(); } catch (e) {} }
        if (S.device && S.device.gatt.connected) {
          try { S.device.gatt.disconnect(); } catch (e) {}
        }
      }
      markDisconnected("disconnected");
      return runtime.nothing;
    }

    function nextSample() {
      if (!S.connected) {
        throw runtime.throwMessageException("Not connected: call connect() or connect-bluetooth() first");
      }
      return new Promise(function(resolve, reject) {
        S.waiters.push({ resolve: resolve, reject: reject });
        setTimeout(function() {
          reject(new Error("No sample arrived for " + (SAMPLE_TIMEOUT_MS / 1000) +
            "s. Is the streaming program flashed on the micro:bit?"));
        }, SAMPLE_TIMEOUT_MS);
      });
    }

    function mkNumList(arr) {
      return runtime.ffi.makeList(arr.map(function(n) { return runtime.makeNumber(n); }));
    }

    const vals = {
      "connect": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "connect", false);
        return pyAwait(doConnectSerial());
      }, "connect"),
      "connect-bluetooth": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "connect-bluetooth", false);
        return pyAwait(doConnectBluetooth());
      }, "connect-bluetooth"),
      "disconnect": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "disconnect", false);
        return pyAwait(doDisconnect());
      }, "disconnect"),
      "is-connected": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "is-connected", false);
        return runtime.makeBoolean(S.connected);
      }, "is-connected"),
      "transport": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "transport", false);
        return runtime.makeString(S.transport || "none");
      }, "transport"),
      "latest-line": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "latest-line", false);
        return runtime.makeString(S.lastLine);
      }, "latest-line"),
      "latest": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "latest", false);
        return mkNumList(S.lastSample || []);
      }, "latest"),
      "await-sample": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "await-sample", false);
        return pyAwait(nextSample().then(mkNumList));
      }, "await-sample"),
      "sample-count": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "sample-count", false);
        return runtime.makeNumber(S.count);
      }, "sample-count"),
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

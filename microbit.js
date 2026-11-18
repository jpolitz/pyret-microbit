// Needs a Pyret build with reactor event sources and sinks
// (jpolitz/pyret-lang@reactor-custom-events). It does not load on a CPO
// without them: the types below name builtin://reactors' EventSource and
// EventSink.
({
  requires: [
    { "import-type": "builtin", "name": "reactors" }
  ],
  provides: {
    shorthands: {
      "EventSource": { tag: "name",
                       origin: { "import-type": "uri", uri: "builtin://reactors" },
                       name: "EventSource" },
      "EventSink": { tag: "name",
                     origin: { "import-type": "uri", uri: "builtin://reactors" },
                     name: "EventSink" },
      "List": { tag: "name",
                origin: { "import-type": "uri", uri: "builtin://lists" },
                name: "List" }
    },
    values: {
      // Event sources for reactors, from the default connection's samples:
      //   on(MB.button-a): lam(w, b): ... end
      'button-a': ["tyapp", "EventSource", ["String"]],   // "a", each time A is pressed
      'button-b': ["tyapp", "EventSource", ["String"]],   // "b", each time B is pressed
      'buttons': ["tyapp", "EventSource", ["String"]],    // "a" or "b", either press
      'tilt': ["tyapp", "EventSource", ["Any"]],          // {x, y, z} in milli-g, when it moves
      'temperature': ["tyapp", "EventSource", ["Number"]],// degrees C, when it changes
      'light': ["tyapp", "EventSource", ["Number"]],      // light level 0-255, when it changes
      'sample': ["tyapp", "EventSource", [["tyapp", "List", ["Number"]]]], // every raw sample
      // Event sinks:
      //   to(MB.leds): lam(w): <5x5 grid, or a String to scroll> end
      //   to(MB.speaker): lam(w): <pitch in Hz, 0 for silence> end
      //   on-to(MB.button-a, MB.speaker): lam(w, b): {w; MB.note(440, 200)} end
      'leds': ["tyapp", "EventSink", ["Any"]],
      'speaker': ["tyapp", "EventSink", ["Any"]],
      'note': ["arrow", ["Number", "Number"], "Any"],
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
      // Output to the board's 5x5 LED grid (needs the two-way firmware).
      'show-text': ["arrow", ["String"], "Nothing"],
      'show-leds': ["arrow", ["Any"], "Nothing"],
      'clear-leds': ["arrow", [], "Nothing"],
      // Multi-board API: each returns a controller object bound to a named
      // connection. Reusing the same name returns the existing connection
      // (no re-prompt across program re-runs).
      'controller': ["arrow", ["String"], "Any"],
      'controller-bluetooth': ["arrow", ["String"], "Any"],
    },
    types: {}
  },
  nativeRequires: [],
  theModule: function(runtime, _, uri, reactors) {
    const Reactors = runtime.getField(reactors, "internal");
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
    const NUS_RX_CHAR = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // browser → micro:bit, write
    const BLE_CHUNK = 20; // default ATT MTU payload; the firmware reassembles lines

    function getRecord(name) {
      if (!G.byName[name]) {
        G.byName[name] = {
          name: name, transport: null,
          port: null, reader: null, writer: null,  // serial
          device: null, txChar: null, rxChar: null, // bluetooth
          connected: false,
          lastLine: "", lastSample: null, count: 0, waiters: [], listeners: [],
          outQueue: [], sending: false, lastFrame: null,
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
        rec.listeners.slice().forEach(function(l) {
          try { l(nums); } catch (e) { console.error("micro:bit event listener error:", e); }
        });
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
      rec.writer = null;
      rec.device = null;
      rec.txChar = null;
      rec.rxChar = null;
      rec.outQueue = [];
      rec.lastFrame = null;
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
      rec.rxChar = await service.getCharacteristic(NUS_RX_CHAR);
      rec.transport = "bluetooth";
      rec.connected = true;
      resetSampleState(rec);
      return "connected";
    }

    async function disconnectRec(rec) {
      if (rec.transport === "serial") {
        if (rec.reader) { try { await rec.reader.cancel(); } catch (e) {} }
        if (rec.writer) { try { rec.writer.releaseLock(); } catch (e) {} }
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

    // --- output: host → board commands -----------------------------------
    // One newline-terminated line per command (see firmware/):
    //   T:<text>                scroll text
    //   L:<25 digits 0-9>       set every LED's brightness, row-major
    // Writes are fire-and-forget so they're cheap to call from a reactor's
    // on-tick/to-draw. LED frames coalesce (only the newest unsent one is
    // kept) and a frame identical to the last one sent is skipped.
    async function writeLine(rec, text) {
      const bytes = new TextEncoder().encode(text + "\n");
      if (rec.transport === "serial") {
        if (!rec.writer) { rec.writer = rec.port.writable.getWriter(); }
        await rec.writer.write(bytes);
      } else if (rec.transport === "bluetooth") {
        // GATT allows one operation at a time; the queue keeps these serial.
        for (let i = 0; i < bytes.length; i += BLE_CHUNK) {
          await rec.rxChar.writeValue(bytes.slice(i, i + BLE_CHUNK));
        }
      }
    }

    async function pumpOut(rec) {
      if (rec.sending) { return; }
      rec.sending = true;
      try {
        while (rec.connected && rec.outQueue.length > 0) {
          const line = rec.outQueue.shift();
          if (line.startsWith("L:")) {
            if (line === rec.lastFrame) { continue; }
            rec.lastFrame = line;
          } else if (line.startsWith("T:")) {
            rec.lastFrame = null; // text scrolling overwrites the grid
          }
          await writeLine(rec, line);
        }
      } catch (e) {
        console.error("micro:bit write error:", e);
        rec.outQueue = [];
      } finally {
        rec.sending = false;
      }
    }

    function sendCommand(rec, line) {
      if (!rec.connected) {
        throw runtime.throwMessageException(
          "micro:bit \"" + rec.name + "\" is not connected");
      }
      const q = rec.outQueue;
      // LED frames and held pitches coalesce: only the newest unsent one of
      // each kind matters. Notes and text always go out.
      const kind = line.slice(0, 2);
      if ((kind === "L:" || kind === "P:") && q.length > 0 && q[q.length - 1].startsWith(kind)) {
        q[q.length - 1] = line;
      } else {
        q.push(line);
      }
      pumpOut(rec);
      return runtime.nothing;
    }

    function textCommand(s) {
      if (!runtime.isString(s)) {
        throw runtime.throwMessageException("show-text expects a String");
      }
      return "T:" + s.replace(/[\r\n]+/g, " ");
    }

    // rows: List<List<Number|Boolean>>, 5x5. Numbers are brightness 0-9
    // (clamped, rounded); true/false mean 9/0.
    function ledCommand(rows) {
      function bad() {
        throw runtime.throwMessageException(
          "show-leds expects a list of 5 rows, each a list of 5 numbers " +
          "from 0 (off) to 9 (brightest), or Booleans");
      }
      if (!runtime.ffi.isList(rows)) { bad(); }
      const rs = runtime.ffi.toArray(rows);
      if (rs.length !== 5) { bad(); }
      let digits = "";
      rs.forEach(function(row) {
        if (!runtime.ffi.isList(row)) { bad(); }
        const cs = runtime.ffi.toArray(row);
        if (cs.length !== 5) { bad(); }
        cs.forEach(function(c) {
          let v;
          if (runtime.isBoolean(c)) { v = runtime.isPyretTrue(c) ? 9 : 0; }
          else if (runtime.isNumber(c)) { v = Math.round(runtime.num_to_fixnum(c)); }
          else { bad(); }
          digits += String(Math.max(0, Math.min(9, v)));
        });
      });
      return "L:" + digits;
    }

    const CLEAR_COMMAND = "L:" + "0".repeat(25);

    function mkNumList(arr) {
      return runtime.ffi.makeList(arr.map(function(n) { return runtime.makeNumber(n); }));
    }

    // --- reactor event sources -------------------------------------------
    // Sample layout: ax, ay, az, temperatureC, lightLevel, buttonA, buttonB.
    // Each source adds a listener to the record's sample stream while a
    // reactor is interacting and removes it when the reactor stops. `derive`
    // gets (sample, previous sample seen by this listener or null) and returns
    // a Pyret value to emit, or undefined to stay quiet. Because `prev` starts
    // null, the first sample after a reactor starts reports the current
    // tilt/temperature/light.
    function sampleSource(rec, name, derive) {
      return Reactors.makeEventSource(name, function(emit) {
        let prev = null;
        const listener = function(nums) {
          const v = derive(nums, prev);
          prev = nums;
          if (v !== undefined) { emit(v); }
        };
        rec.listeners.push(listener);
        return function() {
          rec.listeners = rec.listeners.filter(function(l) { return l !== listener; });
        };
      });
    }

    const TILT_THRESHOLD = 40; // milli-g; ignore accelerometer noise

    function changedAt(i) {
      return function(nums, prev) {
        if (nums.length <= i) { return undefined; }
        if (prev && prev.length > i && prev[i] === nums[i]) { return undefined; }
        return runtime.makeNumber(nums[i]);
      };
    }

    // Fires on the press (0 -> 1), not the release. A button already held
    // when the reactor starts counts as a press.
    function pressedAt(i, label) {
      return function(nums, prev) {
        if (nums.length <= i || nums[i] !== 1) { return undefined; }
        if (prev && prev.length > i && prev[i] === 1) { return undefined; }
        return runtime.makeString(label);
      };
    }

    function makeSources(rec) {
      const pressA = pressedAt(5, "a");
      const pressB = pressedAt(6, "b");
      const label = function(s) { return rec.name === DEFAULT ? s : rec.name + " " + s; };
      return {
        "button-a": sampleSource(rec, label("button-a"), pressA),
        "button-b": sampleSource(rec, label("button-b"), pressB),
        // Both pressed in the same sample: report "a" (a sample is one event).
        "buttons": sampleSource(rec, label("buttons"), function(nums, prev) {
          const a = pressA(nums, prev);
          return a !== undefined ? a : pressB(nums, prev);
        }),
        "tilt": sampleSource(rec, label("tilt"), function(nums, prev) {
          if (nums.length < 3) { return undefined; }
          if (prev && prev.length >= 3 &&
              Math.abs(nums[0] - prev[0]) < TILT_THRESHOLD &&
              Math.abs(nums[1] - prev[1]) < TILT_THRESHOLD &&
              Math.abs(nums[2] - prev[2]) < TILT_THRESHOLD) { return undefined; }
          return runtime.makeObject({
            x: runtime.makeNumber(nums[0]),
            y: runtime.makeNumber(nums[1]),
            z: runtime.makeNumber(nums[2]),
          });
        }),
        "temperature": sampleSource(rec, label("temperature"), changedAt(3)),
        "light": sampleSource(rec, label("light"), changedAt(4)),
        "sample": sampleSource(rec, label("sample"), function(nums) { return mkNumList(nums); }),
      };
    }

    // --- reactor event sinks ---------------------------------------------
    // Reactors sends to a `to` sink after every transition, unchanged or not,
    // so these sinks act only when the message changes (LED frames are also
    // deduped in pumpOut). Errors are thrown as JS Errors: send runs outside
    // any Pyret run, and a throw ends the interaction with its message.
    function requireConnected(rec, sinkName) {
      if (!rec.connected) {
        throw new Error("micro:bit \"" + rec.name + "\" is not connected, so " + sinkName +
          " can't send. Call MB.connect() (or MB.connect-bluetooth()) before r.interact().");
      }
    }

    function unwrapOption(m) {
      if (runtime.ffi.isNone(m)) { return null; }
      if (runtime.ffi.isSome(m)) { return runtime.getField(m, "value"); }
      return m;
    }

    function asJsError(f) {
      try { return f(); }
      catch (e) {
        if (e instanceof Error) { throw e; }
        // throwMessageException's Pyret error: pull its message out.
        let msg = "micro:bit error";
        try { msg = runtime.getField(e.exn, "message"); } catch (_) {}
        throw new Error(String(msg));
      }
    }

    // MB.leds accepts a 5x5 grid (List<List<Number|Boolean>>, as show-leds),
    // a String to scroll (re-scrolled only when it changes), or an Option of
    // either (none leaves the display alone).
    function makeLedSink(rec) {
      return Reactors.makeEventSink(rec.name === DEFAULT ? "leds" : rec.name + " leds", function() {
        let lastText = null;
        return {
          send: function(message) {
            const m = unwrapOption(message);
            if (m === null) { return; }
            requireConnected(rec, "MB.leds");
            if (runtime.isString(m)) {
              if (m === lastText) { return; }
              lastText = m;
              asJsError(function() { sendCommand(rec, textCommand(m)); });
            } else {
              lastText = null;
              asJsError(function() { sendCommand(rec, ledCommand(m)); });
            }
          }
        };
      });
    }

    function isNote(m) {
      return runtime.isObject(m) && !runtime.isDataValue(m) &&
        runtime.hasField(m, "pitch") && runtime.hasField(m, "ms");
    }

    function toHz(n, what) {
      if (!runtime.isNumber(n)) {
        throw new Error("MB.speaker expects " + what + " to be a Number, got " +
          runtime.toReprJS(n, runtime.ReprMethods._torepr));
      }
      return Math.max(0, Math.round(runtime.num_to_fixnum(n)));
    }

    // MB.speaker accepts
    //   a Number     hold that pitch in Hz until a different one is sent; 0 is silence
    //   MB.note(hz, ms)  play one note (every time it is sent; meant for on-to)
    //   none / some(either of the above)   none leaves the speaker alone
    // The speaker goes quiet when the reactor stops.
    function makeSpeakerSink(rec) {
      return Reactors.makeEventSink(rec.name === DEFAULT ? "speaker" : rec.name + " speaker", function() {
        let held = 0;
        return {
          send: function(message) {
            const m = unwrapOption(message);
            if (m === null) { return; }
            requireConnected(rec, "MB.speaker");
            if (isNote(m)) {
              const hz = toHz(runtime.getField(m, "pitch"), "a note's pitch");
              const ms = toHz(runtime.getField(m, "ms"), "a note's length");
              held = 0;
              asJsError(function() { sendCommand(rec, "N:" + hz + "," + ms); });
            } else {
              const hz = toHz(m, "the pitch");
              if (hz === held) { return; }
              held = hz;
              asJsError(function() { sendCommand(rec, "P:" + hz); });
            }
          },
          close: function() {
            if (held !== 0 && rec.connected) {
              held = 0;
              try { sendCommand(rec, "P:0"); } catch (e) {}
            }
          }
        };
      });
    }

    function sourcesAndSinks(rec) {
      if (!rec.events) {
        const s = makeSources(rec);
        s.leds = makeLedSink(rec);
        s.speaker = makeSpeakerSink(rec);
        rec.events = s;
      }
      return rec.events;
    }

    // A Pyret object bound to one connection: ctrl.latest(), ctrl.await-sample(), ...
    // Its event sources and sinks are fields: on(p1.button-a), to(p1.leds).
    function makeController(rec) {
      const ev = sourcesAndSinks(rec);
      return runtime.makeObject({
        "button-a": ev["button-a"],
        "button-b": ev["button-b"],
        "buttons": ev.buttons,
        "tilt": ev.tilt,
        "temperature": ev.temperature,
        "light": ev.light,
        "sample": ev.sample,
        "leds": ev.leds,
        "speaker": ev.speaker,
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
        "show-text": runtime.makeFunction(function(s) {
          runtime.checkArity(1, arguments, "show-text", false);
          return sendCommand(rec, textCommand(s));
        }, "show-text"),
        "show-leds": runtime.makeFunction(function(rows) {
          runtime.checkArity(1, arguments, "show-leds", false);
          return sendCommand(rec, ledCommand(rows));
        }, "show-leds"),
        "clear-leds": runtime.makeFunction(function() {
          runtime.checkArity(0, arguments, "clear-leds", false);
          return sendCommand(rec, CLEAR_COMMAND);
        }, "clear-leds"),
      });
    }

    const DEFAULT = "default";
    const ev = sourcesAndSinks(getRecord(DEFAULT));
    const vals = {
      // --- reactor event sources and sinks (default connection) ---
      "button-a": ev["button-a"],
      "button-b": ev["button-b"],
      "buttons": ev.buttons,
      "tilt": ev.tilt,
      "temperature": ev.temperature,
      "light": ev.light,
      "sample": ev.sample,
      "leds": ev.leds,
      "speaker": ev.speaker,
      "note": runtime.makeFunction(function(pitch, ms) {
        runtime.checkArity(2, arguments, "note", false);
        runtime.checkNumber(pitch);
        runtime.checkNumber(ms);
        return runtime.makeObject({ pitch: pitch, ms: ms });
      }, "note"),

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
      "show-text": runtime.makeFunction(function(s) {
        runtime.checkArity(1, arguments, "show-text", false);
        return sendCommand(getRecord(DEFAULT), textCommand(s));
      }, "show-text"),
      "show-leds": runtime.makeFunction(function(rows) {
        runtime.checkArity(1, arguments, "show-leds", false);
        return sendCommand(getRecord(DEFAULT), ledCommand(rows));
      }, "show-leds"),
      "clear-leds": runtime.makeFunction(function() {
        runtime.checkArity(0, arguments, "clear-leds", false);
        return sendCommand(getRecord(DEFAULT), CLEAR_COMMAND);
      }, "clear-leds"),

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

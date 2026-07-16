# pyret-microbit

Connect a **running Pyret program on [code.pyret.org](https://code.pyret.org)**
to a **BBC micro:bit** and pull live sensor data into it — over USB (Web Serial)
or wirelessly (Web Bluetooth). No changes to CPO, no server-side anything.

`MB.await-sample()` in Pyret returns a list like `[list: 52, -40, 1000, 26, 0, 0, 0]`
— that's `ax, ay, az, temperatureC, lightLevel, buttonA, buttonB` straight off
the board.

> **Browser support:** Web Serial and Web Bluetooth are Chromium-only — use
> **Chrome or Edge**. Safari and Firefox don't implement either.

## How it works

```
 micro:bit  ──serial/BLE──▶  microbit.js  ──js-file import──▶  Pyret program
 (firmware/)                  (this repo)                       (on code.pyret.org)
```

- `microbit.js` is a raw Pyret module (the `define({requires, provides,
  theModule})` shape). It opens the micro:bit over Web Serial or Web Bluetooth,
  parses the CSV stream, and exposes it to Pyret.
- `index.html` is a self-contained **dev harness**: it embeds CPO in an iframe
  and answers the `js-file` filesystem RPCs, so `import js-file("/microbit")`
  is served straight from `./microbit.js` on disk — edit, reload, done. No
  gdrive uploads, no CPO rebuild. The iframe carries `allow="serial; bluetooth"`
  to delegate the hardware permissions into the (cross-origin) CPO frame.

## Quick start (USB serial)

**1. Flash the micro:bit** with the MicroPython streamer. Do this **in the
browser** — see the warning below about the CLI. Go to
<https://python.microbit.org>, paste `firmware/microbit-stream.py`, and
"Send to micro:bit". It streams CSV at ~10 Hz over USB serial.

**2. Serve the harness and open it in Chrome:**

```
cd pyret-microbit
python3 -m http.server 8765
```

Open <http://localhost:8765>. Click **Run**. `MB.connect()` pops a
"Choose your micro:bit" button (Web Serial needs a user gesture the first
time; later runs reconnect automatically). Then in the interactions pane:

```
MB.await-sample()   # block for the next sample; List<Number>
MB.latest()         # most recent sample, no waiting
MB.latest-line()    # raw serial line (String)
MB.sample-count()   # samples seen since connect
MB.transport()      # "serial" | "bluetooth" | "none"
MB.is-connected()
MB.disconnect()
```

## Going wireless (Bluetooth)

BLE needs a different firmware — **MicroPython on the micro:bit can't do
Bluetooth**, so you re-flash with MakeCode:

1. At <https://makecode.microbit.org>, new project, switch to JavaScript, paste
   `firmware/microbit-stream.ts`. Add the Bluetooth extension via **toolbox ▸
   Extensions ▸ "bluetooth"** — pasting JS does *not* auto-add it, so until you
   do you'll see "Cannot find name 'bluetooth'". Accept removing `radio` when
   prompted. This firmware streams over **both** USB serial and BLE.
2. **Gear ▸ Project Settings ▸ "No Pairing Required: Anyone can connect."**
   (Web Bluetooth + JustWorks = no passkey dance on the LED grid.)
3. Download/flash over WebUSB.

Then in Pyret use `MB.connect-bluetooth()` instead of `MB.connect()` and pick
the board ("BBC micro:bit […]") from Chrome's device chooser.

**Power, not data:** the micro:bit V2 has no built-in battery. To test BLE, keep
it plugged into USB *for power only* (don't open the serial port) and connect
over Bluetooth. To fully cut the cord, power it from a USB charger / power bank,
or a 2×AAA pack in the JST connector — no code change.

## Examples

- `examples/tilt-demo.arr` — a `reactor` that renders a little micro:bit
  banking and sliding around the screen, driven live by the accelerometer.

## ⚠️ Never touch the micro:bit from the terminal

On macOS, shell I/O to the micro:bit — opening `/dev/cu.usbmodem*`, or writing
`/Volumes/MICROBIT` (e.g. `uflash`) — can wedge in **uninterruptible I/O wait**
when the board resets/remounts mid-operation. That freezes the whole terminal,
survives `Ctrl-C` and even `SIGKILL`, and can hang `lsof` too. **Recovery:
physically unplug the board.** Do all flashing and serial-watching **in the
browser** (python.microbit.org / makecode.microbit.org and their serial
consoles) — never the CLI.

## Gotchas

- **One holder per serial port.** Only one place can hold the USB port at once.
  Close any *other tab running this demo* (a leftover localhost or hosted tab)
  and any MakeCode/python.microbit.org serial console before you `connect()`, or
  you'll get `Failed to execute 'open' on 'SerialPort'`. Unplug/replug the board
  to force-release a stuck port.
- **Reset on connect.** Opening the serial port pulses DTR and *resets* the
  board; the first samples arrive a moment after it reboots.
- **Module caching.** After editing `microbit.js`, **reload the harness page** —
  CPO caches the module for the page's lifetime, so a bare re-Run won't refetch.
- **Different CPO deploy:** `http://localhost:8765/?cpo=http://localhost:5000/editor`.

## Status

Both transports are working end-to-end against production CPO from the public
GitHub Pages deploy at <https://jpolitz.github.io/pyret-microbit/>:

- **USB serial** — verified.
- **Bluetooth LE** — verified, including fully cordless (micro:bit on a battery
  pack, no USB to the computer).

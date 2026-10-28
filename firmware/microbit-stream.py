# MicroPython (micro:bit V2) sensor streamer for the Pyret bridge.
# Prints one CSV line per sample over USB serial (115200 baud):
#   accel-x, accel-y, accel-z, temperature-C, light-level, button-a, button-b
# and listens for newline-terminated commands from Pyret:
#   T:<text>            scroll text
#   L:<25 digits 0-9>   set every LED's brightness, row-major
from microbit import *

display.show(Image.HEART)

SAMPLE_MS = 100
buf = b""


def handle(cmd):
    if cmd.startswith("T:"):
        display.scroll(cmd[2:], wait=False)
    elif cmd.startswith("L:") and len(cmd) >= 27:
        d = cmd[2:27]
        display.show(Image(":".join(d[r * 5:r * 5 + 5] for r in range(5))))


next_sample = running_time()
while True:
    # Poll for commands every 10ms so LED updates aren't stuck behind samples.
    if uart.any():
        data = uart.read()
        if data:
            buf += data
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            try:
                handle(str(line, "utf-8").strip())
            except Exception:
                pass
        if len(buf) > 200:  # no newline in sight; drop garbage
            buf = b""

    if running_time() >= next_sample:
        next_sample = running_time() + SAMPLE_MS
        ax, ay, az = accelerometer.get_values()
        line = "{},{},{},{},{},{},{}".format(
            ax, ay, az,
            temperature(),
            display.read_light_level(),
            1 if button_a.is_pressed() else 0,
            1 if button_b.is_pressed() else 0,
        )
        print(line)
    sleep(10)

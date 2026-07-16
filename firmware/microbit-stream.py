# MicroPython (micro:bit V2) sensor streamer for the Pyret bridge.
# Prints one CSV line per sample over USB serial (115200 baud):
#   accel-x, accel-y, accel-z, temperature-C, light-level, button-a, button-b
from microbit import *

display.show(Image.HEART)

while True:
    ax, ay, az = accelerometer.get_values()
    line = "{},{},{},{},{},{},{}".format(
        ax, ay, az,
        temperature(),
        display.read_light_level(),
        1 if button_a.is_pressed() else 0,
        1 if button_b.is_pressed() else 0,
    )
    print(line)
    sleep(100)

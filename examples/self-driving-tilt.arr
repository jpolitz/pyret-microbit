use context url-file("https://raw.githubusercontent.com/bootstrapworld/starter-files/fall2026/ai", "../libraries/self-driving-car-library.arr")
import js-file("/microbit") as MB

# DRIVE THE CAR BY TILTING A MICRO:BIT.
#
# The self-driving-car library's `drive` takes a "driving function" of type
# (Row -> Number): each tick it's handed the car's sensors (speed, curve,
# offset, skew) and must return a steering angle in degrees (+ = right turn).
# Normally you TRAIN a model to be that function. Here we ignore the sensors
# and steer by the micro:bit's tilt — so you can drive the track by hand.

MB.connect-bluetooth()   # cordless steering wheel! (use MB.connect() for USB)

# Degrees of steering per unit of tilt. roll = ax/1000 is ~±0.7 at a 45° tilt,
# ~±1 near vertical. Negate STEER-GAIN if steering comes out mirrored.
STEER-GAIN = 90

fun clamp(lo, hi, x): num-max(lo, num-min(hi, x)) end

# The driving function. `sensors` (the Row) is ignored — a human + a micro:bit
# are the controller. Reads the board's latest tilt each tick (non-blocking).
fun tilt-driver(sensors):
  s = MB.latest()
  roll = if is-link(s) and (s.length() >= 1): s.get(0) / 1000 else: 0 end
  clamp(-90, 90, roll * STEER-GAIN)
end

drive(tilt-driver)

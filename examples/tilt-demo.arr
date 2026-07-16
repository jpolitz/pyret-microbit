use context starter2024
import js-file("/microbit") as MB
import image as I

# Sample layout from the streamer: [list: ax, ay, az, tempC, light, btnA, btnB]
# Accelerometer values are in milli-g: ~0 flat, ~±1000 at a 90° tilt.

fun clamp(lo, hi, x): num-max(lo, num-min(hi, x)) end

# A static micro:bit, face-on. Red dot marks the "up" edge so rotation reads;
# the two buttons (gold when pressed) and gold edge-pins make orientation clear.
fun make-board(a-down, b-down):
  marker  = I.circle(6, "solid", "red")
  display = I.overlay-align("center", "top", marker, I.rectangle(95, 80, "solid", "black"))
  btn-a   = I.circle(11, "solid", if a-down: "gold" else: "dimgray" end)
  btn-b   = I.circle(11, "solid", if b-down: "gold" else: "dimgray" end)
  gap     = I.rectangle(70, 1, "solid", "seagreen")
  face    = I.above(display, I.beside(btn-a, I.beside(gap, btn-b)))
  body    = I.rectangle(190, 150, "solid", "seagreen")
  pins    = I.rectangle(150, 16, "solid", "gold")
  I.overlay-align("center", "bottom", pins, I.overlay(face, body))
end

fun draw(w):
  scene = I.empty-scene(440, 440)
  if is-link(w) and (w.length() >= 3):
    roll  = w.get(0) / 1000    # tilt left/right  (ax)
    pitch = w.get(1) / 1000    # tilt fwd/back    (ay)
    a-down = (w.length() >= 6) and (w.get(5) == 1)
    b-down = (w.length() >= 7) and (w.get(6) == 1)

    board = make-board(a-down, b-down)
    # roll  -> rotate;  pitch -> vertical foreshorten (fake 3D perspective)
    angle  = num-to-roughnum(clamp(-75, 75, roll * 55))
    squish = num-to-roughnum(clamp(0.3, 1, 1 - (num-abs(pitch) * 0.6)))
    tilted = I.rotate(angle, I.scale-xy(1, squish, board))

    # ...and let it slide "downhill" in the direction you tilt.
    x = 220 + (roll * 140)
    y = 220 + (pitch * 140)
    I.place-image(tilted, x, y, scene)
  else:
    I.overlay(I.text("Waiting for micro:bit…", 24, "gray"), scene)
  end
end

MB.connect()

r = reactor:
  init: [list:],
  on-tick: lam(_): MB.await-sample() end,
  to-draw: draw
end

r.interact()

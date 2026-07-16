use context starter2024
import js-file("/microbit") as MB
import image as I

# TILT DUEL — two micro:bit controllers, one per player.
# Each player tilts their board LEFT/RIGHT to push the gold puck toward the
# opponent's edge. First to shove it off the far edge wins. Press button A on
# either board to reset.
#
# Player 1 = blue (right edge is P1's goal — tilt right to push the puck right).
# Player 2 = red  (left edge is P2's goal — tilt right to push the puck left).

# Connect both boards (BLE recommended — the chooser shows distinct names).
# Reusing the names "p1"/"p2" means re-running Run won't re-prompt.
p1 = MB.controller-bluetooth("p1")   # pick Player 1's board in the chooser
p2 = MB.controller-bluetooth("p2")   # then Player 2's board

WIDTH = 700
HEIGHT = 400
SPEED = 12   # puck pixels per tick at full tilt

# roll ∈ ~[-1, 1] from the accelerometer x axis (ax is in milli-g).
fun roll-of(ctrl):
  s = ctrl.latest()
  if is-link(s) and (s.length() >= 1): s.get(0) / 1000 else: 0 end
end

fun button-a(ctrl):
  s = ctrl.latest()
  (is-link(s) and (s.length() >= 6)) and (s.get(5) == 1)
end

fun step(s):
  if not(s.winner == "none"):
    if button-a(p1) or button-a(p2): { x: WIDTH / 2, winner: "none" } else: s end
  else:
    nx = s.x + (roll-of(p1) * SPEED) - (roll-of(p2) * SPEED)
    ask:
      | nx >= WIDTH then: { x: WIDTH, winner: "p1" }
      | nx <= 0     then: { x: 0, winner: "p2" }
      | otherwise:        { x: nx, winner: "none" }
    end
  end
end

fun draw(s):
  bg = I.rectangle(WIDTH, HEIGHT, "solid", "black")
  p2-goal = I.rectangle(12, HEIGHT, "solid", "crimson")     # left edge
  p1-goal = I.rectangle(12, HEIGHT, "solid", "royalblue")   # right edge
  field = I.overlay-align("right", "middle", p1-goal,
          I.overlay-align("left", "middle", p2-goal, bg))
  puck = I.circle(22, "solid", "gold")
  with-puck = I.place-image(puck, s.x, HEIGHT / 2, field)
  label = ask:
    | s.winner == "p1" then: I.text("Player 1 (blue) wins!  press A to reset", 26, "royalblue")
    | s.winner == "p2" then: I.text("Player 2 (red) wins!  press A to reset", 26, "crimson")
    | otherwise:             I.text("tilt to push the puck  ← →", 22, "gray")
  end
  I.overlay-align("center", "top", label, with-puck)
end

r = reactor:
  init: { x: WIDTH / 2, winner: "none" },
  seconds-per-tick: 0.03,
  on-tick: lam(s): step(s) end,
  to-draw: draw
end

r.interact()

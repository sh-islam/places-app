// Draggable joystick. Knob follows the pointer (clamped to base radius)
// and continuously emits (vx, vy) in [-1, 1] while engaged.
// Releasing snaps the knob back to centre via CSS transition.

export function initJoystick({ base, knob, onMove }) {
  let active = false;
  let raf = null;
  let vx = 0;
  let vy = 0;

  function knobOffset(dx, dy) {
    // Knob is centered with translate(-50%, -50%). Add the drag offset on top.
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }

  function knobRadius() {
    return base.clientWidth / 2 - knob.clientWidth / 4;
  }

  function update(evt) {
    if (!active) return;
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = evt.clientX - cx;
    let dy = evt.clientY - cy;
    const r = knobRadius();
    const dist = Math.hypot(dx, dy);
    if (dist > r) {
      dx = (dx / dist) * r;
      dy = (dy / dist) * r;
    }
    knobOffset(dx, dy);
    vx = dx / r;
    vy = dy / r;
  }

  function tick() {
    if (!active) return;
    if (vx !== 0 || vy !== 0) onMove(vx, vy);
    raf = requestAnimationFrame(tick);
  }

  base.addEventListener("pointerdown", (e) => {
    active = true;
    base.classList.add("active");
    base.setPointerCapture(e.pointerId);
    update(e);
    raf = requestAnimationFrame(tick);
  });

  base.addEventListener("pointermove", update);

  function release(e) {
    if (!active) return;
    active = false;
    base.classList.remove("active");
    vx = 0;
    vy = 0;
    knobOffset(0, 0);
    if (raf) cancelAnimationFrame(raf);
    if (base.hasPointerCapture(e.pointerId)) base.releasePointerCapture(e.pointerId);
  }

  base.addEventListener("pointerup", release);
  base.addEventListener("pointercancel", release);
  base.addEventListener("pointerleave", (e) => { if (active) release(e); });
}

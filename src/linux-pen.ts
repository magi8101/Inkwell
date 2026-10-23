// Linux desktop app only. WebKitGTK reports a stylus as a mouse: no pen type, pressure fixed at
// 0.5, no tilt, the side button as a middle click, the eraser end as a plain mouse. So nothing
// pen-only worked there (pressure, hover, palm rejection, side button, eraser, calibration). The
// Rust side forwards GTK's pen events (lib.rs, pen_bridge) just ahead of the mouse events WebKit
// sends for them; here, while the pen is in range, each such mouse pointer event is swapped for
// a pen pointer event carrying the real tool, pressure and tilt. Imported first, so the swap
// happens before any other listener sees the mouse event.

const IN_LINUX_APP =
  '__TAURI_INTERNALS__' in window &&
  /Linux/.test(navigator.userAgent) &&
  !/Android/.test(navigator.userAgent);
const PEN_ID = 7701;

if (IN_LINUX_APP) {
  let tool: 'pen' | 'eraser' | null = null;
  let pressure = 0;
  let tiltX = 0;
  let tiltY = 0;
  let at = 0;
  let mouseId = 1;
  (window as unknown as { __inkwellPen: unknown }).__inkwellPen = (
    t: string,
    p: number,
    tx: number,
    ty: number,
  ) => {
    tool = t === 'pen' || t === 'eraser' ? t : null;
    pressure = p;
    tiltX = tx;
    tiltY = ty;
    at = performance.now();
  };
  // ponytail: "in range" = a pen event in the last 300 ms; a mouse moved right after the pen
  // lifts away counts as pen for that long.
  const penActive = () => tool !== null && performance.now() - at < 300;

  // The app captures the pen's id; the events really come from the mouse pointer, so capture that.
  const proto = Element.prototype;
  const set = proto.setPointerCapture;
  const release = proto.releasePointerCapture;
  const has = proto.hasPointerCapture;
  const real = (id: number) => (id === PEN_ID ? mouseId : id);
  proto.setPointerCapture = function (this: Element, id: number) {
    set.call(this, real(id));
  };
  proto.releasePointerCapture = function (this: Element, id: number) {
    release.call(this, real(id));
  };
  proto.hasPointerCapture = function (this: Element, id: number) {
    return has.call(this, real(id));
  };

  const TYPES = [
    'pointerdown',
    'pointermove',
    'pointerup',
    'pointercancel',
    'pointerover',
    'pointerout',
    'pointerenter',
    'pointerleave',
  ];
  for (const type of TYPES) {
    addEventListener(
      type,
      (e) => {
        const m = e as PointerEvent;
        if (m.pointerType !== 'mouse' || !m.isTrusted || !penActive()) return;
        mouseId = m.pointerId;
        m.stopImmediatePropagation();
        // WebKit: the tip is the left button (1), the side button the middle one (4).
        const tip = (m.buttons & 1) !== 0;
        const side = (m.buttons & 4) !== 0;
        let buttons = (tip ? 1 : 0) | (side ? 2 : 0);
        let button = m.button === 1 ? 2 : m.button;
        if (tool === 'eraser') {
          // Pointer Events: the eraser end touching is buttons 32, button 5.
          buttons = tip ? 32 : 0;
          if (button === 0) button = 5;
        }
        const pen = new PointerEvent(type, {
          bubbles: m.bubbles,
          cancelable: m.cancelable,
          composed: true,
          view: window,
          clientX: m.clientX,
          clientY: m.clientY,
          screenX: m.screenX,
          screenY: m.screenY,
          ctrlKey: m.ctrlKey,
          shiftKey: m.shiftKey,
          altKey: m.altKey,
          metaKey: m.metaKey,
          button,
          buttons,
          pointerId: PEN_ID,
          pointerType: 'pen',
          isPrimary: true,
          width: 1,
          height: 1,
          pressure: buttons ? Math.max(pressure, 0.01) : 0,
          tiltX,
          tiltY,
        });
        if (!m.target?.dispatchEvent(pen)) m.preventDefault();
      },
      { capture: true },
    );
  }
}

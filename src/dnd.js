// Pointer-driven drag and drop for blocks: a tilted ghost follows the pointer, a
// dashed placeholder shows where the block will snap, and dropping applies the change
// through the store (so it can be undone). Works with mouse, pen and touch.
(function () {
  const SX = window.Scransible;
  const DRAG_THRESHOLD = 5;
  let pending = null;
  let drag = null;

  // payload: { kind: 'new', type, create() } | { kind: 'move', type, id }
  //        | { kind: 'new', type: 'pill', keyword } | { kind: 'new', type: 'reporter', name }
  SX.DnD = {
    attach(element, getPayload) {
      element.classList.add('draggable');
      element.addEventListener('pointerdown', event => {
        if (event.button !== 0 || drag) return;
        if (event.target.closest('input, select, textarea, button, a, [contenteditable], .slot.list, .slot.data, .no-drag')) return;
        if (event.target.closest('.draggable') !== element) return;
        pending = { element, getPayload, x: event.clientX, y: event.clientY };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', cancel);
      });
    },

    // Set by the page that owns the canvas: resolve(hits, payload, point) -> target,
    // drop(payload, target).
    handler: null,
    get active() { return !!drag; }
  };

  function onMove(event) {
    if (!drag && pending) {
      if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < DRAG_THRESHOLD) return;
      start(event);
    }
    if (drag) move(event.clientX, event.clientY, event.altKey);
  }

  function start(event) {
    const { element, getPayload } = pending;
    const payload = getPayload();
    pending = null;
    if (!payload) return;
    const rect = element.getBoundingClientRect();
    const scale = rect.width / (element.offsetWidth || rect.width) || 1;
    const ghost = element.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('selected', 'drag-source');
    ghost.querySelectorAll('.selected').forEach(n => n.classList.remove('selected'));
    ghost.style.width = `${element.offsetWidth}px`;
    ghost.style.transform = `scale(${scale}) rotate(-2.5deg)`;
    ghost.style.transformOrigin = '0 0';
    ghost.style.setProperty('--well', 'var(--bg-bar)');
    document.body.append(ghost);
    const placeholder = document.createElement('div');
    placeholder.className = 'drop-ph';
    placeholder.style.width = `${Math.min(element.offsetWidth, 340)}px`;
    placeholder.style.height = `${Math.min(element.offsetHeight, 58)}px`;
    drag = {
      payload, element, ghost, placeholder, target: null,
      offsetX: (event.clientX - rect.left) / scale, offsetY: (event.clientY - rect.top) / scale, scale
    };
    if (payload.kind === 'move') element.classList.add('drag-source');
    document.body.classList.add('dragging-active');
    window.addEventListener('keydown', onKey, true);
    move(event.clientX, event.clientY, event.altKey);
  }

  function clearIndicators() {
    drag.placeholder.remove();
    document.querySelectorAll('.drop-target, .pill-target, .trash.armed, .has-ph, .over').forEach(n => n.classList.remove('drop-target', 'pill-target', 'armed', 'has-ph', 'over'));
  }

  function move(x, y, altKey = false) {
    drag.ghost.style.left = `${x - drag.offsetX * drag.scale}px`;
    drag.ghost.style.top = `${y - drag.offsetY * drag.scale}px`;
    autoscroll(x, y);
    const hits = document.elementsFromPoint(x, y).filter(n => !drag.ghost.contains(n));
    const target = SX.DnD.handler?.resolve(hits, drag.payload, { x, y, altKey, source: drag.element, offsetX: drag.offsetX, offsetY: drag.offsetY }) || null;
    drag.target = target;
    clearIndicators();
    if (!target) return;
    if (target.kind === 'stack') {
      const children = [...target.element.children].filter(c => c.dataset.id && c !== drag.element);
      const before = children[target.index] || null;
      target.element.insertBefore(drag.placeholder, before);
      target.element.classList.add('has-ph');
    } else if (target.kind === 'slot') {
      target.element.classList.add('drop-target');
    } else if (target.kind === 'node') {
      target.element.classList.add('pill-target');
    } else if (target.kind === 'trash') {
      document.querySelector('.trash')?.classList.add('armed');
    }
    target.highlight?.classList.add('over');
  }

  // Scrolls the canvas while the pointer is near its edge.
  function autoscroll(x, y) {
    const scroller = document.elementsFromPoint(x, y).find(n => n.classList?.contains('canvas-scroll'));
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const edge = 40;
    const dx = x < rect.left + edge ? -12 : x > rect.right - edge ? 12 : 0;
    const dy = y < rect.top + edge ? -12 : y > rect.bottom - edge ? 12 : 0;
    if (dx || dy) scroller.scrollBy(dx, dy);
  }

  // Index among a stack's blocks (ignoring the one being dragged) for a pointer y.
  SX.DnD.indexIn = function indexIn(stack, y, source) {
    const children = [...stack.children].filter(c => c.dataset.id && c !== source);
    const index = children.findIndex(child => {
      const rect = child.getBoundingClientRect();
      return y < rect.top + Math.min(rect.height / 2, 24);
    });
    return index === -1 ? children.length : index;
  };

  function finish(apply) {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cancel);
    pending = null;
    if (!drag) return;
    const { payload, target, element, ghost } = drag;
    clearIndicators();
    ghost.remove();
    element.classList.remove('drag-source');
    document.body.classList.remove('dragging-active');
    window.removeEventListener('keydown', onKey, true);
    drag = null;
    // Swallow the click that follows a drag (dispatched right after pointerup), so
    // dropping doesn't also select or toggle; if no click comes, stop listening.
    const swallow = e => { e.stopPropagation(); e.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    if (apply && target) SX.DnD.handler?.drop(payload, target);
  }

  function onUp() { finish(true); }
  function cancel() { finish(false); }
  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  }
})();

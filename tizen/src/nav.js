// D-pad focus: moves to the nearest focusable element in the pressed
// direction, inside the active scope (a screen or an overlay). A group
// ([data-group]) remembers its last focused element, so coming back into it
// lands where you left; data-lock="up down" keeps those directions inside it.

let scope = document.body;
const memory = new WeakMap();

export const getScope = () => scope;

export function setScope(el) {
  scope = el;
}

export function focusables(root = scope) {
  return Array.from(root.querySelectorAll('.focusable')).filter(el => !el.disabled && el.offsetParent !== null);
}

export function focus(el) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const group = el.closest('[data-group]');
  if (group) memory.set(group, el);
}

// Overlap still counted as "beyond" an element: a focused card is scaled up a
// little and reaches into the gap.
const SLACK = 24;

const center = r => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });

// Distance between two ranges on one axis, 0 when they overlap.
const gap = (a1, a2, b1, b2) => Math.max(0, b1 - a2, a1 - b2);

// Lower is closer; Infinity when b isn't in that direction from a.
function score(a, b, dir) {
  const ac = center(a);
  const bc = center(b);
  const ahead = {
    left: b.right <= a.left + SLACK && bc.x < ac.x,
    right: b.left >= a.right - SLACK && bc.x > ac.x,
    up: b.bottom <= a.top + SLACK && bc.y < ac.y,
    down: b.top >= a.bottom - SLACK && bc.y > ac.y,
  }[dir];
  if (!ahead) return Infinity;
  const horizontal = dir === 'left' || dir === 'right';
  const main = Math.max(0, { left: a.left - b.right, right: b.left - a.right, up: a.top - b.bottom, down: b.top - a.bottom }[dir]);
  const cross = horizontal ? gap(a.top, a.bottom, b.top, b.bottom) : gap(a.left, a.right, b.left, b.right);
  // Leaving a wide element (the search field) downwards starts at its left.
  const wide = !horizontal && a.right - a.left > 2 * (b.right - b.left);
  const offset = horizontal ? Math.abs(bc.y - ac.y) : wide ? Math.abs(b.left - a.left) : Math.abs(bc.x - ac.x);
  return main + cross * 3 + offset * 0.1;
}

function nearest(from, items, dir) {
  const a = from.getBoundingClientRect();
  let best = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === from) continue;
    const s = score(a, el.getBoundingClientRect(), dir);
    if (s < bestScore) {
      best = el;
      bestScore = s;
    }
  }
  return best;
}

export function move(dir) {
  const items = focusables();
  const current = document.activeElement;
  if (!items.includes(current)) {
    focus(items[0]);
    return Boolean(items[0]);
  }
  const group = current.closest('[data-group]');
  const locked = Boolean(group) && (group.dataset.lock || '').split(' ').includes(dir);
  let target = nearest(current, group ? items.filter(el => group.contains(el)) : items, dir);
  if (!target && !locked) {
    target = nearest(current, items, dir);
    const last = target && memory.get(target.closest('[data-group]'));
    if (last && items.includes(last)) target = last;
  }
  if (target) focus(target);
  return Boolean(target);
}

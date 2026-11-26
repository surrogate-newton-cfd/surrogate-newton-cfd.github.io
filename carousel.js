'use strict';

function mountHorizontalCarousel(track, onPage) {
  const slides = [...track.children];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let active = -1;
  let animation = 0;
  let drag;
  let suppressClick = false;
  let width = track.clientWidth;

  function slideLeft(index) {
    return slides[index].offsetLeft - slides[0].offsetLeft;
  }

  function nearest(left) {
    return slides.reduce((best, _, index) =>
      Math.abs(left - slideLeft(index)) < Math.abs(left - slideLeft(best)) ? index : best, 0);
  }

  function sync() {
    const index = nearest(track.scrollLeft);
    if (index === active) return;
    active = index;
    onPage(active);
  }

  function cancelAnimation() {
    if (!animation) return;
    cancelAnimationFrame(animation);
    animation = 0;
    track.style.removeProperty('scroll-snap-type');
  }

  function go(index) {
    if (!slides[index]) return;
    const from = track.scrollLeft;
    const to = slideLeft(index);
    cancelAnimation();
    if (reduced.matches || Math.abs(to - from) < 1) {
      track.scrollTo({left: to, behavior: 'instant'});
      sync();
      return;
    }
    track.style.scrollSnapType = 'none';
    const start = performance.now();
    const duration = Math.min(490, 300 + Math.abs(to - from) / 7);
    function advance(now) {
      const time = Math.min(1, (now - start) / duration);
      track.scrollLeft = from + (to - from) * time * time * (3 - 2 * time);
      if (time < 1) animation = requestAnimationFrame(advance);
      else {
        cancelAnimation();
        sync();
      }
    }
    animation = requestAnimationFrame(advance);
  }

  track.addEventListener('pointerdown', event => {
    cancelAnimation();
    suppressClick = false;
    drag = null;
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    if (event.target.closest('button, input, label, a, select, textarea')) return;
    const innerRail = event.target.closest('.design-cp-row');
    if (innerRail && innerRail.scrollWidth > innerRail.clientWidth) return;
    drag = {id: event.pointerId, x: event.clientX, y: event.clientY, left: track.scrollLeft, page: active};
  });

  track.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id || !(event.buttons & 1)) return;
    const dx = event.clientX - drag.x;
    if (!drag.moving) {
      if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(event.clientY - drag.y)) return;
      drag.moving = true;
      track.classList.add('is-dragging');
      track.setPointerCapture(drag.id);
    }
    event.preventDefault();
    track.scrollLeft = drag.left - dx;
  });

  function endDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const {moving, id, x, page} = drag;
    drag = null;
    if (!moving) return;
    suppressClick = true;
    track.classList.remove('is-dragging');
    if (track.hasPointerCapture(id)) track.releasePointerCapture(id);
    const dx = x - event.clientX;
    const threshold = Math.min(82, track.clientWidth * .18);
    const target = event.type === 'pointerup'
      ? page + (Math.abs(dx) >= threshold ? Math.sign(dx) : 0)
      : nearest(track.scrollLeft);
    go(Math.min(slides.length - 1, Math.max(0, target)));
  }

  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  track.addEventListener('lostpointercapture', endDrag);
  track.addEventListener('pointerleave', () => { if (drag && !drag.moving) drag = null; });
  track.addEventListener('click', event => {
    if (!event.detail) return;
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const index = slides.findIndex(slide => {
      const {left, right} = slide.getBoundingClientRect();
      return event.clientX >= left && event.clientX < right;
    });
    if (index >= 0 && index !== active) go(index);
  }, true);

  track.addEventListener('scroll', sync, {passive: true});
  track.addEventListener('wheel', cancelAnimation, {passive: true});
  track.addEventListener('keydown', event => {
    if (event.target !== track) return;
    const target = {ArrowLeft: active - 1, ArrowRight: active + 1, Home: 0, End: slides.length - 1}[event.key];
    if (target === undefined) return;
    event.preventDefault();
    go(target);
  });
  new ResizeObserver(() => {
    const next = track.clientWidth;
    if (!next || next === width) return;
    width = next;
    if (active >= 0 && !animation && !drag?.moving) {
      track.scrollTo({left: slideLeft(active), behavior: 'instant'});
    }
    sync();
  }).observe(track);
  sync();
  return go;
}

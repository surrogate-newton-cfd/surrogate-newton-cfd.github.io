'use strict';

(() => {
  const header = document.querySelector('.site-header');
  const tracks = [...document.querySelectorAll('.design-figure-track')];
  const trackCards = tracks.flatMap(track =>
    Array.from(track.children, card => ({
      track,
      card,
      title: card.querySelector('.design-result-heading h4'),
    })).filter(({title}) => Boolean(title)));
  const headings = [
    ...document.querySelectorAll('main h1, main h2, #design-history-title, .design-task-description h3'),
    ...trackCards.map(({title}) => title),
  ].map(node => ({node, y: 0}));
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(value, max));
  const ease = value => {
    const progress = clamp(value);
    return progress * progress * (3 - 2 * progress);
  };
  let frame = 0;

  for (const {node} of headings) node.classList.add('scroll-heading');

  function draw() {
    frame = 0;
    const reduced = reducedMotion.matches;
    const viewport = document.documentElement.clientHeight;
    const topEdge = header ? header.getBoundingClientRect().bottom : 0;
    const bottomEdge = viewport - 8;
    const entryDistance = clamp(viewport * .21, 92, 155);
    const vertical = headings.map(({node, y}) => {
      if (reduced) return {opacity: 1, nextY: 0};
      const bounds = node.getBoundingClientRect();
      const enter = ease((bottomEdge - (bounds.top - y)) / entryDistance);
      const exit = ease(((bounds.bottom - y) - topEdge) / 70);
      return {opacity: enter * exit, nextY: 23 * (1 - enter) - 13 * (1 - exit)};
    });
    const horizontal = trackCards.map(({track, card}) => {
      if (reduced || !card.offsetWidth) return {opacity: 1, x: 0};
      const distance = (card.offsetLeft - track.scrollLeft) / card.offsetWidth;
      return {opacity: .38 + .62 * (1 - ease(Math.abs(distance))), x: 19 * clamp(distance, -1, 1)};
    });

    headings.forEach((heading, index) => {
      const {opacity, nextY} = vertical[index];
      heading.y = Math.round(nextY * 100) / 100;
      heading.node.style.setProperty('--scroll-title-opacity', opacity.toFixed(3));
      heading.node.style.setProperty('--scroll-title-y', heading.y + 'px');
    });
    trackCards.forEach(({title}, index) => {
      const {opacity, x} = horizontal[index];
      title.style.setProperty('--slide-title-opacity', opacity.toFixed(3));
      title.style.setProperty('--slide-title-x', x.toFixed(2) + 'px');
    });
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  window.addEventListener('scroll', schedule, {passive: true});
  window.addEventListener('resize', schedule);
  for (const track of tracks) track.addEventListener('scroll', schedule, {passive: true});
  reducedMotion.addEventListener('change', schedule);
  document.fonts.ready.then(schedule);
  new ResizeObserver(schedule).observe(document.getElementById('main'));
  schedule();
})();

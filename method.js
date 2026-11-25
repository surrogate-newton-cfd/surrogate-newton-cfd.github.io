'use strict';

(() => {
  const diagram = document.querySelector('.method-diagram');
  const nodes = [...diagram.querySelectorAll('.method-node')];
  const stacked = matchMedia('(max-width: 900px)');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let framePending = false;

  function paint() {
    framePending = false;
    const firstNodeTop = nodes[0].getBoundingClientRect().top;
    for (const [index, node] of nodes.entries()) {
      if (node.hasAttribute('data-lit')) continue;
      const top = stacked.matches ? node.getBoundingClientRect().top : firstNodeTop;
      const threshold = stacked.matches ? 0.89 : 0.9 - 0.13 * index;
      if (reducedMotion.matches || top < innerHeight * threshold) {
        node.setAttribute('data-lit', '');
      }
    }
    if (nodes.every(node => node.hasAttribute('data-lit'))) {
      window.removeEventListener('scroll', schedulePaint);
      window.removeEventListener('resize', schedulePaint);
      reducedMotion.removeEventListener('change', schedulePaint);
    }
  }

  function schedulePaint() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(paint);
  }

  window.addEventListener('scroll', schedulePaint, { passive: true });
  window.addEventListener('resize', schedulePaint);
  reducedMotion.addEventListener('change', schedulePaint);
  schedulePaint();
})();

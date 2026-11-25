'use strict';

(() => {
  const video = document.getElementById('hero-flow-video');
  const canvas = document.getElementById('hero-flow-canvas');
  const context = canvas.getContext('2d', {alpha: false});
  const button = document.getElementById('hero-flow-play');
  const geometries = [...canvas.closest('figure').querySelectorAll('[data-case]')];
  const stages = document.getElementById('hero-flow-stages');
  const stageSurrogate = stages?.querySelector('[data-stage="surrogate"]');
  const stageArrow = stages?.querySelector('.hero-stage-arrow');
  const stageNk = stages?.querySelector('[data-stage="nk"]');
  const mse = document.getElementById('hero-flow-mse');
  const exponent = mse.querySelector('sup');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const clamp01 = value => Math.max(0, Math.min(1, value));
  let timeline;
  let activeCase = 0;
  let pendingCase = 0;
  let pendingFrame = null;
  let lastFrame = -1;
  let lastValue;
  let playbackRequested = false;

  function setPlayback(enabled) {
    playbackRequested = enabled;
    button.dataset.action = enabled ? 'pause' : 'play';
    button.setAttribute('aria-label', enabled ? 'Pause NK correction' : 'Play NK correction');
    if (!enabled) video.pause();
    else if (pendingCase === null) {
      video.play().catch(error => {
        if (error.name !== 'AbortError' && pendingCase === null) setPlayback(false);
      });
    }
  }

  function showMse(value) {
    if (value === lastValue) return;
    lastValue = value;
    if (value === 0) {
      mse.firstChild.nodeValue = '0';
      exponent.textContent = '';
      return;
    }
    const [mantissa, power] = value.toExponential(1).split('e');
    mse.firstChild.nodeValue = mantissa + ' × 10';
    exponent.textContent = String(Number(power)).replace('-', '−');
  }

  function paint(time) {
    if (!timeline || video.seeking || video.readyState < 2) return;
    const frame = Math.floor(time * timeline.fps + .001);
    if (pendingCase !== null && frame !== pendingFrame) return;
    if (frame === lastFrame && pendingCase === null) return;

    const index = timeline.cases.findLastIndex(chapter => frame >= chapter.startFrame);
    const chapter = timeline.cases[index];
    const sample = Math.min(frame - chapter.startFrame, chapter.mse.length - 1);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (lastFrame < 0) canvas.classList.add('has-frame');
    lastFrame = frame;
    showMse(chapter.mse[sample]);
    if (stageSurrogate && stageArrow && stageNk) {
      const pSurrogate = reducedMotion.matches && !playbackRequested ? 1 : clamp01(sample / 11);
      const pArrow = clamp01((sample - 9) / 4);
      const pNk = clamp01((sample - 11) / 78);
      stageSurrogate.style.setProperty('--stage-p', pSurrogate.toFixed(3));
      stageArrow.style.setProperty('--stage-p', pArrow.toFixed(3));
      stageNk.style.setProperty('--stage-p', pNk.toFixed(3));
    }

    if (index !== activeCase) {
      geometries[activeCase].setAttribute('aria-pressed', 'false');
      geometries[index].setAttribute('aria-pressed', 'true');
      activeCase = index;
    }
    if (pendingCase !== null) {
      pendingCase = pendingFrame = null;
      if (playbackRequested) setPlayback(true);
    }
  }

  function seekToChapter() {
    if (!timeline || video.readyState < 1 || pendingCase === null) return;
    pendingFrame = timeline.cases[pendingCase].entryFrame;
    video.pause();
    // Keep the previous painted frame visible until the requested frame can be drawn.
    video.currentTime = (pendingFrame + .25) / timeline.fps;
  }

  video.addEventListener('loadedmetadata', seekToChapter, {once: true});
  video.addEventListener('seeked', () => {
    const target = pendingFrame;
    // Some paused decoders don't notify requestVideoFrameCallback until playback resumes.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (target !== null && pendingFrame === target) paint(video.currentTime);
    }));
  });

  if ('requestVideoFrameCallback' in video) {
    const trackFrame = (_, frame) => {
      paint(frame.mediaTime);
      video.requestVideoFrameCallback(trackFrame);
    };
    video.requestVideoFrameCallback(trackFrame);
  } else {
    const trackFrame = () => {
      if (!video.paused) paint(video.currentTime);
      requestAnimationFrame(trackFrame);
    };
    requestAnimationFrame(trackFrame);
  }

  button.addEventListener('click', () => setPlayback(!playbackRequested));
  geometries.forEach((geometry, index) => {
    geometry.addEventListener('click', () => {
      if (index === (pendingCase ?? activeCase)) return;
      pendingCase = index;
      seekToChapter();
    });
  });

  fetch('assets/opening-nk-sequence.json')
    .then(response => {
      if (!response.ok) throw new Error('Could not load opening animation chapters');
      return response.json();
    })
    .then(data => {
      timeline = data;
      seekToChapter();
    })
    .catch(error => console.warn('Opening animation:', error));

  const observer = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    observer.disconnect();
    if (!reducedMotion.matches) setPlayback(true);
  }, {threshold: .5});
  observer.observe(canvas);
})();

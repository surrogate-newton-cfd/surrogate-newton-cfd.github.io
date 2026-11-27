'use strict';

const superscript = value => String(value).replace('-', '⁻').replace(/\d/g, n => '⁰¹²³⁴⁵⁶⁷⁸⁹'[n]);

function formatCaseConditions(mach, alpha, reynolds) {
  const angle = String(Number(alpha.toFixed(2))).replace('-', '−');
  const order = Math.floor(Math.log10(reynolds));
  const mantissa = Number((reynolds / 10 ** order).toPrecision(3));
  return `Ma ${Number(mach.toFixed(3))} · α ${angle}° · Re ${mantissa} × 10${superscript(order)}`;
}

function normalizeColdHistory(raw, grids) {
  // Fig. 6b: concatenate the relative coarse reductions in log space, then
  // map them from 1 to the first measured fine-grid residual ratio.
  const medium = grids[1].index, fine = grids[2].index;
  const coarseStart = raw[0][1], mediumStart = raw[medium][1];
  const reduction = raw[medium - 1][1] / coarseStart;
  const coarseEnd = reduction * raw[fine - 1][1] / mediumStart;
  const exponent = Math.log(raw[fine][1]) / Math.log(coarseEnd);
  const mapped = raw.map(([time, ratio], i) => {
    if (i >= fine) return [time, ratio];
    const relative = i < medium ? ratio / coarseStart : reduction * ratio / mediumStart;
    return [time, relative ** exponent];
  });
  if (mapped[0][0] > 0) mapped.unshift([0, 1]);
  return mapped;
}

(() => {
  const tablist = $('.closer-cases');
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const camera = {};
  let wingRequested = false;
  let wingObserver;
  let preparedWing;

  function prepareDefaultWing() {
    if (wingRequested || wingObserver || navigator.connection?.saveData) return;
    // Give the airfoil replay priority and prepare only the default wing, once this section is visible.
    wingObserver = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      wingObserver.disconnect();
      if (wingRequested) return;
      const directory = $('#closer-wing-case').value;
      const controller = new AbortController();
      const replay = fetchWingReplay(directory, controller.signal, 'low').catch(() => null);
      preparedWing = {directory, controller, replay};
    });
    wingObserver.observe($('#convergence-player'));
  }

  async function takeWingReplay(directory, signal) {
    wingRequested = true;
    wingObserver?.disconnect();
    const prepared = preparedWing;
    preparedWing = null;
    if (prepared?.directory !== directory) {
      prepared?.controller.abort();
      return fetchWingReplay(directory, signal);
    }
    const abort = () => prepared.controller.abort();
    signal.addEventListener('abort', abort, {once:true});
    try {
      const replay = await prepared.replay;
      signal.throwIfAborted();
      return replay ?? fetchWingReplay(directory, signal);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  function connectPicker(kind, mount, onReady) {
    const select = $(`#closer-${kind}-case`);
    const status = $(`#closer-${kind}-status`);
    const stage = select.closest('.convergence-hero');
    let controller, selected;
    function load() {
      if (selected === select.value) return;
      controller?.abort();
      controller = new AbortController();
      const {signal} = controller;
      selected = select.value;
      stage.dataset.loading = '';
      status.textContent = 'Loading case…';
      status.hidden = false;
      mount(selected, signal).then(() => {
        if (signal.aborted) return;
        status.hidden = true;
        delete stage.dataset.loading;
        onReady?.();
      }).catch(error => {
        if (signal.aborted) return;
        console.warn('Convergence replay:',error);
        selected = null;
        status.textContent = 'This case could not be loaded. Select it again to retry.';
      });
    }
    select.addEventListener('change',load);
    return load;
  }
  const loadAirfoil = connectPicker('airfoil', initFlowJourney, prepareDefaultWing);
  const loadWing = connectPicker('wing', async (directory, signal) => {
    const replay = await takeWingReplay(directory, signal);
    signal.throwIfAborted();
    initWingCase(replay, camera, signal);
  });

  function selectCase(selected) {
    for (const tab of tabs) {
      const active = tab === selected;
      tab.tabIndex = active ? 0 : -1;
      tab.setAttribute('aria-selected', String(active));
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
    }
    if (selected.id === 'closer-wing-tab') loadWing();
    else loadAirfoil();
  }

  tablist.addEventListener('click', event => {
    const tab = event.target.closest('[role="tab"]');
    if (tab) selectCase(tab);
  });
  tablist.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = tabs.indexOf(event.target);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (current + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
    selectCase(tabs[next]);
    tabs[next].focus();
  });
  // Decode the default replay before the reader reaches this section, not at page load.
  if (!('IntersectionObserver' in window) || ['#convergence', '#results', '#convergence-player'].includes(location.hash)) {
    loadAirfoil();
  } else {
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      loadAirfoil();
    }, {rootMargin: '650px 0px'});
    observer.observe($('#convergence-player'));
  }
})();

async function fetchWingReplay(caseDirectory, signal, priority = 'auto') {
  const directory = `assets/${caseDirectory}/`;
  const options = {signal, priority};
  function checked(response) {
    if (!response.ok) throw new Error(`Wing data unavailable (${response.status})`);
    return response;
  }
  const load = name => fetch(directory + name + '?v=all-wing-replays', options).then(checked);
  async function fields() {
    let response = await fetch(directory + 'sections-planar-delta.bin.gz', options);
    const packed = response.status !== 404;
    if (!packed) response = await load('sections.bin.gz');
    const stream = checked(response).body.pipeThrough(new DecompressionStream('gzip'));
    return {payload: await new Response(stream).arrayBuffer(), packed};
  }
  const [data, model, {payload, packed}, renderer] = await Promise.all([
    load('case.json').then(response => response.json()),
    load('sections.json').then(response => response.json()),
    fields(),
    import('./wing-orbit.js?v=packed-replay'),
  ]);
  return {data, model, payload, packed, renderer};
}

function initWingCase({data, model, payload, packed, renderer}, orientation, signal) {
  if (packed) renderer.unpackWingFields(payload, model);
  const panel = $('#closer-wing');
  const viewPort = $('.closer-wing-view');
  const view = renderer.createWingOrbit($('#closer-wing-canvas'), $('#closer-wing-reset-view'), payload, model, FIELD_DISPLAY.cp.stops, orientation, signal);
  const {mach, alpha_degrees, reynolds} = data.conditions;
  $('#closer-wing-conditions').textContent = formatCaseConditions(mach, alpha_degrees, reynolds);
  $('#closer-wing-mesh').textContent = `${(data.mesh_cells / 1e6).toFixed(2)}M cells · ${data.mpi_ranks} MPI ranks`;
  const chart = $('#closer-wing-chart');
  const time = $('#closer-wing-time');
  const play = $('#closer-wing-play');
  const replay = $('#closer-wing-replay');
  const scrub = $('#closer-wing-scrub');
  const series = ['warm', 'cold'].map(arm => {
    const {history: raw, grid_starts} = data.arms[arm];
    const history = arm === 'cold' ? normalizeColdHistory(raw, grid_starts) : raw;
    return {history, finish: history.at(-1)[0], fixed: arm === 'cold'};
  });
  showConvergenceTimes(chart, series);
  const end = series[0].finish;
  const pace = 16;
  $('#closer-wing-pace').textContent = `Playback ${pace}×`;
  $('.closer-wing-controls').hidden = false;
  const cold = data.arms.cold;
  const transfers = cold.grid_starts.slice(1).map(({index}) => cold.history[index][0]);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let wantsPlayback = !reduced.matches;
  let inView = false;
  let frame = 0;
  let shownTime = 0;
  let revealedTime = 0;
  let x, y, reveal, speedupCallout;
  let lastFrame = null;
  let lastPaint = null;
  let fieldIndex = 0;
  const canvas = $('#closer-wing-canvas');

  FIELD_DISPLAY.drawColorbar($('#closer-wing-cp'), {...FIELD_DISPLAY.cp, title: 'Surface pressure, Cₚ'});
  FIELD_DISPLAY.drawColorbar($('#closer-wing-mach'), FIELD_DISPLAY.mach);
  function updateField(t) {
    const arm = fieldIndex === 0 ? 'warm' : 'cold';
    const terminal = arm === 'cold' || t >= end;
    view.setTime(terminal ? series[fieldIndex].finish : t, arm);
  }

  function selectField(index) {
    fieldIndex = index;
    const method = index === 0 ? 'Surrogate + NK' : 'Cold-start CFD';
    canvas.setAttribute('aria-label', `${data.name}, ${method}. Surface pressure, sectional Mach and pressure-gradient contours. Drag or use the arrow keys to rotate.`);
    updateField(shownTime);
  }
  selectField(0);

  function residualAt(history, t) {
    let lo = 0;
    let hi = history.length - 1;
    if (t <= history[0][0]) return history[0][1];
    if (t >= history[hi][0]) return history[hi][1];
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (history[mid][0] <= t) lo = mid;
      else hi = mid;
    }
    const [ta, ra] = history[lo];
    const [tb, rb] = history[hi];
    return ra * (rb / ra) ** ((t - ta) / (tb - ta));
  }

  function update(t) {
    shownTime = t;
    updateField(t);
    revealedTime = Math.max(revealedTime, t);
    showPlaybackTime(time, scrub, t, end, pace);
    chart.setAttribute('aria-valuenow', t.toFixed(2));
    const readouts = series.map((line, i) => {
      const cursor = i === 1 ? line.finish : Math.max(line.history[0][0], Math.min(t, line.finish));
      const ratio = residualAt(line.history, cursor);
      if (line.marker) {
        line.marker.setAttribute('cx', x(cursor));
        line.marker.setAttribute('cy', y(ratio));
      }
      return ratio.toExponential(2);
    });
    chart.setAttribute('aria-valuetext', `Solver time ${t.toFixed(2)} seconds. Surrogate + NK residual ${readouts[0]}. Cold-start CFD final residual ${readouts[1]}.`);
    if (reveal) reveal.setAttribute('width', x(revealedTime) - x(0));
    if (speedupCallout) speedupCallout.setAttribute('visibility', revealedTime >= end ? 'visible' : 'hidden');
  }

  function drawChart() {
    if (signal.aborted || panel.hidden) return;
    let markers;
    ({X:x, Y:y, reveal, markers, speedupCallout} = drawConvergenceChart(chart, series, -6, transfers));
    series.forEach((line, index) => { line.marker = markers[index]; });
    update(shownTime);
  }

  function syncControls() {
    play.textContent = wantsPlayback ? 'Ⅱ' : '▶';
    play.setAttribute('aria-label', wantsPlayback ? 'Pause NK correction' : 'Play NK correction');
  }

  function syncPlayback() {
    if (signal.aborted || !wantsPlayback || !inView || panel.hidden || document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
      lastFrame = null;
      lastPaint = null;
      return;
    }
    if (!frame) frame = requestAnimationFrame(paint);
  }

  function seek(t) {
    update(Math.min(end, Math.max(0, t)));
  }

  function inspect(t) {
    wantsPlayback = false;
    syncPlayback();
    seek(t);
    syncControls();
  }

  let solverTime = 0;
  function paint(now) {
    frame = 0;
    if (signal.aborted || !wantsPlayback || !inView || panel.hidden || document.hidden) return syncPlayback();
    if (lastFrame !== null) solverTime = Math.min(end, solverTime + pace * (now - lastFrame) / 1000);
    lastFrame = now;
    if (lastPaint === null || now - lastPaint >= 32 || solverTime >= end) {
      seek(solverTime);
      lastPaint = now;
    }
    if (solverTime >= end) {
      wantsPlayback = false;
      syncControls();
    }
    syncPlayback();
  }

  play.addEventListener('click', () => {
    wantsPlayback = !wantsPlayback;
    if (wantsPlayback) {
      if (shownTime >= end || fieldIndex === 1) {
        revealedTime = 0;
        seek(0);
      }
      solverTime = shownTime;
      selectField(0);
    }
    syncPlayback();
    syncControls();
  },{signal});
  replay.addEventListener('click', () => {
    revealedTime = 0;
    solverTime = 0;
    seek(0);
    selectField(0);
    wantsPlayback = true;
    syncPlayback();
    syncControls();
  },{signal});
  scrub.addEventListener('input', () => {
    selectField(0);
    inspect(Number(scrub.value) / 1000 * end);
  },{signal});
  for (const control of [play, replay, scrub]) control.disabled = false;
  // Wing residual chart is display-only; replay and drag-to-rotate stay available.
  const chartResize = new ResizeObserver(drawChart);
  chartResize.observe(chart);
  const visibility = new IntersectionObserver(([entry]) => {
    inView = entry.intersectionRatio >= .5;
    syncPlayback();
  },{threshold:[0,.5]});
  visibility.observe(viewPort);
  document.addEventListener('visibilitychange', syncPlayback,{signal});
  signal.addEventListener('abort',() => {
    cancelAnimationFrame(frame);
    chartResize.disconnect();
    visibility.disconnect();
    for (const control of [play, replay, scrub]) control.disabled = true;
  },{once:true});
  seek(wantsPlayback ? 0 : end);
  drawChart();
  syncControls();
}

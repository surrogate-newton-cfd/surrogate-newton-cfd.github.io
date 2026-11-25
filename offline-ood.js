'use strict';

(() => {
  const section = document.getElementById('offline-ood');
  const metrics = {
    field_mse: 'Field MSE',
    force_error: 'Force error',
  };
  const tabs = [...section.querySelectorAll('.ood-family-tabs button')];
  function selectTab(active) {
    for (const tab of tabs) {
      const selected = tab === active;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
    }
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      const nextIndex = {ArrowRight: 1 - index, ArrowLeft: 1 - index, Home: 0, End: tabs.length - 1}[event.key];
      if (nextIndex === undefined) return;
      event.preventDefault();
      selectTab(tabs[nextIndex]);
      tabs[nextIndex].focus();
    });
  }
  const names = {
    prediction: 'Surrogate',
    correction: 'Surrogate + NK',
    cold: 'Cold-start CFD',
    nearest: '1-NN + NK',
  };
  const fractionMeta = [
    {id: 's0p1', label: '0.1% data'},
    {id: 's1', label: '1% data'},
    {id: 's3', label: '3% data'},
    {id: 's5', label: '5% data'},
    {id: 's10', label: '10% data'},
    {id: 'full', label: '100% data'},
  ];
  const styles = {
    full: 'none',
    s10: 'none',
    s5: 'none',
    s3: 'none',
    s1: 'none',
    s0p1: 'none',
    correction: 'none',
    cold: '5 3',
    nearest: '2 3',
  };
  const digits = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  const power = exponent => '10' + String(exponent).replace(/[-0-9]/g, digit =>
    digit === '-' ? '⁻' : digits[Number(digit)]);
  const scientific = value => {
    const [coefficient, exponent] = value.toExponential(1).split('e');
    return coefficient + ' × ' + power(Number(exponent));
  };
  const formatGain = ratio => {
    if (ratio >= 1e6) return '>10⁶× lower';
    if (ratio >= 1000) return Math.round(ratio).toLocaleString('en-US') + '× lower';
    return Math.round(ratio) + '× lower';
  };

  function pair(container, values, labels) {
    const [before, after] = values.map(value => {
      const node = document.createElement('strong');
      node.textContent = value;
      return node;
    });
    const arrow = document.createElement('span');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '→';
    container.setAttribute('aria-label', `${labels[0]} ${values[0]}, ${labels[1]} ${values[1]}`);
    container.replaceChildren(before, arrow, after);
  }

  function axes(chart, options) {
    const width = chart.clientWidth;
    const height = chart.clientHeight;
    if (!width || !height) return null;
    const left = 55, right = width - 13, top = 10, bottom = height - 39;
    const X = value => left + options.x(value) * (right - left);
    const Y = value => bottom - options.y(value) * (bottom - top);
    chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
    chart.replaceChildren();
    for (const [value, label] of options.yTicks) {
      const y = Y(value);
      svg('line', {x1: left, x2: right, y1: y, y2: y, stroke: '#e8e8eb'}, chart);
      svg('text', {x: left - 7, y: y + 4, 'text-anchor': 'end'}, chart).textContent = label;
    }
    svg('path', {d: `M${left} ${top}V${bottom}H${right}`, fill: 'none', stroke: '#aaaab1'}, chart);
    for (const [value, label] of options.xTicks) {
      const x = X(value);
      svg('line', {x1: x, x2: x, y1: bottom, y2: bottom + 4, stroke: '#aaaab1'}, chart);
      svg('text', {x, y: bottom + 17, 'text-anchor': 'middle'}, chart).textContent = label;
    }
    const middle = (top + bottom) / 2;
    svg('text', {x: 12, y: middle, transform: `rotate(-90 12 ${middle})`,
      'text-anchor': 'middle', class: 'ood-axis-title'}, chart).textContent = options.yLabel;
    svg('text', {x: (left + right) / 2, y: height - 5, 'text-anchor': 'middle',
      class: 'ood-axis-title'}, chart).textContent = options.xLabel;
    const id = chart.closest('.ood-card').id + '-' + options.kind;
    const clip = svg('clipPath', {id}, svg('defs', {}, chart));
    svg('rect', {x: left, y: top, width: right - left, height: bottom - top}, clip);
    return {X, Y, left, right, top, bottom, group: svg('g', {'clip-path': `url(#${id})`}, chart)};
  }

  function plotDensity(chart, family, metric, data, visible) {
    const {edges, heights, medians, cases} = data;
    const low = edges[0], high = edges.at(-1);
    const step = Math.max(1, Math.ceil((high - low) / (chart.clientWidth < 340 ? 4 : 5)));
    const ticks = [];
    for (let exponent = Math.ceil(low + .1); exponent < high - .05; exponent += step) {
      ticks.push([exponent, power(exponent)]);
    }
    const peak = Math.max(...heights.flat());
    const unit = 10 ** Math.floor(Math.log10(peak));
    const interval = [1, 2, 2.5, 5, 10].map(factor => factor * unit).find(value => value >= peak / 3);
    const ceiling = interval * Math.ceil(peak * 1.08 / interval);
    const levels = Array.from({length: 1 + Math.round(ceiling / interval)}, (_, i) => i * interval);
    const metricLabel = metrics[metric];
    const frame = axes(chart, {
      kind: 'density', x: value => (value - low) / (high - low), y: value => value / ceiling,
      xTicks: ticks, yTicks: levels.map(value => [value, String(Number(value.toPrecision(2)))]),
      xLabel: metricLabel, yLabel: 'Density / log decade',
    });
    if (!frame) return;
    const {X, Y, bottom, group} = frame;
    const quantity = metric === 'field_mse' && family === 'wings' ? 'Field MSE of nondimensional pressure' : metricLabel;
    chart.setAttribute('aria-label', `${quantity} distribution over ${cases.toLocaleString('en-US')} paired cases. ` +
      `Logarithmic horizontal axis. Median ${scientific(medians[0])} for the surrogate, ` +
      `${scientific(medians[1])} after NK correction.`);

    ['prediction', 'correction'].forEach((id, method) => {
      if (!visible.has(id)) return;
      const bins = heights[method];
      const color = `var(--ood-${id})`;
      const outline = bins.flatMap((height, index) =>
        [[X(edges[index]), Y(height)], [X(edges[index + 1]), Y(height)]]);
      const line = outline.map(point => point.map(value => value.toFixed(2)).join(' ')).join('L');
      const shape = `M${X(low)} ${bottom}L${line}L${X(high)} ${bottom}Z`;
      svg('path', {d: shape, fill: color, 'fill-opacity': .18, 'data-method': id}, group);
      svg('path', {d: 'M' + line, fill: 'none', stroke: color, 'stroke-width': 1.45,
        'stroke-linejoin': 'round'}, group);
      const x = X(Math.log10(medians[method]));
      svg('line', {x1: x, x2: x, y1: Y(ceiling * .92), y2: bottom, stroke: color,
        opacity: .75, 'stroke-width': 1.2, 'stroke-dasharray': '3 3'}, group);
    });
  }

  function plotTime(chart, entries, wings, transfers = []) {
    const range = wings ? [6e-7, 2] : [2e-9, 1.5];
    const target = wings ? 1e-6 : 1e-8;
    const times = wings ? [0, 100, 200, 300, 400, 500] : [0, 3, 6, 9, 12];
    const limit = times.at(-1);
    const levels = wings ? [0, -2, -4, -6] : [0, -2, -4, -6, -8];
    const frame = axes(chart, {
      kind: 'convergence', x: value => value / limit,
      y: value => Math.log10(value / range[0]) / Math.log10(range[1] / range[0]),
      xTicks: times.map(value => [value, value]), yTicks: levels.map(value => [10 ** value, value ? power(value) : '1']),
      xLabel: 'Solver time (s)', yLabel: 'Residual ratio',
    });
    if (!frame) return;
    const {X, Y, group, left, right, top, bottom} = frame;
    chart.setAttribute('aria-label', `Median residual ratio over time for ${wings ? 60 : 200} matched cases. ` +
      `Residual target ${target}. Shading spans the 25th to 75th percentiles for the displayed bands.`);
    svg('line', {x1: left, x2: right, y1: Y(target), y2: Y(target),
      stroke: '#909099', 'stroke-dasharray': '4 4'}, group);
    for (const transfer of transfers) {
      svg('line', {x1: X(transfer), x2: X(transfer), y1: top, y2: bottom, stroke: '#c4c4cb',
        'stroke-dasharray': '3 4'}, group);
    }

    function coordinates(points, column) {
      return points.map(point => `${X(point[0]).toFixed(2)} ${Y(point[column]).toFixed(2)}`).join('L');
    }

    for (const {id, data, band} of entries) {
      if (!band) continue;
      const d = 'M' + coordinates(data.points, 2) + 'L' + coordinates([...data.points].reverse(), 3) + 'Z';
      svg('path', {d, fill: `var(--ood-${id})`, 'fill-opacity': .14, 'data-band': id}, group);
    }
    for (const {id, data} of entries) {
      const color = `var(--ood-${id})`;
      const strokeWidth = id === 'full' || id === 'correction' ? 2.15 : 1.85;
      svg('path', {d: 'M' + coordinates(data.points, 1), fill: 'none', stroke: color, 'stroke-width': strokeWidth,
        'stroke-dasharray': styles[id] || 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'data-method': id}, group);
      const [endTime, endResidual] = data.points.at(-1);
      svg('circle', {cx: X(endTime), cy: Y(endResidual), r: 3, fill: color, stroke: '#fff',
        'stroke-width': 1, 'data-endpoint': id}, group);
    }
  }

  // Visible x-range per geometry view (log axis); long, near-empty tails are clipped and marked.
  const distanceView = {section: {max: 3.5, ticks: [0.3, 1, 3]}, planform: {max: 30, ticks: [0.3, 1, 3, 10, 30]}};

  function plotGeometryDistance(chart, data, mode) {
    const {counts, outside, heights} = data;
    const view = distanceView[mode];
    const ticks = view ? view.ticks : data.ticks;
    const width = chart.clientWidth;
    const height = chart.clientHeight;
    if (!width || !height) return;
    const left = 20, right = width - 16, top = 18, bottom = height - 21;
    const fullLow = Math.log10(data.ticks[0]), fullHigh = Math.log10(data.ticks.at(-1));
    const low = Math.log10(ticks[0]), high = view ? Math.log10(view.max) : fullHigh;
    const X = value => left + (Math.log10(value) - low) / (high - low) * (right - left);
    const sampleLog = (i, n) => fullLow + i / (n - 1) * (fullHigh - fullLow);
    const peak = Math.max(...heights.flat());
    const boundary = X(1);
    chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
    chart.setAttribute('aria-label', `Training and benchmark geometry distance densities. ` +
      `${outside.toLocaleString('en-US')} of ${counts[1].toLocaleString('en-US')} benchmark geometries exceed the training 99th percentile.`);
    chart.replaceChildren();
    svg('rect', {x: boundary, y: top, width: right - boundary, height: bottom - top, fill: '#f6f7f7'}, chart);
    for (const [index, cohort] of ['training', 'benchmark'].entries()) {
      const values = heights[index];
      const n = values.length;
      const points = [];
      let clipped = 0, total = 0;
      values.forEach((value, i) => {
        total += value;
        const lg = sampleLog(i, n);
        if (lg > high + 1e-9) { clipped += value; return; }
        const x = left + (lg - low) / (high - low) * (right - left);
        points.push(`${x.toFixed(2)} ${(bottom - value / peak * (bottom - top - 2)).toFixed(2)}`);
      });
      const coordinates = points.join('L');
      const lastX = points.at(-1).split(' ')[0];
      const color = `var(--ood-${cohort}-geometry)`;
      svg('path', {d: `M${left} ${bottom}L${coordinates}L${lastX} ${bottom}Z`,
        fill: color, 'fill-opacity': .14}, chart);
      svg('path', {d: 'M' + coordinates, fill: 'none', stroke: color, 'stroke-width': 1.45,
        'stroke-linejoin': 'round', 'data-cohort': cohort}, chart);
      if (total && clipped / total > 1e-3) {
        // Boundary triangle: distribution continues beyond the plotted range.
        svg('path', {d: `M${right} ${bottom - 9}l6 4.5l-6 4.5Z`, fill: color}, chart);
      }
    }
    svg('line', {x1: boundary, x2: boundary, y1: top, y2: bottom,
      stroke: '#878790', 'stroke-dasharray': '3 3'}, chart);
    svg('text', {x: boundary, y: 13, 'text-anchor': 'middle'}, chart).textContent = 'Training P99';
    svg('line', {x1: left, x2: right, y1: bottom, y2: bottom, stroke: '#aaaab1'}, chart);
    for (const tick of ticks) {
      const x = X(tick);
      svg('line', {x1: x, x2: x, y1: bottom, y2: bottom + 4, stroke: '#aaaab1'}, chart);
      svg('text', {x, y: bottom + 17, 'text-anchor': 'middle'}, chart).textContent = tick;
    }
  }

  function mountGeometry(panel, geometry) {
    const container = panel.querySelector('.ood-geometry');
    container.append(document.getElementById('ood-geometry-template').content.cloneNode(true));
    const chart = container.querySelector('.ood-geometry-distance');
    const picker = container.querySelector('.ood-geometry-picker');
    const figures = container.querySelectorAll('.ood-shape-group');
    const labels = {airfoils: 'Airfoil profiles', section: 'Kink section profiles', planform: 'Wing planforms'};
    let selected = picker?.querySelector('[aria-pressed="true"]');
    let mode = selected?.dataset.geometry ?? 'airfoils';

    function drawDistance() {
      plotGeometryDistance(chart, geometry[mode], mode);
    }

    function draw() {
      const {shapes, counts, outside} = geometry[mode];
      container.dataset.geometryView = mode;
      figures.forEach((figure, index) => {
        const shape = figure.querySelector('svg');
        const count = counts[index].toLocaleString('en-US');
        shape.setAttribute('aria-label', `${labels[mode]}, representative outlines from ${count} ${figure.dataset.cohort} geometries.`);
        shape.replaceChildren();
        for (const d of shapes[index]) svg('path', {d}, shape);
      });
      container.querySelector('.ood-beyond').textContent = (100 * outside / counts[1]).toFixed(1) + '%';
      const nouns = {airfoils: 'benchmark airfoils', section: 'benchmark wing sections', planform: 'benchmark wing planforms'};
      container.querySelector('.ood-beyond-label').textContent = `of ${nouns[mode]} lie beyond the training P99`;
      container.querySelector('.ood-beyond-count').textContent = 'd₅* > 1: farther from its five nearest training shapes than 99% of training shapes are from theirs';
      drawDistance();
    }

    picker?.addEventListener('click', event => {
      const button = event.target.closest('button[data-geometry]');
      if (!button || selected === button) return;
      selected.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-pressed', 'true');
      selected = button;
      mode = button.dataset.geometry;
      draw();
    });
    draw();
    return drawDistance;
  }

  function mount(data) {
    Object.entries(data).forEach(([family, series]) => {
      const panel = document.getElementById('ood-' + family);
      const density = panel.querySelector('.ood-density');
      const time = panel.querySelector('.ood-convergence-chart');
      const picker = panel.querySelector('.ood-metric-picker');
      const cardLegend = panel.querySelector('.ood-card-legend');
      const errorGain = panel.querySelector('.ood-error-gain');
      const timeGain = panel.querySelector('.ood-time-gain');
      const toggles = panel.querySelector('#ood-training-toggles');
      const timeDetail = panel.querySelector('.ood-time-detail');
      const wings = family === 'wings';
      const visibleAccuracy = new Set(['prediction', 'correction']);
      const visibleTime = new Set(['full', 'cold']);
      let selectedMetric = picker.querySelector('[aria-pressed="true"]');
      const drawGeometryDistance = mountGeometry(panel, series.geometry);

      function accuracy() {
        const metric = selectedMetric.dataset.metric;
        const entry = series.metrics[metric];
        pair(panel.querySelector('.ood-error-values'), entry.medians.map(scientific), [names.prediction, names.correction]);
        if (errorGain) errorGain.textContent = formatGain(entry.medians[0] / entry.medians[1]);
        plotDensity(density, family, metric, entry, visibleAccuracy);
      }

      function convergence() {
        if (wings) {
          const {histories, transfers, speedup} = series.convergence;
          const {cold, warm} = histories;
          plotTime(time, [
            {id: 'cold', data: cold, band: true},
            {id: 'correction', data: warm, band: true},
          ], true, transfers);
          pair(panel.querySelector('.ood-time-values'),
            ['472 s', '89 s'], [names.cold, names.correction]); // paper: medians over 60 matched converged cases
          if (timeGain) timeGain.textContent = (speedup || (cold.time / warm.time)).toFixed(1) + '× faster';
        } else {
          const conv = series.convergence;
          const cold = conv.uniform;
          const full = conv.full;
          const entries = [];
          if (visibleTime.has('cold')) entries.push({id: 'cold', data: cold, band: true});
          if (visibleTime.has('nearest')) entries.push({id: 'nearest', data: conv.one_nn});
          for (const {id} of fractionMeta) {
            if (!visibleTime.has(id) || !conv[id]) continue;
            entries.push({id, data: conv[id], band: id === 'full'});
          }
          plotTime(time, entries, false);
          for (const item of panel.querySelectorAll('.ood-time-legend [data-series]')) {
            item.hidden = !visibleTime.has(item.dataset.series);
          }
          pair(panel.querySelector('.ood-time-values'),
            [cold.time, full.time].map(value => value.toFixed(2) + ' s'), [names.cold, names.correction]);
          if (timeGain) timeGain.textContent = '5.8× faster'; // paper headline: median solver time at termination
          if (timeDetail) {
            const parts = ['200 paired cases'];
            for (const {id, label} of [...fractionMeta].reverse()) {
              if (id === 'full' || !visibleTime.has(id) || !conv[id]) continue;
              const t = conv[id].time;
              parts.push(`${label}: ${t.toFixed(2)} s (${(cold.time / t).toFixed(1)}×)`);
            }
            if (visibleTime.has('nearest')) parts.push(`1-NN + NK: ${conv.one_nn.time.toFixed(2)} s`);
            timeDetail.textContent = parts.join(' · ');
          }
        }
      }

      picker.addEventListener('click', event => {
        const button = event.target.closest('button[data-metric]');
        if (!button || selectedMetric === button) return;
        selectedMetric.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-pressed', 'true');
        selectedMetric = button;
        accuracy();
      });

      cardLegend?.addEventListener('change', event => {
        const method = event.target.closest('[data-method]')?.dataset.method;
        if (!method) return;
        if (event.target.checked) visibleAccuracy.add(method);
        else visibleAccuracy.delete(method);
        accuracy();
      });

      toggles?.addEventListener('change', event => {
        const input = event.target.closest('input[type="checkbox"]');
        if (!input) return;
        if (input.checked) visibleTime.add(input.value);
        else visibleTime.delete(input.value);
        convergence();
      });

      accuracy();
      convergence();
      new ResizeObserver(() => requestAnimationFrame(() => {
        drawGeometryDistance();
        accuracy();
        convergence();
      })).observe(panel);
    });
  }

  async function load() {
    try {
      const response = await fetch('assets/offline-ood.json?v=fig6c-1085');
      if (!response.ok) throw new Error(`OOD data returned ${response.status}`);
      mount(await response.json());
    } catch (error) {
      console.warn('Offline OOD evaluation:', error);
      const status = document.getElementById('ood-status');
      status.hidden = false;
      status.textContent = 'Offline test results could not be loaded.';
    }
  }

  if (location.hash === '#offline-ood') load();
  else {
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      load();
    }, {rootMargin: '600px 0px'});
    observer.observe(section);
  }
})();

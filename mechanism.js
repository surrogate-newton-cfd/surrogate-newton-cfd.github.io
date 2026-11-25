'use strict';

(() => {
  const section = document.getElementById('mechanism');
  const controls = document.getElementById('mechanism-control');
  const chart = document.getElementById('mechanism-chart');
  const note = document.getElementById('mechanism-control-note');
  const legend = document.getElementById('mechanism-series');
  const scenarios = {
    solver: {
      noteHtml: 'NK from both starts — <b>49× faster</b> in this case.',
      noteText: 'NK from both starts — 49× faster in this case.',
      range: 125,
      ticks: [0, .1, 1, 10, 100],
      series: [
        {trace: 'warm', label: 'Surrogate start', color: 'surrogate'},
        {trace: 'matched', label: 'Pseudo-time start', color: 'pseudo'},
      ],
    },
    start: {
      noteHtml: 'From surrogate start — <b>163× faster</b> with NK in this case.',
      noteText: 'From surrogate start — 163× faster with NK in this case.',
      range: 440,
      ticks: [0, .1, 1, 10, 100, 400],
      series: [
        {trace: 'warm', label: 'NK correction', color: 'surrogate'},
        {trace: 'march', label: 'Pseudo-time marching', color: 'surrogate', dashed: true},
      ],
    },
  };

  const initializations = {surrogate: 'Surrogate', pseudo: 'Pseudo-time', uniform: 'Uniform'};
  const margins = [
    {id: 'chi', min: -100, ticks: [[-10, '−10'], [-1, '−1'], [0, '0'], [1, '1']], label: 'Local correctability, χ₀'},
    {id: 'kappa', min: -1e10, ticks: [[-1e8, '−10⁸'], [-1e4, '−10⁴'], [0, '0'], [1, '1']], label: 'Convergence margin, κ₀'},
  ];

  function drawMargin(chart, margin, series) {
    const width = chart.clientWidth;
    const height = chart.clientHeight;
    const left = 63, right = width - 16, top = 13, bottom = height - 40;
    // Figure 4b uses a symmetric-log scale with a linear interval from −1 to 1.
    const linear = 2.5 / .9;
    const symlog = value => Math.abs(value) <= 1 ? value * linear
      : Math.sign(value) * (linear + Math.log10(Math.abs(value)));
    const min = symlog(margin.min);
    const X = value => left + (symlog(value) - min) / (linear - min) * (right - left);
    const Y = share => bottom - share * (bottom - top);
    const zero = X(0);
    chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
    chart.replaceChildren();
    svg('rect', {x: zero, y: top, width: right - zero, height: bottom - top, fill: '#edf3f5'}, chart);
    for (const share of [0, .5, 1]) {
      const y = Y(share);
      svg('line', {x1: left, x2: right, y1: y, y2: y, stroke: '#e8e8eb'}, chart);
      svg('text', {x: left - 7, y: y + 4, 'text-anchor': 'end'}, chart).textContent = `${100 * share}%`;
    }
    svg('path', {d: `M${left} ${top}V${bottom}H${right}`, fill: 'none', stroke: '#a6a6af'}, chart);
    for (const [value, label] of margin.ticks) {
      const x = X(value);
      svg('line', {x1: x, x2: x, y1: bottom, y2: bottom + 4, stroke: '#a6a6af'}, chart);
      svg('text', {x, y: bottom + 17, 'text-anchor': 'middle'}, chart).textContent = label;
    }
    const middle = (top + bottom) / 2;
    svg('text', {x: 13, y: middle, transform: `rotate(-90 13 ${middle})`, 'text-anchor': 'middle',
      class: 'mechanism-axis-label'}, chart).textContent = 'Cumulative fraction';
    svg('text', {x: (left + right) / 2, y: height - 4, 'text-anchor': 'middle',
      class: 'mechanism-axis-label'}, chart).textContent = margin.label;
    const weight = Math.min(1.45, (right - left) / 280);
    for (const {arm, bars, below, count} of series) {
      const color = `var(--mechanism-${arm})`;
      const group = svg('g', {stroke: color, 'stroke-width': weight * (arm === 'surrogate' ? 1 : .82),
        opacity: arm === 'surrogate' ? 1 : .83, 'data-arm': arm}, chart);
      for (const [threshold, fraction] of bars) {
        const x = X(threshold);
        svg('line', {x1: x, x2: x, y1: bottom, y2: Y(fraction)}, group);
      }
      if (below) {
        const y = Y(below / count);
        svg('path', {d: `M${left - 4} ${y}l6,-3v6Z`, fill: color, stroke: 'white', 'stroke-width': .8}, group);
      }
    }
    svg('line', {x1: zero, x2: zero, y1: top, y2: bottom,
      stroke: '#71717a', 'stroke-dasharray': '3 4'}, chart);
  }

  function renderDiagnostics(diagnostics) {
    margins.forEach((margin, index) => {
      const group = section.querySelector(`[data-margin="${margin.id}"]`);
      const chart = group.querySelector('.mechanism-margin-chart');
      const summary = group.querySelector('.mechanism-margin-summary');
      const series = Object.entries(initializations).map(([arm, label]) => {
        const recorded = diagnostics[arm][index];
        const {positive, count} = recorded;
        const percent = (100 * positive / count).toFixed(0) + '%';
        const item = summary.appendChild(document.createElement('div'));
        item.dataset.arm = arm;
        item.style.setProperty('--mechanism-color', `var(--mechanism-${arm})`);
        item.title = `${positive} of ${count} measured cases`;
        const name = document.createElement('span');
        const mark = document.createElement('i');
        mark.setAttribute('aria-hidden', 'true');
        name.append(mark, label);
        const value = document.createElement('strong');
        value.textContent = percent;
        item.append(name, value);
        return {arm, label, ...recorded, percent};
      });
      chart.setAttribute('aria-label', `${margin.label}. Cumulative fractions sampled at interleaved positions on a symmetric-log margin axis. ` +
        series.map(({label, percent}) => `${label}: ${percent} positive.`).join(' '));
      const draw = () => drawMargin(chart, margin, series);
      new ResizeObserver(() => requestAnimationFrame(draw)).observe(chart);
      draw();
    });
  }

  function renderChart(scenario, traces) {
    const width = chart.clientWidth;
    const height = chart.clientHeight;
    const left = 54, right = width - 17, top = 11, bottom = height - 43;
    const scale = value => Math.log10(1 + value / .1);
    const X = value => left + scale(value) / scale(scenario.range) * (right - left);
    const Y = value => top + (-2 - Math.log10(value)) / (-2 - Math.log10(2e-9)) * (bottom - top);
    chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
    chart.replaceChildren();
    for (const [value, label] of [[1e-2, '10⁻²'], [1e-4, '10⁻⁴'], [1e-6, '10⁻⁶'], [1e-8, '10⁻⁸']]) {
      const y = Y(value);
      svg('line', {x1: left, x2: right, y1: y, y2: y, stroke: value === 1e-8 ? '#88888f' : '#e8e8eb',
        'stroke-dasharray': value === 1e-8 ? '3 4' : 'none'}, chart);
      svg('text', {x: left - 7, y: y + 4, 'text-anchor': 'end'}, chart).textContent = label;
    }
    svg('path', {d: `M${left} ${top}V${bottom}H${right}`, fill: 'none', stroke: '#a6a6af'}, chart);
    for (const tick of scenario.ticks) {
      const x = X(tick);
      svg('line', {x1: x, x2: x, y1: bottom, y2: bottom + 4, stroke: '#a6a6af'}, chart);
      svg('text', {x, y: bottom + 18, 'text-anchor': 'middle'}, chart).textContent = tick;
    }
    const middle = (top + bottom) / 2;
    svg('text', {x: 13, y: middle, transform: `rotate(-90 13 ${middle})`, 'text-anchor': 'middle',
      class: 'mechanism-axis-label'}, chart).textContent = 'Residual ratio';
    svg('text', {x: (left + right) / 2, y: height - 4, 'text-anchor': 'middle',
      class: 'mechanism-axis-label'}, chart).textContent = 'Solver time (s, log scale)';
    for (const {trace, color, dashed} of scenario.series) {
      const points = traces[trace];
      const path = points.map(([t, r]) => `${X(t).toFixed(2)} ${Y(r).toFixed(2)}`).join('L');
      const stroke = `var(--mechanism-${color})`;
      svg('path', {d: 'M' + path, fill: 'none', stroke, 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-dasharray': dashed ? '5 4' : 'none', 'data-trace': trace}, chart);
      const [time, residual] = points.at(-1);
      svg('circle', {cx: X(time), cy: Y(residual), r: 3.5, fill: 'white', stroke, 'stroke-width': 1.5}, chart);
    }
  }

  function mount({traces, diagnostics, stateMSE, pressureColors}) {
    section.querySelectorAll('[data-mse]').forEach(node => {
      node.textContent = stateMSE[Number(node.dataset.mse)].toFixed(3);
    });
    section.querySelectorAll('[data-initial-residual]').forEach(node => {
      const [mantissa, exponent] = traces[node.dataset.initialResidual][0][1].toExponential(2).split('e');
      const raised = exponent.replace(/[-0-9]/g, digit => digit === '-' ? '⁻' : '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(digit)]);
      node.textContent = `${mantissa} × 10${raised}`;
    });
    section.style.setProperty('--mechanism-pressure-scale', `linear-gradient(to right, ${pressureColors.join(', ')})`);
    renderDiagnostics(diagnostics);
    let selected = controls.querySelector('[aria-pressed="true"]');
    let scenario = scenarios[selected.dataset.comparison];

    function update() {
      note.innerHTML = scenario.noteHtml;
      legend.replaceChildren();
      const descriptions = [];
      for (const {trace, label, color, dashed} of scenario.series) {
        const [seconds] = traces[trace].at(-1);
        const time = seconds.toFixed(seconds < 10 ? 2 : seconds < 100 ? 1 : 0) + ' s';
        const row = legend.appendChild(document.createElement('div'));
        row.style.setProperty('--mechanism-color', `var(--mechanism-${color})`);
        const mark = document.createElement('i');
        mark.setAttribute('aria-hidden', 'true');
        mark.toggleAttribute('data-dashed', Boolean(dashed));
        const name = document.createElement('span');
        name.textContent = label;
        const value = document.createElement('strong');
        value.textContent = time;
        row.append(mark, name, value);
        descriptions.push(`${label} converged in ${time}.`);
      }
      chart.setAttribute('aria-label', `Residual ratio versus solver time. ${scenario.noteText} ${descriptions.join(' ')}`);
      renderChart(scenario, traces);
    }

    controls.addEventListener('click', event => {
      const button = event.target.closest('button[data-comparison]');
      if (!button || button === selected) return;
      selected.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-pressed', 'true');
      selected = button;
      scenario = scenarios[button.dataset.comparison];
      update();
    });
    new ResizeObserver(() => requestAnimationFrame(() => renderChart(scenario, traces))).observe(chart);
    update();
  }

  async function load() {
    try {
      const response = await fetch('assets/mechanism-fig4.json?v=matched-cp');
      if (!response.ok) throw new Error(`Mechanism data returned ${response.status}`);
      mount(await response.json());
    } catch (error) {
      console.warn('Mechanism experiment:', error);
      const status = document.getElementById('mechanism-status');
      status.textContent = 'The mechanism experiment could not be loaded.';
      status.hidden = false;
    }
  }

  if (['#mechanism', '#initial-state-diagnostics'].includes(location.hash)) load();
  else {
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      load();
    }, {rootMargin: '600px 0px'});
    observer.observe(section);
  }
})();

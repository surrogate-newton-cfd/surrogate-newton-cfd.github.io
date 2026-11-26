'use strict';

(() => {
  const section = document.getElementById('design');
  const results = document.getElementById('design-results');
  const get = id => document.getElementById(id);
  const ink = '#1d1d1f';
  const copper = '#aa6b47';
  const blue = '#3e647d';

  function applySeriesVisibility(container, hiddenMethods, hiddenStages) {
    for (const line of container.querySelectorAll('[data-series]')) {
      line.toggleAttribute('data-filtered', hiddenMethods.has(line.dataset.series) || Boolean(hiddenStages?.has(line.dataset.stage)));
    }
    for (const point of container.querySelectorAll('.design-point-active')) {
      if (!point.closest('[data-filtered]')) continue;
      point.classList.remove('design-point-active');
      point.ownerSVGElement.querySelector('.design-point-tip')?.remove();
    }
  }

  function setFilter(hidden, input) {
    if (input.checked) hidden.delete(input.value);
    else hidden.add(input.value);
  }

  function drawAxes(chart, {x, y, xTicks, yTicks, xLabel, yLabel, drawBackground, compact = false, bounds}) {
    const width = chart.clientWidth;
    const height = chart.clientHeight;
    if (!width || !height) return null;
    const area = bounds || (compact
      ? {left: 56, right: width - 13, top: 14, bottom: height - 43}
      : {left: 52, right: width - 14, top: 23, bottom: height - 51});
    chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
    chart.replaceChildren();
    const X = v => area.left + x(v) * (area.right - area.left);
    const Y = v => area.bottom - y(v) * (area.bottom - area.top);
    drawBackground?.(area, Y);

    for (const value of yTicks) {
      const ordinate = Y(value);
      svg('line', {x1: area.left, y1: ordinate, x2: area.right, y2: ordinate, stroke: '#e8e8eb'}, chart);
      svg('text', {x: area.left - 10, y: ordinate + 4, 'text-anchor': 'end'}, chart).textContent = value;
    }
    svg('path', {
      d: `M ${area.left} ${area.top} V ${area.bottom} H ${area.right}`,
      fill: 'none', stroke: '#a6a6af',
    }, chart);
    for (const value of xTicks) {
      const abscissa = X(value);
      svg('line', {x1: abscissa, x2: abscissa, y1: area.bottom, y2: area.bottom + 4, stroke: '#a6a6af'}, chart);
      svg('text', {x: abscissa, y: area.bottom + 20, 'text-anchor': 'middle'}, chart).textContent = value;
    }
    svg('text', {x: (area.left + area.right) / 2, y: bounds ? area.bottom + 38 : height - 5, class: 'design-axis-label',
      'text-anchor': 'middle'}, chart).textContent = xLabel;
    const middleY = (area.top + area.bottom) / 2;
    const labelX = bounds ? area.left - 48 : 14;
    svg('text', {x: labelX, y: middleY, transform: `rotate(-90 ${labelX} ${middleY})`,
      class: 'design-axis-label', 'text-anchor': 'middle'}, chart).textContent = yLabel;
    return {X, Y, area};
  }

  const logScale = (min, max) => value => Math.log(value / min) / Math.log(max / min);

  function mountHistory({records, paths, baseline, featured}) {
    const chart = get('design-history-chart');
    const scrub = get('design-generation');
    const profile = get('design-selected-path');
    const roleLabel = get('design-selected-role');
    const distanceLabel = get('design-selected-distance');
    const dragLabel = get('design-selected-drag');
    const generationLabel = get('design-generation-value');
    const historyLegend = get('design-history-legend');
    const metricButtons = get('design-history-view');
    const profileLegend = get('design-history-profile-legend');
    const hidden = new Set();

    const elites = records.map((record, index) => record.role === 'elite' ? index : -1).filter(index => index >= 0);

    setLegend(historyLegend, ['candidate', 'elite'], {
      candidate: {name: 'Evaluated candidate', color: copper},
      elite: {name: 'Retained best', color: ink},
    }, hidden, ['candidate']);
    setLegend(profileLegend, ['selected-profile', 'rae2822'], {
      'selected-profile': {name: 'Selected airfoil', color: ink},
      rae2822: {name: 'RAE2822', color: '#8793a0', dash: '3 3'},
    }, hidden);
    get('design-baseline-path').setAttribute('d', paths[records[baseline].path]);

    const byGeneration = Array.from({length: 51}, () => []);
    records.forEach((record, index) => byGeneration[record.generation].push(index));
    for (const indices of byGeneration) indices.sort((a, b) => records[a].distance - records[b].distance);
    const retainedByGeneration = new Map(elites.map(index => [records[index].generation, index]));
    let selected = featured;
    let metric = 'distance';
    let selectionMark;
    let positions = [];

    function select(index) {
      selected = index;
      const {generation, distance, path, role, feasible, cdAvg} = records[index];
      const label = role === 'baseline' ? 'RAE2822 baseline'
        : role === 'elite' ? 'Retained best'
        : feasible ? 'Feasible candidate' : 'Infeasible candidate';
      const value = distance.toFixed(2);
      roleLabel.textContent = label;
      distanceLabel.textContent = value;
      dragLabel.textContent = cdAvg === null ? '—' : cdAvg.toFixed(5);
      generationLabel.value = generation;
      scrub.value = generation;
      chart.setAttribute('aria-valuenow', generation);
      chart.setAttribute('aria-valuetext', `Generation ${generation}, ${label}, OOD distance ${value}` +
        (cdAvg === null ? '' : `, mean drag ${dragLabel.textContent} from independent CFD`));
      profile.setAttribute('d', paths[path]);
      if (selectionMark) {
        if (positions[index]) {
          const [x, y] = positions[index];
          selectionMark.setAttribute('cx', x);
          selectionMark.setAttribute('cy', y);
        }
        selectionMark.dataset.series = role;
        selectionMark.setAttribute('visibility', positions[index] ? 'visible' : 'hidden');
        selectionMark.toggleAttribute('data-filtered', hidden.has(role));
      }
    }

    function selectGeneration(generation) {
      select(generation === 0 ? baseline : retainedByGeneration.get(generation));
    }

    function paint() {
      const distance = metric === 'distance';
      const frame = drawAxes(chart, {
        x: value => value / 50, y: distance ? logScale(.65, 60) : logScale(.013, .57),
        xTicks: [0, 10, 20, 30, 40, 50],
        yTicks: distance ? [1, 2, 5, 10, 20, 50] : [.015, .02, .03, .05, .1, .2, .5],
        xLabel: 'Optimization generation', yLabel: distance ? 'OOD distance' : 'Mean drag coefficient',
        drawBackground: (bounds, Y) => {
          if (!distance) return;
          svg('rect', {x: bounds.left, y: Y(1), width: bounds.right - bounds.left,
            height: bounds.bottom - Y(1), fill: '#ecf1f4'}, chart);
        },
      });
      if (!frame) return;
      const {X, Y, area} = frame;
      chart.setAttribute('aria-label', distance ? 'Airfoil OOD distance by generation' : 'Mean drag coefficient by generation, from independent CFD');
      positions = records.map(record => record[metric] === null ? null : [X(record.generation), Y(record[metric])]);
      const candidates = svg('g', {'data-series': 'candidate', 'aria-hidden': 'true'}, chart);
      const compact = chart.clientWidth < 430;
      for (let index = 0; index < records.length; index += 1) {
        if (records[index].role !== 'candidate' || !positions[index]) continue;
        const [cx, cy] = positions[index];
        svg('circle', {cx, cy, r: compact ? 1.65 : 2.1, fill: copper, opacity: .43}, candidates);
      }
      if (distance) {
        svg('line', {x1: area.left, y1: Y(1), x2: area.right, y2: Y(1), stroke: '#627e93',
          'stroke-dasharray': '4 4'}, chart);
        svg('text', {x: area.right - 4, y: Y(1) - 7, 'text-anchor': 'end',
          class: 'design-reference-label'}, chart).textContent = 'Training P99';
      }
      svg('polyline', {points: elites.map(index => positions[index]).filter(Boolean).join(' '),
        'data-series': 'elite', fill: 'none', stroke: ink, 'stroke-width': 1.7, 'stroke-linejoin': 'round'}, chart);
      for (const index of [baseline, elites.at(-1)]) {
        if (!positions[index]) continue;
        const [cx, cy] = positions[index];
        svg('circle', {cx, cy, r: 3, fill: ink, stroke: '#fff', 'stroke-width': .7,
          'data-series': records[index].role}, chart);
      }
      selectionMark = svg('circle', {r: 5.5, fill: '#fff', stroke: ink, 'stroke-width': 1.8,
        'pointer-events': 'none'}, chart);
      select(selected);
      applySeriesVisibility(chart, hidden);
    }

    function pickPoint(event) {
      const bounds = chart.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      let range = event.pointerType === 'touch' ? 28 ** 2 : 18 ** 2;
      let nearest = selected;
      positions.forEach((position, index) => {
        if (!position || hidden.has(records[index].role)) return;
        const [px, py] = position;
        const distance = (x - px) ** 2 + (y - py) ** 2;
        if (distance <= range) {
          range = distance;
          nearest = index;
        }
      });
      if (nearest !== selected) select(nearest);
    }

    chart.addEventListener('pointermove', event => {
      if (event.pointerType !== 'touch') pickPoint(event);
    });
    chart.addEventListener('pointerdown', pickPoint);
    chart.addEventListener('keydown', event => {
      const {generation} = records[selected];
      const group = byGeneration[generation];
      const index = group.indexOf(selected);
      switch (event.key) {
        case 'ArrowLeft': selectGeneration(Math.max(0, generation - 1)); break;
        case 'ArrowRight': selectGeneration(Math.min(50, generation + 1)); break;
        case 'Home': selectGeneration(0); break;
        case 'End': selectGeneration(50); break;
        case 'ArrowUp': select(group[Math.min(group.length - 1, index + 1)]); break;
        case 'ArrowDown': select(group[Math.max(0, index - 1)]); break;
        default: return;
      }
      event.preventDefault();
    });
    scrub.addEventListener('input', () => selectGeneration(Number(scrub.value)));
    metricButtons.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button || metric === button.dataset.metric) return;
      metric = button.dataset.metric;
      for (const item of metricButtons.children) item.setAttribute('aria-pressed', String(item === button));
      paint();
    });
    for (const legend of [historyLegend, profileLegend]) {
      legend.addEventListener('change', ({target}) => {
        setFilter(hidden, target);
        applySeriesVisibility(get('design-history'), hidden);
      });
    }
    chart.setAttribute('aria-valuemin', '0');
    chart.setAttribute('aria-valuemax', '50');
    paint();
    new ResizeObserver(() => requestAnimationFrame(paint)).observe(chart);
  }

  const methods = {
    baseline: {name: 'Initial (NACA 0012)', color: '#777c84', dash: '4 4'},
    initial: {name: 'Initial', color: '#777c84', dash: '4 4'},
    surrogate: {name: 'Surrogate', color: '#628c9f', dash: '4 3'},
    k4: {name: 'Top-4 NK', color: '#bc8356', dash: '2 3'},
    k12: {name: 'Top-12 NK', color: '#86739a', dash: '7 3'},
    full_nk: {name: 'Full NK', color: '#86482e'},
    cfd: {name: 'CFD', color: '#4a4f57'}, // CFD = neutral gray site-wide
  };
  const stages = {
    acceptance: {name: 'Independent CFD', color: ink, width: 2.1, opacity: 1},
    correction: {name: 'NK correction', color: ink, dash: '7 3', width: 1.55, opacity: .76, stroke: 'long'},
    prediction: {name: 'Surrogate prediction', color: ink, dash: '2 3', width: 1.55, opacity: .83, stroke: 'short'},
  };
  const traces = Object.fromEntries(Object.entries(stages).flatMap(([stage, style]) =>
    Object.entries(methods).map(([method, appearance]) => [
      `${method}:${stage}`, {...style, color: appearance.color},
    ])));

  const pressureAxes = {
    x: value => value,
    y: value => (1.25 - value) / 3.05,
    xTicks: [0, .25, .5, .75, 1],
    yTicks: [-1.5, -1, -.5, 0, .5, 1],
    xLabel: 'x/c', yLabel: 'Cₚ',
    compact: true,
  };
  const dragAxes = {
    x: value => (value - .722) / .024,
    xTicks: [.724, .734, .744],
    xLabel: 'Mach number', yLabel: 'Drag (counts)',
    compact: true,
  };
  const polarAxes = {
    x: value => (value + 2) / 8,
    y: value => value / 30,
    xTicks: [-2, 0, 2, 4, 6],
    yTicks: [0, 10, 20, 30],
    xLabel: 'Angle of attack (°)', yLabel: 'Lift-to-drag ratio',
  };

  const taskSpecs = {
    transonic: {
      costLabel: 'Verified drag (counts)',
      costUnit: 'drag counts',
      timeLabel: 'Optimization time (h)',
      timeTicks: [.5, 1, 2, 4, 8, 16],
      timeDomain: [.28, 18],
      costTicks: [120, 130, 140, 150, 160],
      costDomain: [115, 166],
      defaultSeed: '0',
    },
    mars: {
      costLabel: 'Verified peak lift-to-drag',
      costUnit: 'peak lift-to-drag',
      timeLabel: 'Optimization time (h)',
      timeTicks: [.5, 1, 2, 4, 8, 16],
      timeDomain: [.45, 18],
      costTicks: [25, 26, 27, 28],
      costDomain: [24.9, 28.65],
      defaultSeed: '2',
    },
  };

  function summarizeRuns(runs, seed) {
    const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
    return Object.keys(methods).filter(id => runs[id]).flatMap(id => {
      const selected = seed === 'all' ? runs[id] : runs[id].filter(run => run.seed === Number(seed));
      const hours = selected.map(run => run.hours);
      const results = selected.map(run => run.result).filter(Number.isFinite);
      if (!results.length) return [];
      return [{...methods[id], id, time: mean(hours), result: mean(results),
        timeRange: [Math.min(...hours), Math.max(...hours)],
        resultRange: [Math.min(...results), Math.max(...results)]}];
    });
  }

  function drawCost(chart, spec, series, showRange) {
    const [low, high] = spec.costDomain;
    const frame = drawAxes(chart, {
      x: logScale(...spec.timeDomain), y: value => (value - low) / (high - low),
      xTicks: spec.timeTicks, yTicks: spec.costTicks,
      xLabel: spec.timeLabel, yLabel: spec.costLabel,
    });
    if (!frame) return;
    const {X, Y} = frame;
    for (const {id, name, time, result, timeRange, resultRange, color} of series) {
      const mark = svg('g', {'data-series': id}, chart);
      const x = X(time);
      const y = Y(result);
      if (showRange) {
        const [loX, hiX] = timeRange.map(X);
        const [hiY, loY] = resultRange.map(Y);
        svg('path', {
          d: `M ${loX} ${y} H ${hiX} M ${loX} ${y-3} v 6 M ${hiX} ${y-3} v 6
              M ${x} ${loY} V ${hiY} M ${x-3} ${loY} h 6 M ${x-3} ${hiY} h 6`,
          fill: 'none', stroke: color, 'stroke-width': 1.3, opacity: .78,
        }, mark);
      }
      drawPoint(mark, x, y, color, 5, [name, `${time.toFixed(2)} h · ${result.toFixed(2)} ${spec.costUnit}`]);
    }
  }

  function drawPoint(group, cx, cy, color, r, label) {
    svg('circle', {cx, cy, r, fill: color, stroke: '#fff', 'stroke-width': .55,
      class: 'design-plot-point', 'data-point-name': label[0], 'data-point-detail': label[1]}, group);
  }

  function mountPointInspector(chart) {
    const instructions = 'Select a plotted point or use the arrow keys to inspect its values.';
    chart.setAttribute('aria-description', instructions);
    const visible = () => [...chart.querySelectorAll('.design-plot-point')].filter(point => !point.closest('[data-filtered]'));
    function show(point) {
      if (point?.classList.contains('design-point-active') && chart.querySelector('.design-point-tip')) return;
      chart.querySelector('.design-point-tip')?.remove();
      chart.querySelector('.design-point-active')?.classList.remove('design-point-active');
      if (!point) {
        chart.setAttribute('aria-description', instructions);
        return;
      }
      point.classList.add('design-point-active');
      const cx = Number(point.getAttribute('cx'));
      const cy = Number(point.getAttribute('cy'));
      const tip = svg('g', {class: 'design-point-tip', 'pointer-events': 'none'}, chart);
      const title = svg('text', {x: 10, y: 18, 'font-weight': 600}, tip);
      const detail = svg('text', {x: 10, y: 36}, tip);
      title.textContent = point.dataset.pointName;
      detail.textContent = point.dataset.pointDetail;
      const width = Math.max(title.getComputedTextLength(), detail.getComputedTextLength()) + 20;
      const x = Math.max(2, Math.min(cx + 10, chart.clientWidth - width - 2));
      const y = cy < 57 ? cy + 10 : cy - 53;
      tip.setAttribute('transform', `translate(${x} ${y})`);
      const rect = svg('rect', {width, height: 45, rx: 7, fill: '#fff', stroke: '#d8d8de'});
      tip.prepend(rect);
      chart.setAttribute('aria-description', `${title.textContent}. ${detail.textContent}`);
    }
    function pickNearest(event) {
      const rect = chart.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      let nearest;
      let limit = event.pointerType === 'touch' ? 22 ** 2 : 14 ** 2;
      for (const point of visible()) {
        const distance = (Number(point.getAttribute('cx')) - x) ** 2 + (Number(point.getAttribute('cy')) - y) ** 2;
        if (distance >= limit) continue;
        nearest = point;
        limit = distance;
      }
      show(nearest);
    }
    chart.addEventListener('pointermove', event => {
      if (event.pointerType !== 'touch') pickNearest(event);
    });
    chart.addEventListener('pointerup', event => {
      if (event.pointerType === 'touch') pickNearest(event);
    });
    chart.addEventListener('pointerleave', event => {
      if (event.pointerType !== 'touch') show(null);
    });
    chart.addEventListener('keydown', event => {
      const direction = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1}[event.key];
      if (event.key === 'Escape') { show(null); return; }
      if (!direction && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      const points = visible();
      if (!points.length) return;
      const index = points.findIndex(point => point.classList.contains('design-point-active'));
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 :
        (index < 0 ? (direction > 0 ? 0 : points.length - 1) : (index + direction + points.length) % points.length);
      show(points[next]);
    });
  }

  function drawCurves(chart, axes, curves, styles, inspect) {
    const frame = drawAxes(chart, axes);
    if (!frame) return;
    const {X, Y} = frame;
    for (const id of Object.keys(styles).filter(id => curves[id])) {
      const {color, dash, width = 1.65, opacity = 1} = styles[id];
      const [method, stage] = id.split(':');
      const trace = svg('g', {'data-series': method}, chart);
      if (stage) trace.dataset.stage = stage;
      for (const points of curves[id]) {
        svg('polyline', {
          points: points.map(([x, y]) => `${X(x).toFixed(2)},${Y(y).toFixed(2)}`).join(' '),
          fill: 'none', stroke: color, 'stroke-width': width, opacity,
          'stroke-linejoin': 'round', 'stroke-dasharray': dash || 'none',
        }, trace);
        if (inspect) {
          for (const [x, y, generation] of points) {
            drawPoint(trace, X(x), Y(y), color, stage === 'acceptance' || !stage ? 2.8 : 2.25,
              inspect(method, stage, x, y, generation));
          }
        }
      }
    }
  }

  function drawFoils(chart, foils, isMars) {
    const width = chart.clientWidth;
    const height = chart.clientHeight;
    if (!width || !height) return;
    const xMin = -.02, xMax = 1.02;
    const [yMin, yMax] = isMars ? [-.02, .08] : [-.155, .125];
    const aspect = isMars ? 6.2 : 2;
    const ratio = aspect * (yMax - yMin) / (xMax - xMin);
    const plotWidth = Math.min(width - 78, (height - 68) / ratio);
    const plotHeight = plotWidth * ratio;
    const left = 59 + (width - 78 - plotWidth) / 2;
    const top = Math.max(9, (height - 48 - plotHeight) / 2);
    const frame = drawAxes(chart, {
      x: value => (value - xMin) / (xMax - xMin), y: value => (value - yMin) / (yMax - yMin),
      xTicks: [0, .25, .5, .75, 1],
      yTicks: isMars ? [-.02, 0, .05, .08] : [-.15, -.10, -.05, 0, .05, .10],
      xLabel: 'x/c', yLabel: 'y/c',
      bounds: {left, right: left + plotWidth, top, bottom: top + plotHeight},
    });
    if (!frame) return;
    const {X, Y} = frame;
    const group = svg('g', {transform: `translate(${X(0)} ${Y(0)}) scale(${plotWidth / 1040} ${plotWidth * aspect / 2080})`}, chart);
    for (const [id, d] of Object.entries(foils)) {
      const {color, dash} = methods[id];
      svg('path', {d, 'data-series': id, fill: 'none', stroke: color, 'stroke-width': 1.65, 'stroke-linejoin': 'round',
        'vector-effect': 'non-scaling-stroke', 'stroke-dasharray': dash || 'none'}, group);
    }
  }

  function setLegend(legend, keys, styles, hidden, points = []) {
    legend.replaceChildren();
    for (const id of keys) {
      const {name, color, dash, stroke} = styles[id];
      const item = document.createElement('label');
      item.className = 'design-legend-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = id;
      input.checked = !hidden.has(id);
      const mark = document.createElement('i');
      const dot = points.includes(id);
      mark.className = dot ? 'design-symbol design-symbol-candidate' : 'design-symbol';
      mark.setAttribute('aria-hidden', 'true');
      mark.style.borderColor = color;
      if (dot) mark.style.backgroundColor = color;
      else if (stroke) mark.dataset.stroke = stroke;
      else mark.style.borderTopStyle = dash ? 'dashed' : 'solid';
      item.append(input, mark, name);
      legend.append(item);
    }
  }

  function mountFigureCarousel(block, onPage) {
    const track = block.querySelector('[data-role="track"]');
    const slides = [...track.children];
    const previous = block.querySelector('[data-role="slide-prev"]');
    const next = block.querySelector('[data-role="slide-next"]');
    const tabs = [...block.querySelectorAll('[data-role="slide-tabs"] button')];
    let active = 0;
    const go = mountHorizontalCarousel(track, index => {
      active = index;
      previous.disabled = active === 0;
      next.disabled = active === slides.length - 1;
      slides.forEach((slide, page) => {
        const inactive = page !== active;
        slide.setAttribute('aria-hidden', String(inactive));
        for (const control of slide.querySelectorAll('.design-legend')) control.inert = inactive;
        for (const chart of slide.querySelectorAll('.design-pick-chart')) chart.setAttribute('tabindex', inactive ? '-1' : '0');
      });
      tabs.forEach((button, page) => button.setAttribute('aria-selected', String(page === active)));
      onPage(active);
    });

    previous?.addEventListener('click', () => go(active - 1));
    next?.addEventListener('click', () => go(active + 1));
    tabs.forEach((button, index) => button.addEventListener('click', () => go(index)));
  }

  function mountTaskBlock(block, taskKey, taskData) {
    const spec = taskSpecs[taskKey];
    const isMars = taskKey === 'mars';
    const seedPicker = block.querySelector('[data-role="seed-picker"]');
    const cost = block.querySelector('[data-role="cost-chart"]');
    const foilChart = block.querySelector('[data-role="foil-chart"]');
    const drag = block.querySelector('[data-role="drag-chart"]');
    const polar = block.querySelector('[data-role="polar-chart"]');
    const cpCharts = isMars ? {} : {
      '.724': block.querySelector('[data-cp=".724"]'),
      '.734': block.querySelector('[data-cp=".734"]'),
      '.744': block.querySelector('[data-cp=".744"]'),
    };
    const costLegend = block.querySelector('[data-role="cost-legend"]');
    const foilLegend = block.querySelector('[data-role="foil-legend"]');
    const metricLegend = block.querySelector('[data-role="metric-legend"]');
    const stageLegend = block.querySelector('[data-role="stage-legend"]');
    const speedupNode = block.querySelector('[data-role="top4-speedup"]');
    const methodLegends = [costLegend, foilLegend, metricLegend].filter(Boolean);

    // Top-4 NK (k4) is visible by default alongside Surrogate, Full NK, and CFD.
    const hiddenMethods = new Set(['baseline', 'initial', 'k12']);
    const hiddenStages = new Set();
    let position = 'all';
    let activePage = 0;
    let series;
    let sample;

    [cost, drag, polar].filter(Boolean).forEach(mountPointInspector);

    function applyTaskFilters() {
      applySeriesVisibility(block, hiddenMethods, hiddenStages);
    }

    function displaySeed() {
      return position === 'all' ? spec.defaultSeed : position;
    }

    function markSelectedSeed() {
      const value = activePage === 0 ? position : displaySeed();
      for (const button of seedPicker.children) {
        button.setAttribute('aria-pressed', String(button.dataset.seed === value));
      }
    }

    function updatePicker() {
      const choices = Object.keys(taskData.seeds);
      if (activePage === 0) choices.unshift('all');
      seedPicker.replaceChildren(...choices.map(seed => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.seed = seed;
        button.textContent = seed === 'all' ? 'All' : seed;
        button.setAttribute('aria-label', seed === 'all' ? 'All seeds' : `Seed ${seed}`);
        return button;
      }));
      markSelectedSeed();
    }

    function paintPerformance() {
      if (isMars) {
        drawCurves(polar, polarAxes, sample.curves, methods, (method, _stage, angle, ld) => [
          methods[method].name, `α ${angle.toFixed(0)}° · L/D ${ld.toFixed(2)}`,
        ]);
        return;
      }
      for (const [mach, curves] of Object.entries(sample.profiles)) {
        drawCurves(cpCharts[mach.slice(1)], pressureAxes, curves, traces);
      }
      const dragCurves = Object.fromEntries(Object.entries(sample.drag).map(([key, points]) => [key, [points]]));
      const coefficients = Object.values(sample.drag).flat().map(([, value]) => value);
      const low = Math.min(...coefficients);
      const high = Math.max(...coefficients);
      const step = high - low > 65 ? 20 : 10;
      const bottom = step * Math.floor((low - 2) / step);
      const top = step * Math.ceil((high + 2) / step);
      const yTicks = Array.from({length: (top - bottom) / step + 1}, (_, index) => bottom + index * step);
      drawCurves(drag, {...dragAxes, y: value => (value - bottom) / (top - bottom), yTicks}, dragCurves, traces,
        (method, stage, mach, cd) => [
          method === 'cfd' ? 'CFD' : `${methods[method].name} · ${stages[stage].name}`,
          `Ma ${mach.toFixed(3)} · ${cd.toFixed(2)} counts`,
        ]);
    }

    function paint() {
      drawCost(cost, spec, series, position === 'all');
      drawFoils(foilChart, sample.foils, isMars);
      paintPerformance();
      applyTaskFilters();
    }

    function updateCostLabel() {
      const visible = series.filter(({id}) => !hiddenMethods.has(id));
      cost.setAttribute('aria-label', `${spec.timeLabel}. ` +
        visible.map(({name, time, result}) =>
          `${name}, ${time.toFixed(2)} hours and ${result.toFixed(1)} ${spec.costUnit}.`).join(' '));
    }

    function updateFigures() {
      const seed = displaySeed();
      sample = taskData.seeds[seed];
      series = summarizeRuns(taskData.cost, position);
      const top4 = series.find(method => method.id === 'k4');
      const cfd = series.find(method => method.id === 'cfd');
      if (speedupNode && top4 && cfd) speedupNode.textContent = `${(cfd.time / top4.time).toFixed(1)}×`;
      foilChart.setAttribute('aria-label', `Final airfoil outlines for seed ${seed}`);
      updateCostLabel();
      const costKeys = series.map(method => method.id);
      setLegend(costLegend, costKeys, methods, hiddenMethods, costKeys);
      setLegend(foilLegend, Object.keys(methods).filter(id => sample.foils[id]), methods, hiddenMethods);
      const metricKeys = isMars ? Object.keys(methods).filter(id => sample.curves[id]) : costKeys;
      setLegend(metricLegend, metricKeys, methods, hiddenMethods, isMars ? [] : metricKeys);
      if (stageLegend) {
        setLegend(stageLegend, ['prediction', 'correction', 'acceptance'], stages, hiddenStages);
      }
      paint();
    }

    for (const legend of methodLegends) {
      legend.addEventListener('change', ({target}) => {
        setFilter(hiddenMethods, target);
        for (const other of methodLegends) {
          const input = other.querySelector(`input[value="${target.value}"]`);
          if (input) input.checked = target.checked;
        }
        applyTaskFilters();
        updateCostLabel();
      });
    }
    stageLegend?.addEventListener('change', ({target}) => {
      setFilter(hiddenStages, target);
      applyTaskFilters();
    });

    seedPicker.addEventListener('click', event => {
      const button = event.target.closest('button[data-seed]');
      if (!button) return;
      position = button.dataset.seed;
      markSelectedSeed();
      updateFigures();
    });

    updatePicker();
    updateFigures();

    let resizeFrame = 0;
    const sizeObserver = new ResizeObserver(() => {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        paint();
      });
    });
    [cost, foilChart, polar, drag, ...Object.values(cpCharts)].filter(Boolean).forEach(chart => sizeObserver.observe(chart));
    mountFigureCarousel(block, page => {
      activePage = page;
      updatePicker();
    });
    return {paint};
  }

  function mountTaskSwitcher(controllers) {
    const tablist = results.querySelector('.design-task-switcher');
    if (!tablist) return;
    const tabs = [...tablist.querySelectorAll('[role="tab"]')];
    const panels = new Map([...results.querySelectorAll('.design-task-block[data-task]')].map(el => [el.dataset.task, el]));

    function selectTask(tab) {
      const key = tab.dataset.taskTab;
      for (const button of tabs) {
        const active = button === tab;
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
      }
      for (const [taskKey, panel] of panels.entries()) {
        panel.hidden = taskKey !== key;
      }
      requestAnimationFrame(() => controllers.get(key)?.paint());
    }

    tablist.addEventListener('click', event => {
      const tab = event.target.closest('[role="tab"]');
      if (tab) selectTask(tab);
    });
    tablist.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const current = tabs.indexOf(event.target);
      if (current < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (current + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
      selectTask(tabs[next]);
      tabs[next].focus();
    });
    if (location.hash === '#design-task-mars') {
      const marsTab = tabs.find(t => t.dataset.taskTab === 'mars');
      if (marsTab) selectTask(marsTab);
    }
  }

  const controllers = new Map();
  mountTaskSwitcher(controllers);

  async function loadDesign() {
    try {
      const response = await fetch('assets/aerodynamic-design.json?v=plan-a-1');
      if (!response.ok) throw new Error(`Optimization data returned ${response.status}`);
      const {history, tasks} = await response.json();
      for (const block of results.querySelectorAll('.design-task-block[data-task]')) {
        const key = block.dataset.task;
        if (tasks[key]) controllers.set(key, mountTaskBlock(block, key, tasks[key]));
      }
      mountHistory(history);
    } catch (error) {
      console.warn('Aerodynamic design:', error);
      for (const block of [section, results]) {
        const status = block.querySelector('.design-load-status');
        if (!status) continue;
        status.hidden = false;
        status.textContent = 'Optimization data could not be loaded. Refresh the page to try again.';
      }
    }
  }

  if (['#design', '#design-results', '#design-task-transonic', '#design-task-mars'].includes(location.hash)) {
    loadDesign();
    return;
  }
  const observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    observer.disconnect();
    loadDesign();
  }, {rootMargin: '650px 0px'});
  observer.observe(section);
  observer.observe(results);
})();

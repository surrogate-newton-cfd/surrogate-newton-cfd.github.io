"use strict";

const FIELD_DISPLAY = (() => {
  // Same physical colour anchors as the Highlights Cp and signed error figures.
  const cp = {
    title: "Pressure coefficient, Cₚ",
    limits: [-2, 1.2],
    ticks: [-2, -1, 0, 1.2],
    stops: [
      [-2, 24, 65, 95], [-1.2, 62, 114, 150], [-0.6, 148, 185, 204],
      [0, 255, 255, 255], [0.3, 208, 161, 125], [0.75, 166, 106, 69], [1.2, 136, 71, 39],
    ],
  };
  const cpError = {
    title: "Signed error, ΔCₚ",
    limits: [-0.2, 0.2],
    ticks: [-0.2, -0.1, 0, 0.1, 0.2],
    stops: [[-0.2, 47, 104, 108], [0, 255, 255, 255], [0.2, 165, 83, 98]],
  };
  const bounds = {xMin: -0.12, xMax: 1.2, yMin: -0.27, yMax: 0.27};

  const dynamicPressureScale = (mach) => 0.7 * mach ** 2;
  // Use every other Overview contour level in the rectangular near-field views.
  const cpContours = {interval: 0.05 / dynamicPressureScale(0.74), rgb: [50, 70, 80], opacity: 0.18};
  const contourRgb = cpContours.rgb.map((channel) => (channel / 255).toFixed(7)).join(", ");
  const contourShader = `
    vec3 withCpContours(vec3 fill, float cp, float pixelScale) {
      float phase = cp / ${cpContours.interval.toFixed(9)};
      float gradient = fwidth(phase);
      float footprint = gradient * pixelScale;
      if (gradient < 0.004 || footprint < 0.006) return fill;
      float distance = abs(phase - floor(phase + 0.5));
      float line = smoothstep(0.006, 0.015, footprint)
        * (1.0 - smoothstep(0.12, 0.72, distance / footprint))
        * (1.0 - smoothstep(0.25, 0.55, footprint));
      return mix(fill, vec3(${contourRgb}), line * ${cpContours.opacity});
    }`;

  function colour(value, stops) {
    const index = stops.findIndex((stop) => value <= stop[0]);
    if (index === 0) return stops[0].slice(1);
    if (index === -1) return stops[stops.length - 1].slice(1);
    const [lower, ...from] = stops[index - 1];
    const [upper, ...to] = stops[index];
    const weight = (value - lower) / (upper - lower);
    return from.map((channel, channelIndex) => channel + weight * (to[channelIndex] - channel));
  }

  function signedStops(scale, limits) {
    const [low, high] = limits;
    return scale.stops.map(([anchor, ...rgb]) => [
      anchor * (anchor < 0 ? (low < 0 ? low / scale.limits[0] : 1) : (high > 0 ? high / scale.limits[1] : 1)),
      ...rgb,
    ]);
  }

  function uniformStops(colors, [low, high]) {
    return colors.map((rgb, index) => [low + (high - low) * index / (colors.length - 1), ...rgb]);
  }

  function rangeTicks(scale, [low, high]) {
    if (low === scale.limits[0] && high === scale.limits[1]) return scale.ticks;
    return low < 0 && high > 0 ? [low, 0, high] : [low, high];
  }

  function markLabel(value) {
    const magnitude = Math.abs(value);
    const text = value !== 0 && (magnitude < 0.001 || magnitude >= 1e4)
      ? value.toExponential(2)
      : Number(value.toPrecision(4)).toString();
    return text.replace("-", "−");
  }

  function drawColorbar(container, {title, limits, ticks = limits, stops}) {
    const [low, high] = limits;
    const fraction = (value) => (100 * (value - low) / (high - low)) + "%";
    const inRange = stops.filter(([value]) => value > low && value < high);
    const anchors = [[low, ...colour(low, stops)], ...inRange, [high, ...colour(high, stops)]];
    const css = anchors.map(([value, ...rgb]) => `rgb(${rgb.map(Math.round).join(",")}) ${fraction(value)}`).join(", ");
    container.setAttribute("aria-label", `${title}. Scale from ${markLabel(low)} to ${markLabel(high)}.`);
    container.querySelector(".field-colorbar-title").textContent = title;
    container.querySelector(".field-colorbar-gradient").style.backgroundImage = `linear-gradient(90deg, ${css})`;
    const labels = ticks.map((tick) => {
      const label = document.createElement("span");
      label.style.left = fraction(tick);
      label.textContent = markLabel(tick);
      return label;
    });
    container.querySelector(".field-colorbar-ticks").replaceChildren(...labels);
  }

  return {cp, cpError, cpContours, contourShader, bounds, dynamicPressureScale, colour, signedStops, uniformStops, rangeTicks, drawColorbar};
})();

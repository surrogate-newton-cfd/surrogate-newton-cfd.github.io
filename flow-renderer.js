"use strict";

// Interpolate the recorded pressure, then apply the shared Cp scale.
class PressureReplay {
  constructor(canvas, mach) {
    this.canvas = canvas;
    const gl = this.gl = canvas.getContext("webgl2", {alpha: false, antialias: false, preserveDrawingBuffer: true});
    if (!gl) throw Error("WebGL2 unavailable");

    const compile = (kind, source) => {
      const shader = gl.createShader(kind);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const {stops} = FIELD_DISPLAY.cp;
    const rgb = (stop) => `vec3(${stop.slice(1).map((channel) => (channel / 255).toFixed(7)).join(",")})`;
    const palette = stops.slice(1).map((upper, index) => {
      const lower = stops[index];
      const left = lower[0].toFixed(6);
      const right = upper[0].toFixed(6);
      return `if (cp <= ${right}) return mix(${rgb(lower)}, ${rgb(upper)}, clamp((cp - (${left})) / (${right} - (${left})), 0.0, 1.0));`;
    }).join("\n");

    const program = this.program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, `#version 300 es
      in vec2 position;
      out vec2 uv;
      void main() {
        uv = vec2((position.x + 1.0) * 0.5, (1.0 - position.y) * 0.5);
        gl_Position = vec4(position, 0.0, 1.0);
      }`));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      in vec2 uv;
      out vec4 color;
      uniform sampler2D beforeField;
      uniform sampler2D afterField;
      uniform float blend;
      uniform float inverseDynamicPressure;
      uniform float pixelScale;
      ${FIELD_DISPLAY.contourShader}
      vec3 colour(float cp) {
        ${palette}
        return ${rgb(stops.at(-1))};
      }
      float pressure(vec4 texel) {
        return (texel.r * 65280.0 + texel.g * 255.0) / 65535.0 * 3.0;
      }
      void main() {
        vec4 before = texture(beforeField, uv);
        vec4 after = texture(afterField, uv);
        float cp = (mix(pressure(before), pressure(after), blend) - 1.0) * inverseDynamicPressure;
        vec3 field = withCpContours(colour(cp), cp, pixelScale);
        color = before.b < 0.5 ? vec4(1.0) : vec4(field, 1.0);
      }`));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const buffer = this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    this.textures = [0, 1].map(() => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    });
    gl.uniform1i(gl.getUniformLocation(program, "beforeField"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "afterField"), 1);
    gl.uniform1f(gl.getUniformLocation(program, "inverseDynamicPressure"), 1 / FIELD_DISPLAY.dynamicPressureScale(mach));
    this.blendLocation = gl.getUniformLocation(program, "blend");
    this.pixelScale = gl.getUniformLocation(program, "pixelScale");
    this.loaded = [];
  }

  draw(before, after, blend) {
    const gl = this.gl;
    gl.useProgram(this.program);
    [before, after].forEach((image, index) => {
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[index]);
      if (this.loaded[index] !== image) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        this.loaded[index] = image;
      }
    });
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.blendLocation, blend);
    gl.uniform1f(this.pixelScale, replayPixelScale(this.canvas));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose() {
    const gl = this.gl;
    gl.useProgram(null);
    for (const texture of this.textures) gl.deleteTexture(texture);
    for (const shader of gl.getAttachedShaders(this.program)) gl.deleteShader(shader);
    gl.deleteProgram(this.program);
    gl.deleteBuffer(this.buffer);
  }
}

function replayPixelScale(canvas) {
  return canvas.width / (canvas.getBoundingClientRect().width || canvas.width);
}

function pressureReplayFallback(canvas, mach) {
  const {width, height} = canvas;
  const context = canvas.getContext("2d", {alpha: false});
  const scratch = document.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const decoder = scratch.getContext("2d", {willReadFrequently: true});
  const frame = context.createImageData(width, height);
  const pixels = new Uint32Array(frame.data.buffer);
  const palette = new Uint8ClampedArray(65536 * 4);
  const paletteWords = new Uint32Array(palette.buffer);
  const scale = FIELD_DISPLAY.dynamicPressureScale(mach);
  const {interval, rgb, opacity} = FIELD_DISPLAY.cpContours;
  const phaseScale = 3 / (65535 * scale * interval);
  const phaseOffset = 1 / (scale * interval);
  const interpolated = new Int32Array(pixels.length);
  const smooth = (low, high, value) => {
    const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
    return t * t * (3 - 2 * t);
  };
  for (let encoded = 0; encoded < paletteWords.length; encoded += 1) {
    const cp = (encoded * 3 / 65535 - 1) / scale;
    const [red, green, blue] = FIELD_DISPLAY.colour(cp, FIELD_DISPLAY.cp.stops);
    palette.set([red, green, blue, 255], 4 * encoded);
  }

  let decoded = new Map();
  function decode(image) {
    decoder.drawImage(image, 0, 0);
    const bytes = decoder.getImageData(0, 0, width, height).data;
    const pressure = new Int32Array(width * height);
    for (let index = 0; index < pressure.length; index += 1) {
      const offset = 4 * index;
      pressure[index] = bytes[offset + 2] < 128 ? -1 : bytes[offset] * 256 + bytes[offset + 1];
    }
    return pressure;
  }

  return {
    draw(before, after, blend) {
      const first = decoded.get(before) ?? decode(before);
      const last = after === before ? first : decoded.get(after) ?? decode(after);
      decoded = new Map([[before, first], [after, last]]);
      for (let index = 0; index < pixels.length; index += 1) {
        const source = first[index];
        const target = last[index] < 0 ? source : last[index];
        const encoded = source < 0 ? -1 : Math.round(source + (target - source) * blend);
        interpolated[index] = encoded;
        pixels[index] = encoded < 0 ? 0xffffffff : paletteWords[encoded];
      }
      const pixelScale = replayPixelScale(canvas);
      for (let y = 0; y < height - 1; y += 1) {
        for (let x = 0, index = y * width; x < width - 1; x += 1, index += 1) {
          const encoded = interpolated[index];
          if (encoded < 0) continue;
          const right = interpolated[index + 1];
          const down = interpolated[index + width];
          const slopeX = right < 0 ? 0 : Math.abs(right - encoded);
          const slopeY = down < 0 ? 0 : Math.abs(down - encoded);
          const gradient = (slopeX + slopeY) * phaseScale;
          const footprint = gradient * pixelScale;
          if (gradient < 0.004 || footprint < 0.006 || footprint >= 0.55) continue;
          const phase = encoded * phaseScale - phaseOffset;
          const distance = Math.abs(phase - Math.round(phase));
          if (distance > 0.72 * footprint) continue;
          const line = smooth(0.006, 0.015, footprint) * (1 - smooth(0.12, 0.72, distance / footprint))
            * (1 - smooth(0.25, 0.55, footprint)) * opacity;
          for (let channel = 0; channel < 3; channel += 1) {
            const offset = 4 * index + channel;
            frame.data[offset] += (rgb[channel] - frame.data[offset]) * line;
          }
        }
      }
      context.putImageData(frame, 0, 0);
    },
  };
}

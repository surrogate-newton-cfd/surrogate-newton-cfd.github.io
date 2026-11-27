import * as THREE from './assets/vendor/three/three.module.min.js';
import { OrbitControls } from './assets/vendor/three/OrbitControls.js';

export function unpackWingFields(payload, model) {
  const {offset, length, shape} = model.buffers.sectionFields;
  const [, sections, height, width] = shape;
  const pixels = width * height;
  const tileBytes = pixels * 4;
  const frameBytes = sections * tileBytes;
  const rgba = new Uint8Array(payload, offset, length);
  const encoded = new Uint8Array(tileBytes);
  const zero = new Uint8Array(tileBytes);
  // Each section stores four channel planes, delta-coded against the previous frame.
  for (let tile = 0; tile < rgba.length; tile += tileBytes) {
    encoded.set(rgba.subarray(tile, tile + tileBytes));
    const previous = tile < frameBytes ? zero : rgba.subarray(tile - frameBytes, tile - frameBytes + tileBytes);
    for (let i = 0, pixel = 0; i < pixels; i++, pixel += 4) {
      rgba[tile + pixel] = encoded[i] + previous[pixel];
      rgba[tile + pixel + 1] = encoded[pixels + i] + previous[pixel + 1];
      rgba[tile + pixel + 2] = encoded[2 * pixels + i] + previous[pixel + 2];
      rgba[tile + pixel + 3] = encoded[3 * pixels + i] + previous[pixel + 3];
    }
  }
}

export function createWingOrbit(canvas, reset, payload, model, pressureStops, orientation, signal) {
  const bufferView = (name, Type = Float32Array) => {
    const {offset, length} = model.buffers[name];
    return new Type(payload, offset, length);
  };
  const vertices = bufferView('vertices');
  const pressure = bufferView('pressure');

  const renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: false});
  renderer.setClearColor(0xffffff);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 50);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(new THREE.BufferAttribute(bufferView('triangles', Uint32Array), 1));
  const colors = new THREE.Float32BufferAttribute(new Float32Array(vertices.length), 3);
  colors.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('color', colors);
  const surface = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({vertexColors:true, side:THREE.DoubleSide}));
  scene.add(surface);

  const root = new THREE.BufferGeometry();
  root.setAttribute('position', new THREE.BufferAttribute(bufferView('capVertices'), 3));
  root.setIndex(new THREE.BufferAttribute(bufferView('capTriangles', Uint32Array), 1));
  scene.add(new THREE.Mesh(root, new THREE.MeshBasicMaterial({
    color:0xe0e7ec, side:THREE.DoubleSide, transparent:true, opacity:.28, depthWrite:false,
  })));

  const [frames, count, height, width] = model.buffers.sectionFields.shape;
  const sliceSize = width * height * 4;
  const field = bufferView('sectionFields', Uint8Array);
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    lut.set([...FIELD_DISPLAY.colour(1.3 * i / 255, FIELD_DISPLAY.mach.stops).map(Math.round),255],i * 4);
  }
  const palette = new THREE.DataTexture(lut, 256, 1);
  palette.minFilter = palette.magFilter = THREE.LinearFilter;
  palette.needsUpdate = true;
  const textures = Array.from({length: frames}, (_, time) => Array.from({length: count}, (_, plane) => {
    const offset = (time * count + plane) * sliceSize;
    const texture = new THREE.DataTexture(field.subarray(offset, offset + sliceSize),width,height);
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  }));
  const corners = [];
  const sections = model.sections.map(([xmin,xmax,ymin,ymax,z],plane) => {
    for (const x of [xmin,xmax]) for (const y of [ymin,ymax]) corners.push(x,y,z);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        beforeField: {value:textures[0][plane]},
        afterField: {value:textures[0][plane]},
        mixture:{value:0},
        palette:{value:palette},
        logBounds:{value:new THREE.Vector2(...model.gradient_limits)},
      },
      vertexShader: `
        varying vec2 coord;
        void main() {
          coord = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D beforeField, afterField, palette;
        uniform float mixture;
        uniform vec2 logBounds;
        varying vec2 coord;
        void main() {
          vec4 state = mix(texture2D(beforeField,coord),texture2D(afterField,coord),mixture);
          vec3 machColor = texture2D(palette, vec2(state.r, .5)).rgb;
          float gradient = dot(state.gb, vec2(65280.0,255.0)) / 65535.0;
          float q = (mix(logBounds.x,logBounds.y,gradient)-log(.4)) * (8.0/log(13.5/.4));
          float footprint = max(fwidth(q),.001);
          float lineDistance = abs(q - floor(q+.5)) / footprint;
          float isoline = (1.0-smoothstep(.24,1.12,lineDistance)) *
            (1.0-smoothstep(.38,.85,footprint)) * smoothstep(-.07,.02,q) *
            (1.0-smoothstep(7.98,8.09,q)) * state.a * .69;
          float cloud = (.045 + .84 * smoothstep(.86,1.06,state.r*1.3)) * state.a;
          float alpha = isoline + cloud * (1.0-isoline);
          vec3 color = (vec3(.24,.34,.41)*isoline + machColor*cloud*(1.0-isoline))/max(alpha,.001);
          gl_FragColor = vec4(color,alpha);
        }
      `,
      transparent:true, depthWrite:false, side:THREE.DoubleSide, forceSinglePass:true,
    });
    const planeMesh = new THREE.Mesh(new THREE.PlaneGeometry(xmax-xmin,ymax-ymin),material);
    planeMesh.position.set((xmin+xmax)/2,(ymin+ymax)/2,z);
    scene.add(planeMesh);
    return material;
  });

  const minCp = pressureStops[0][0], spanCp = pressureStops.at(-1)[0] - minCp;
  const lookup = new Float32Array(1025 * 3);
  const color = new THREE.Color();
  for (let i = 0; i <= 1024; i++) {
    const cp = minCp + i / 1024 * spanCp;
    const [r,g,b] = FIELD_DISPLAY.colour(cp, pressureStops);
    color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    lookup.set([color.r, color.g, color.b], i * 3);
  }

  const target = new THREE.Vector3(.65, .11, -1.87);
  const offset = new THREE.Vector3(4.6, 2.45, 5.5);
  camera.position.copy(target).add(offset);
  camera.lookAt(target);
  const right = new THREE.Vector3(1,0,0).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0,1,0).applyQuaternion(camera.quaternion);
  const bounds = new THREE.Box2();
  const point = new THREE.Vector3();
  const projected = new THREE.Vector2();
  for (const floats of [vertices, corners]) {
    for (let i = 0; i < floats.length; i += 3) {
      point.fromArray(floats, i).sub(target);
      bounds.expandByPoint(projected.set(point.dot(right), point.dot(up)));
    }
  }
  const size = bounds.getSize(new THREE.Vector2());
  const centre = bounds.getCenter(new THREE.Vector2());
  target.addScaledVector(right, centre.x).addScaledVector(up, centre.y);
  camera.position.copy(target).add(offset);

  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(target);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.rotateSpeed = .72;
  controls.update();
  controls.saveState();
  if (orientation.offset) {
    camera.position.copy(target).add(new THREE.Vector3(...orientation.offset));
    controls.update();
  }

  let aspect = 1;
  function render() {
    if (canvas.clientWidth && canvas.clientHeight) renderer.render(scene, camera);
  }
  function fitCamera() {
    right.set(1,0,0).applyQuaternion(camera.quaternion);
    up.set(0,1,0).applyQuaternion(camera.quaternion);
    let horizontal = 0, vertical = 0;
    for (const floats of [vertices, corners]) {
      for (let i = 0; i < floats.length; i += 3) {
        point.fromArray(floats, i).sub(controls.target);
        horizontal = Math.max(horizontal, Math.abs(point.dot(right)));
        vertical = Math.max(vertical, Math.abs(point.dot(up)));
      }
    }
    const halfHeight = Math.max(size.y, size.x / aspect, 2 * vertical, 2 * horizontal / aspect) * .56;
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.updateProjectionMatrix();
  }
  function resize() {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    aspect = width / height;
    fitCamera();
    renderer.setSize(width, height, false);
    render();
  }

  let lastSample = [];
  function setTime(time, arm) {
    const {first, times, checkpoints} = model.tracks[arm];
    const next = times.findIndex(value => value > time);
    const after = next < 0 ? times.length - 1 : next;
    const before = next < 0 ? after : Math.max(0, after - 1);
    const f = checkpoints && before !== after
      ? THREE.MathUtils.clamp((time - times[before]) / (times[after] - times[before]), 0, 1) : 0;
    const lo = first + before, hi = f > 0 ? first + after : lo;
    if (lastSample[0] === lo && lastSample[1] === hi && lastSample[2] === f) return;
    lastSample = [lo, hi, f];
    const count = vertices.length / 3;
    for (let i = 0; i < count; i++) {
      const a = pressure[lo * count + i], b = pressure[hi * count + i];
      const stop = Math.round(1024 * THREE.MathUtils.clamp((a + (b - a) * f - minCp) / spanCp, 0, 1));
      colors.array[i * 3] = lookup[stop * 3];
      colors.array[i * 3 + 1] = lookup[stop * 3 + 1];
      colors.array[i * 3 + 2] = lookup[stop * 3 + 2];
    }
    for (const [i, material] of sections.entries()) {
      material.uniforms.beforeField.value = textures[lo][i];
      material.uniforms.afterField.value = textures[hi][i];
      material.uniforms.mixture.value = f;
    }
    colors.needsUpdate = true;
    render();
  }

  controls.addEventListener('change', () => {
    orientation.offset = camera.position.clone().sub(controls.target).toArray();
    fitCamera();
    render();
  });
  reset.addEventListener('click', () => controls.reset(), {signal});
  reset.disabled = false;
  canvas.addEventListener('keydown', event => {
    const motion = {ArrowLeft:[-.15,0], ArrowRight:[.15,0], ArrowUp:[0,-.12], ArrowDown:[0,.12]}[event.key];
    if (!motion) return;
    event.preventDefault();
    const rotation = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    rotation.theta += motion[0];
    rotation.phi += motion[1];
    rotation.makeSafe();
    camera.position.copy(controls.target).add(point.setFromSpherical(rotation));
    controls.update();
  }, {signal});
  const sizeObserver = new ResizeObserver(resize);
  sizeObserver.observe(canvas);
  signal.addEventListener('abort', () => {
    sizeObserver.disconnect();
    controls.dispose();
    scene.traverse(object => {
      object.geometry?.dispose();
      object.material?.dispose();
    });
    for (const texture of textures.flat()) texture.dispose();
    palette.dispose();
    renderer.dispose();
    reset.disabled = true;
  }, {once:true});
  resize();
  return {setTime};
}

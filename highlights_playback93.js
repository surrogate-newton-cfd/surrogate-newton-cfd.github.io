'use strict';

function mountHighlightWingComparison(chart, comparison) {
 const {warm, cold, terminal_frame_time} = comparison;
 const warmEnd = warm.at(-1)[0], coldEnd = cold.at(-1)[0];
 const ink = '#1d1d1f', warmColor = '#aa6b47', coldColor = '#3e647d';
 const left = 50, right = 422, top = 9, bottom = 124;
 const limit = Math.ceil(coldEnd / 50) * 50;
 const x = time => left + time / limit * (right - left);
 const y = residual => top - Math.log10(residual) / 6.45 * (bottom - top);
 const add = (tag, attributes, parent = chart) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  parent.append(node);
  return node;
 };
 const line = (x1, y1, x2, y2, stroke, parent = chart) => add('line', {x1, y1, x2, y2, stroke}, parent);
 const text = (value, atX, atY, attributes = {}, parent = chart) => {
  add('text', {x: atX, y: atY, fill: ink, 'text-anchor': 'middle', ...attributes}, parent).textContent = value;
 };
 for (const [value, label] of [[1, '1'], [.01, '10⁻²'], [.0001, '10⁻⁴'], [.000001, '10⁻⁶']]) {
  const atY = y(value);
  line(left, atY, right, atY, '#e5e5e8');
  text(label, left - 7, atY + 4, {'text-anchor': 'end', 'font-size': 14});
 }
 line(left, top, left, bottom, '#72727b');
 line(left, bottom, right, bottom, '#72727b');
 const tick = (atTime, label, parent) => {
  const atX = x(atTime);
  line(atX, bottom, atX, bottom + 4, '#72727b', parent);
  text(label, atX, bottom + 18, {'font-size': 14}, parent);
 };
 tick(0, '0');
 tick(limit / 2, String(limit / 2));
 text('Solver time (s)', (left + right) / 2, 191);
 text('Residual ratio, r', 12, (top + bottom) / 2, {transform: `rotate(-90 12 ${(top + bottom) / 2})`});

 const defs = add('defs', {});
 const clip = add('clipPath', {id: 'wing-warm-residual-clip'}, defs);
 const reveal = add('rect', {x: left - 2, y: 0, width: 2, height: bottom + 4}, clip);
 const plot = (points, color, attributes = {}) => {
  const d = points.map(([time, ratio], index) => `${index ? 'L' : 'M'}${x(time).toFixed(2)} ${y(ratio).toFixed(2)}`).join(' ');
  add('path', {d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', ...attributes});
 };
 plot(cold, coldColor, {'data-arm': 'cold'});
 plot(warm, warmColor, {'clip-path': 'url(#wing-warm-residual-clip)', 'data-arm': 'warm'});
 const marker = add('circle', {cx: left, cy: y(warm[0][1]), r: 3.5, fill: warmColor});
 add('circle', {cx: x(coldEnd), cy: y(cold.at(-1)[1]), r: 3.5, fill: coldColor});

 const callout = add('g', {id: 'wing-case-speedup', visibility: 'hidden'});
 tick(warmEnd, warmEnd.toFixed(1), callout);
 tick(coldEnd, coldEnd.toFixed(1), callout);
 const a = x(warmEnd), b = x(coldEnd), bracket = bottom + 31;
 line(a, bracket, b, bracket, ink, callout);
 line(a, bracket - 4, a, bracket + 4, ink, callout);
 line(b, bracket - 4, b, bracket + 4, ink, callout);
 const speedup = `${(coldEnd / warmEnd).toFixed(1)}× faster`;
 text(speedup, (a + b) / 2, bracket + 18, {'font-weight': 600, 'font-size': 17}, callout);
 chart.setAttribute('aria-label', `Wing convergence comparison: Surrogate + NK ${warmEnd.toFixed(1)} seconds; cold-start CFD ${coldEnd.toFixed(1)} seconds; ${speedup}.`);

 return elapsed => {
  const time = Math.min(1, elapsed / terminal_frame_time) * warmEnd;
  let upper = warm.findIndex(([value]) => value > time);
  if (upper < 0) upper = warm.length - 1;
  const [t0, r0] = warm[upper - 1], [t1, r1] = warm[upper];
  const atY = y(r0) + (time - t0) / (t1 - t0) * (y(r1) - y(r0));
  const atX = x(time);
  reveal.setAttribute('width', atX - left + 2);
  marker.setAttribute('cx', atX);
  marker.setAttribute('cy', atY);
  callout.setAttribute('visibility', time >= warmEnd ? 'visible' : 'hidden');
 };
}

async function initHighlights(){
 const el=id=>document.getElementById(id),tabs=[...document.querySelectorAll('[data-scene]')],panels=['scene-overview','scene-airfoils','scene-wings'].map(el);
 const motion=matchMedia('(prefers-reduced-motion: reduce)'),overview=el('overview-video'),matrix=el('airfoil-matrix-video'),wingVideo=el('wing-video');
 const clamp=x=>Math.max(0,Math.min(1,x));
 const loadVideo = video => new Promise((resolve, reject) => {
  video.addEventListener('loadeddata', resolve, {once:true});
  video.addEventListener('error', () => reject(new Error(video.id + ' unavailable')), {once:true});
  video.preload = 'auto';
  video.src = video.dataset.src;
 });
 const [data] = await Promise.all([
  fetch('assets/highlights/playback.json').then(response => {
   if (!response.ok) throw new Error('Playback metadata unavailable');
   return response.json();
  }),
  loadVideo(overview), loadVideo(matrix), loadVideo(wingVideo),
 ]);
 const {airfoils, wing, overviewSource} = data;
 const drawWingComparison=mountHighlightWingComparison(el('wing-case-residual'),wing.residual_comparison);
 el('wing-median-speedup').textContent=`${wing.residual_comparison.median_paired_speedup.toFixed(1)}×`;
 const airfoilRanks = [...new Set(airfoils.cases.map(({mpi_ranks}) => mpi_ranks))];
 const mpiLabels = [
  `${overviewSource.mpi_ranks} MPI ranks`,
  `${airfoilRanks.join(' / ')} MPI ranks per case`,
  `${wing.mpi_ranks} MPI ranks`,
 ];
 if (wing.conditions) {
  const {mach, alpha_degrees, reynolds} = wing.conditions;
  const angle = alpha_degrees.toFixed(2).replace('-', '−');
  el('wing-mach-angle').textContent = `Ma ${mach.toFixed(3)} · α ${angle}°`;
  el('wing-reynolds').textContent = `Re ${(reynolds / 1e7).toFixed(2)} × 10⁷`;
  el('wing-conditions').hidden = false;
 }
 el('overview-median-nk').textContent='1.76 s';
 el('overview-median-cold').textContent='10.10 s';
 el('overview-speedup').textContent='5.8×';
 // Decode offscreen; paint ordinary page canvases to avoid native video-layer seams.
 const surfaces=new Map([[overview,el('overview-surface')],[matrix,el('airfoil-matrix-surface')],[wingVideo,el('wing-canvas')]].map(([video,canvas])=>[video,{canvas,context:canvas.getContext('2d',{alpha:false}),whiteLift:null,holding:false}]));
 const compactQuery=matchMedia('(max-width: 760px)');
 // [sx,sy,sw,sh,dx,dy,dw,dh] in source-video pixels.
 const airfoilTiles=[];
 for(let i=0;i<12;i++){const c=i%5,r=Math.floor(i/5);airfoilTiles.push([c*368+40,r*144+70,366,148,(i%2)*384,50+Math.floor(i/2)*150,366,148]);}
 const compactLayouts=new Map([
  [overview,{w:1060,h:1322,parts:[[10,0,1060,820,0,0,1060,820],[1130,40,470,332,0,820,526,372],[1130,372,470,448,534,820,526,502]]}],
  [matrix,{w:750,h:1210,parts:[[660,0,600,50,75,0,600,50],...airfoilTiles,[430,945,520,120,115,960,520,120],[950,945,580,120,85,1085,580,120]]}],
  [wingVideo,{w:1290,h:590,parts:[[150,170,1290,430,0,0,1290,430],[1275,570,305,78,110,440,490,125],[1275,666,305,78,690,440,490,125]],masks:[[1110,392,180,40]]}],
 ]);
 // Wide screens: lift the wing ~100 source px so the bottom chart/legends have room; colour bars stay put.
 const wideLayouts=new Map([
  [wingVideo,{w:1600,h:810,parts:[[0,120,1270,500,0,20,1270,500],[1270,120,330,440,1270,20,330,440],[1270,560,330,250,1270,560,330,250]]}],
 ]);
 compactQuery.addEventListener?.('change',()=>{for(const video of surfaces.keys())paintVideo(video);dirty=true;});
 function paintVideo(video){
  const surface=surfaces.get(video),{canvas,context}=surface;
  if(video.readyState<2||video.seeking)return;
  // Narrow screens: re-compose source regions so baked-in labels stay legible.
  const layout=(compactQuery.matches?compactLayouts:wideLayouts).get(video)||null;
  if(!surface.base)surface.base=[canvas.width,canvas.height];
  const [targetW,targetH]=layout?[layout.w,layout.h]:surface.base;
  if(canvas.width!==targetW||canvas.height!==targetH){canvas.width=targetW;canvas.height=targetH;surface.whiteLift=null;}
  canvas.dataset.compact=layout?'true':'false';
  if(layout){
   context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
   for(const [sx,sy,sw,sh,dx,dy,dw,dh] of layout.parts)context.drawImage(video,sx,sy,sw,sh,dx,dy,dw,dh);
   context.fillStyle='#fff';for(const [x,y,w,h] of layout.masks||[])context.fillRect(x,y,w,h);
  }else context.drawImage(video,0,0,canvas.width,canvas.height);
  // Both source movies have a pure-white margin. Match its decoded white point
  // to the CSS white page so Safari cannot expose the rectangular movie boundary.
  if(!surface.whiteLift){
   const white=Array.from(context.getImageData(0,0,1,1).data).slice(0,3);
   if(white.every(c=>c>=248))surface.whiteLift=white.map(c=>255-c);
  }
  if(surface.whiteLift?.some(c=>c>0)){
   context.globalCompositeOperation='lighter';context.fillStyle='rgb('+surface.whiteLift.join(',')+')';context.fillRect(0,0,canvas.width,canvas.height);context.globalCompositeOperation='source-over';
  }
 }
 for(const video of surfaces.keys())video.addEventListener?.('seeked',()=>{
  dirty=true;
  if(video===[overview,matrix,wingVideo][index])videoFrame(video,durations[index]);else paintVideo(video);
  // Repaint after the decoded seek frame reaches the compositor, including paused review.
  const surface=surfaces.get(video);
  if(typeof video.requestVideoFrameCallback==='function'){
   if(surface.pendingFrame)video.cancelVideoFrameCallback?.(surface.pendingFrame);
   surface.pendingFrame=video.requestVideoFrameCallback(()=>{surface.pendingFrame=null;paintVideo(video);dirty=true;});
  }
  requestAnimationFrame(()=>{paintVideo(video);dirty=true;});
 });
 const durations=[overviewSource.animation.duration,airfoils.animation.duration,wing.animation.duration];
 // Every fresh page load begins with the overview, including old scene-specific links.
 const initialScene=0;
 const states=durations.map(duration=>({elapsed:motion.matches?duration:0,playing:!motion.matches}));
 let index=initialScene,elapsed=states[index].elapsed,visible=false,dirty=true,last=0,lastPaint=0;
 for(const [i,video] of [overview,matrix,wingVideo].entries()){
  video.loop=false;
  video.addEventListener('ended',()=>{
   if(i!==index||!states[i].playing)return;
   elapsed=durations[i];states[i].elapsed=elapsed;states[i].playing=false;changed();
  });
 }
 const captions=['Fast convergence, even out of distribution.','30 OOD airfoils converge in under 3 s.','Scaling to 3.5M-cell 3D wings.'];
 const setText=(node,text)=>{if(node&&node.textContent!==text)node.textContent=text;};
 const names=['Overview','Airfoil','Wing'];
 const play=el('highlight-play'),replay=el('highlight-replay'),scrub=el('highlight-scrub');
 const icons={play:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5 19 12 8 19Z" fill="currentColor"/></svg>',pause:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z" fill="currentColor"/></svg>'};
 const timeLabel=value=>{const seconds=Math.floor(Math.max(0,value));return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');};
 function updateControls(){
  const running=states[index].playing,ended=elapsed>=durations[index]-.01,kind=running?'pause':'play';
  if(play.dataset.icon!==kind){play.innerHTML=icons[kind];play.dataset.icon=kind;}
  const label=(running?'Pause ':ended?'Replay ':'Play ')+names[index];play.setAttribute('aria-label',label);play.title=label;play.setAttribute('aria-pressed',String(running));
  replay.setAttribute('aria-label','Replay '+names[index]);scrub.setAttribute('aria-label','Review '+names[index]+' animation');
  scrub.value=String(Math.round(clamp(elapsed/durations[index])*1000));
  setText(el('highlight-position'),timeLabel(elapsed)+' / '+timeLabel(durations[index]));
  el('highlight-player').setAttribute('data-playing',String(running));
 }
 function changed(){states[index].elapsed=elapsed;dirty=true;render();}
 play.onclick=()=>{if(elapsed>=durations[index]-.01){elapsed=0;states[index].playing=true;}else states[index].playing=!states[index].playing;changed();};
 replay.onclick=()=>{elapsed=0;states[index].playing=true;changed();};
 scrub.addEventListener('input',()=>{elapsed=clamp(Number(scrub.value)/1000)*durations[index];states[index].playing=false;changed();});

 function sync(){
  tabs.forEach((tab,i)=>{
   const selected=i===index;
   tab.setAttribute('aria-selected',String(selected));
   tab.tabIndex=selected?0:-1;
   panels[i].setAttribute('aria-hidden',String(!selected));
   panels[i].inert=!selected;
  });
  setText(el('hero-scene-caption'),captions[index]);
  el('highlights-scale-note').style.visibility=index===2?'hidden':'';
  setText(el('highlight-mpi'),mpiLabels[index]);
  el('highlight-player').setAttribute('data-scene',String(index));
  if(index!==0)overview.pause();if(index!==1)matrix.pause();if(index!==2)wingVideo.pause();
 }
 function videoFrame(video,duration){
  const surface=surfaces.get(video);surface.holding=elapsed>=duration-.001;
  // Hold within the final coded frame, through the same decoder and colour pipeline.
  // Seeking to exact duration can expose the poster in Safari; switching to a still
  // image can change colour management. Neither is needed to retain the last frame.
  if(surface.holding){
   video.pause();
   const fps=[overviewSource.animation.fps||25,airfoils.animation.fps||25,wing.animation.fps||24][index];
   const end=Number.isFinite(video.duration)?video.duration:duration,finalTime=Math.max(0,end-.5/fps);
   if(!video.seeking&&Math.abs(video.currentTime-finalTime)>.008)video.currentTime=finalTime;
   paintVideo(video);return;
  }
  const end=Number.isFinite(video.duration)?video.duration:duration,time=Math.min(elapsed,Math.max(0,end-1/60)),running=states[index].playing&&visible&&!document.hidden&&time<Math.min(duration,end)-.05;
  if(!video.seeking&&Math.abs(video.currentTime-time)>(running?.22:.015))video.currentTime=time;
  if(running&&video.paused)video.play().catch(()=>{});else if(!running)video.pause();
  paintVideo(video);
 }
 function render(){
  updateControls();
  setText(el('highlight-playback-value'),'Playback '+[overviewSource.animation.playback_rate,airfoils.animation.rate,wing.playback_label_multiplier][index]+'×');
  el('highlight-playback').style.visibility='visible';
  if(index===0){
   videoFrame(overview,durations[0]);
   const animation=overviewSource.animation,timing=overviewSource.timing_comparison,solverTime=timing.cold_seconds*clamp((elapsed-animation.solver_start)/animation.solver_duration);
   const tilt=clamp((elapsed-animation.tilt_start)/(animation.tilt_end-animation.tilt_start)),p=tilt*tilt*(3-2*tilt);
   const key=el('overview-key');key.style.setProperty('--legend-initial-opacity',String(1-clamp(p/.28)));key.style.setProperty('--legend-stats-opacity',String(clamp((p-.28)/.62)));key.style.setProperty('--legend-stats-offset',(6*(1-p))+'px');
   const showStatistics=p>.28;
   el('overview-key').setAttribute('data-statistics',String(showStatistics));
   el('overview-statistics').setAttribute('aria-hidden',String(!showStatistics));el('overview-initial-legend').setAttribute('aria-hidden',String(showStatistics));
   for(const id of ['overview-metric-title','overview-median-nk','overview-median-cold','overview-speedup-metric'])el(id).setAttribute('aria-hidden',String(!showStatistics));
   const facts=solverTime>=timing.cold_seconds?'Distance-bin residual curve, Surrogate + NK: '+timing.nk_seconds.toFixed(2)+' seconds. Cold-start CFD: '+timing.cold_seconds.toFixed(2)+' seconds. '+timing.speedup.toFixed(1)+' times faster.':solverTime>=timing.nk_seconds?'The distance-bin median residual reaches its target at '+timing.nk_seconds.toFixed(2)+' seconds. Cold-start CFD is still converging.':'RAE2822 median residual trajectories play at '+animation.playback_rate+'× speed alongside native pressure fields.';
   const population=overviewSource.population_statistics;
   const statistics='Median convergence times in the legend: Surrogate + NK '+population.nk_seconds.toFixed(2)+' seconds; cold-start CFD '+population.cold_seconds.toFixed(2)+' seconds; '+'5.8 times speedup. The original OOD distances are retained. Geometry callouts are centred on the full neighbouring upper-edge extent. The geometry dimension is labelled OOD distance. The full left composition, including geometry rail and axes, aligns vertically with the full right field/annotation/colorbar group. The active NK trajectory and the centred error-field correction arrow advance together. The arrow resets directly for each new case; its speedup appears after convergence. The story ends at the last displayed geometry.';
   setText(el('overview-timing'),elapsed>=animation.unfold_start?statistics:facts);
  }
  if(index===1){
   videoFrame(matrix,durations[1]);
   const a=airfoils.animation,t=Math.min(a.solver_end,Math.max(0,(elapsed-a.lead)*a.rate));
   const complete=airfoils.cases.filter(c=>t>=c.end).length;
   setText(el('airfoil-matrix-description'),'Thirty different OOD benchmark geometries with independently sampled Mach and angle of attack. Each geometry has adjacent Flow · Cp and Error · ΔCp views. The shared key gives their left-to-right order. Flow and error geometries both have solid outlines. Flow uses blue-white-copper; signed error uses muted teal-white-rose with pure white at zero. Both colour scales are fixed. '+complete+' of 30 cases have converged. Solver time '+t.toFixed(2)+' seconds; playback '+a.rate+' times.');
  }
  if(index===2){
   videoFrame(wingVideo,durations[2]);
   drawWingComparison(elapsed);
  }
 }
 for(const video of surfaces.keys())paintVideo(video);
 const go=mountHorizontalCarousel(el('highlight-scenes'),next=>{
  states[index].elapsed=elapsed;
  index=next;
  elapsed=states[index].elapsed;
  dirty=true;
  sync();
  render();
 });
 tabs.forEach((tab,i)=>{
  tab.onclick=()=>go(i);
  tab.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?2:(i+(e.key==='ArrowLeft'?2:1))%3;go(next);tabs[next].focus({preventScroll:true});};
 });
 motion.addEventListener('change',()=>{for(const state of states)state.playing=false;dirty=true;});
 new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;if(visible)dirty=true;else{overview.pause();matrix.pause();wingVideo.pause();}},{threshold:.18}).observe(el('highlight-player'));
 document.addEventListener?.('visibilitychange',()=>{if(document.hidden){overview.pause();matrix.pause();wingVideo.pause();}else dirty=true;});
 globalThis.addEventListener?.('resize',()=>dirty=true);
 function tick(now){
  const dt=last?Math.min((now-last)/1000,.1):0;last=now;
  if(states[index].playing&&visible&&!document.hidden){elapsed=Math.min(elapsed+dt,durations[index]);states[index].elapsed=elapsed;if(elapsed>=durations[index])states[index].playing=false;dirty=true;}
  if(dirty&&visible&&!document.hidden&&now-lastPaint>=1000/30-1){render();dirty=false;lastPaint=now;}
  requestAnimationFrame(tick);
 }
 requestAnimationFrame(tick);
}

(() => {
 const stage = document.getElementById('highlight-player');
 const start = () => initHighlights().catch(error => {
  console.warn('Highlights:', error);
  document.getElementById('hero-scene-caption').textContent = 'Reload to play the highlights.';
 });
 if (!('IntersectionObserver' in window) || ['#highlights', '#highlight-player'].includes(location.hash)) {
  start();
  return;
 }
 const observer = new IntersectionObserver(([entry]) => {
  if (!entry.isIntersecting) return;
  observer.disconnect();
  start();
 }, {rootMargin: '220px 0px'});
 observer.observe(stage);
})();

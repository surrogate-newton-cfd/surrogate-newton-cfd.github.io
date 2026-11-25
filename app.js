'use strict';
const $=s=>document.querySelector(s);
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const NS='http://www.w3.org/2000/svg';
const svg=(tag,attrs,parent)=>{const el=document.createElementNS(NS,tag);for(const [k,v]of Object.entries(attrs))el.setAttribute(k,v);parent?.append(el);return el;};
const toast=message=>{const el=$('#toast');el.textContent=message;el.hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.hidden=true,2500);};

function showConvergenceTimes(chart, series) {
 const numbers = chart.closest('.convergence-hero').querySelectorAll('[data-convergence-time]');
 numbers.forEach((number, index) => {
  number.textContent = series[index].finish.toFixed(2) + ' s';
 });
}

function drawConvergenceChart(chart, series, targetLog, gridTransfers = []) {
 const bounds = chart.getBoundingClientRect();
 const width = Math.max(280, bounds.width);
 const height = bounds.height;
 const L = 64, R = width - 20, T = 14, B = height - 46;
 const end = Math.max(...series.map(line => line.finish));
 const step = [1, 2, 5, 10, 20, 25, 50, 100, 200].find(value => end / value <= 6) || 500;
 const extent = Math.ceil(end / (step / 2)) * step / 2;
 const logs = series.flatMap(line => line.history.map(([, ratio]) => Math.log10(Math.max(1e-30, ratio))));
 const top = Math.ceil(Math.max(...logs) / 2) * 2;
 const bottom = Math.min(targetLog - .35, Math.min(...logs) - .12);
 const X = time => L + time / extent * (R - L);
 const Y = ratio => T + (top - Math.log10(Math.max(1e-30, ratio))) / (top - bottom) * (B - T);
 const label = (value, attrs) => { svg('text', attrs, chart).textContent = value; };
 chart.replaceChildren();
 chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
 for (let power = top; power >= bottom; power -= 2) {
  const y = Y(10 ** power);
  svg('line', {x1:L,x2:R,y1:y,y2:y,stroke:'#e4e4e9'}, chart);
  label(power ? `10${superscript(power)}` : '1', {x:L - 10,y:y + 5,'text-anchor':'end'});
 }
 for (const time of gridTransfers) {
  const x = X(time);
  svg('line', {x1:x,x2:x,y1:T,y2:B,stroke:'#ceced4','stroke-dasharray':'2 4'}, chart);
 }
 svg('line', {x1:L,x2:R,y1:B,y2:B,stroke:'#aaaab0'}, chart);
 for (let time = 0; time <= extent; time += step) {
  label(time, {x:X(time),y:B + 21,'text-anchor':'middle'});
 }
 const middle = (T + B) / 2;
 label('Residual ratio', {x:16,y:middle,transform:`rotate(-90 16 ${middle})`,'text-anchor':'middle'});
 label('Solver time (s)', {x:(L + R) / 2,y:height - 5,'text-anchor':'middle'});

 const clipId = chart.id + '-reveal';
 const clip = svg('clipPath', {id:clipId}, svg('defs', {}, chart));
 const reveal = svg('rect', {x:L,y:0,width:0,height}, clip);
 const markers = series.map(({history, fixed}, index) => {
  const color = index === 0 ? '#aa6b47' : '#565d67';
  const d = history.map(([t, r], i) => `${i ? 'L' : 'M'}${X(t).toFixed(2)},${Y(r).toFixed(2)}`).join(' ');
  const path = {d, fill:'none', stroke:color, 'stroke-width':2.2, 'stroke-linejoin':'round'};
  if (!fixed) svg('path', {...path, opacity:.22}, chart);
  svg('path', fixed ? path : {...path, 'clip-path':`url(#${clipId})`}, chart);
  return svg('circle', {r:4.5, fill:color, stroke:'#fff', 'stroke-width':1.5}, chart);
 });
 const [warm, cold] = series.map(line => line.finish);
 const speedupCallout = svg('g', {visibility:'hidden'}, chart);
 if (cold > warm) {
  const a = X(warm), b = X(cold), y = B - 15;
  svg('path', {d:`M${a},${y}H${b}M${a},${y-4}v8M${b},${y-4}v8`, fill:'none', stroke:'#1d1d1f', 'stroke-width':1.25}, speedupCallout);
  svg('text', {x:(a + b) / 2,y:y - 8,'text-anchor':'middle',class:'closer-speedup'}, speedupCallout)
    .textContent = `${(cold / warm).toFixed(1)}× faster`;
 }
 return {X, Y, markers, reveal, speedupCallout, plotBox:{left:L, right:R, extent, width}};
}

function showPlaybackTime(output, scrub, solverTime, solverEnd, pace) {
 const label = `${solverTime.toFixed(2)} / ${solverEnd.toFixed(2)} s`;
 if (output.textContent !== label) output.textContent = label;
 scrub.value = Math.round(solverTime / solverEnd * 1000);
 scrub.setAttribute('aria-valuetext', `Solver time ${solverTime.toFixed(2)} of ${solverEnd.toFixed(2)} seconds`);
}

async function initFlowJourney(directory,signal){
 const response=await fetch(`assets/${directory}/manifest.json`,{signal});if(!response.ok)throw Error('Convergence replay unavailable');
 const data=await response.json(),arms=['warm','cold'],end=Math.max(...arms.map(a=>data.arms[a].end));
 const pace = 2.5;
 const finalFields = data.field_mode === 'converged';
 const renderers={},outlines=[],cache=new Map();
 for(const arm of arms){
  for(const frame of data.arms[arm].frames){const src=frame.pressure_src;if(!cache.has(src)){const im=new Image();im.decoding='async';im.src=src;cache.set(src,im);}}
 }
 // Finish decoding before playback so changing a sample never stalls image decode.
 await Promise.all([...cache.values()].map(im=>im.decode()));
 signal.throwIfAborted();
 $('#closer-airfoil-conditions').textContent=formatCaseConditions(data.mach,data.alpha,data.reynolds);
 const legend=$('#journey-colorbar');
 FIELD_DISPLAY.drawColorbar(legend, finalFields
  ? {...FIELD_DISPLAY.cp, title: 'Converged pressure coefficient, Cₚ'}
  : FIELD_DISPLAY.cp);
 legend.hidden=false;
 const chart=$('#journey-chart'),play=$('#journey-play'),scrub=$('#journey-scrub'),replay=$('#journey-reset'),clock=$('#journey-time');
 const series=arms.map(arm=>({history:data.arms[arm].history,finish:data.arms[arm].end}));
 showConvergenceTimes(chart,series);
 $('#journey-pace').textContent = `Playback ${pace}×`;
 let time=0,playing=false,hasCompleted=false,visible=false,enoughPlayerInView=false,last=0,lastPaint=0,dirty=true,inspecting=false,availableTime=0,plotBox={},reveal,speedupCallout,dots={},X,Y;
 const text=(el,value)=>{if(el.textContent!==value)el.textContent=value;};
 function at(points,t){
  let lo=0,hi=points.length-1;
  if(t>=points[hi][0])return points[hi][1];
  while(hi-lo>1){const m=(lo+hi)>>1;if(points[m][0]<=t)lo=m;else hi=m;}
  const a=points[lo],b=points[hi],f=Math.max(0,Math.min(1,(t-a[0])/(b[0]-a[0]||1)));
  return Math.exp(Math.log(a[1])*(1-f)+Math.log(b[1])*f);
 }
 function drawChart(){
  let markers;
  ({X,Y,plotBox,reveal,markers,speedupCallout}=drawConvergenceChart(chart,series,-8));
  [dots.warm,dots.cold]=markers;
  dirty=true;
 }
 drawChart();
 const chartResize=new ResizeObserver(()=>{
  if (signal.aborted || !chart.clientWidth) return;
  drawChart();
  render();
  dirty=false;
 });
 chartResize.observe(chart);
 for(const arm of arms){
  const canvas=$('#'+arm+'-frame');
  const method = arm === 'warm' ? 'Surrogate + NK' : 'Cold-start CFD';
  const evolution = arm === 'warm' ? 'NK correction' : 'cold-start CFD convergence';
  canvas.setAttribute('aria-label', finalFields
   ? `Converged pressure coefficient field for ${method}`
   : `Pressure coefficient field during ${evolution}`);
  try{renderers[arm]=new PressureReplay(canvas,data.mach);}catch(error){
   // A fresh canvas is required after a failed WebGL context request.
   const replacement=canvas.cloneNode();canvas.replaceWith(replacement);
   renderers[arm]=pressureReplayFallback(replacement,data.mach);
  }
  if(data.geometry_path){const outline=svg('svg',{viewBox:'0 0 880 360',class:'foil-outline','aria-hidden':'true'},$('#'+arm+'-frame').parentElement);svg('path',{d:data.geometry_path,fill:'white',stroke:'#1d1d1f','stroke-width':1.25,'stroke-linejoin':'round'},outline);outlines.push(outline);}
 }
 function syncPlay(){
  text(play,playing?'Ⅱ':'▶');play.setAttribute('aria-label',playing?'Pause convergence playback':'Play convergence playback');
  chart.setAttribute('aria-disabled',String(!hasCompleted));chart.setAttribute('tabindex',hasCompleted?'0':'-1');
  const inspection = finalFields ? 'Inspect the residual curves' : 'Inspect the synchronized flow fields and residual curves';
  chart.setAttribute('aria-label',hasCompleted?`${inspection}. Use arrow keys to change time.`:'Convergence playback. Inspection opens when the first playback finishes.');
 }

 function render(){
  availableTime=inspecting?end:Math.max(availableTime,time);reveal.setAttribute('width',Math.max(0,X(availableTime)-X(0)));
  if(speedupCallout)speedupCallout.setAttribute('visibility',availableTime>=data.arms.warm.end?'visible':'hidden');
  for(const arm of arms){
   const {end: finish, history, frames} = data.arms[arm];
   const t=Math.min(time,finish),r=at(history,t);
   let hi=frames.findIndex(f=>f.time>t);if(hi<0)hi=frames.length-1;const lo=hi>0?hi-1:0;
   const a=frames[lo],b=frames[hi],blend=Math.max(0,Math.min(1,(t-a.time)/(b.time-a.time||1)));
   renderers[arm].draw(cache.get(a.pressure_src),cache.get(b.pressure_src),blend);
   dots[arm].setAttribute('cx',X(t));dots[arm].setAttribute('cy',Y(r));
  }
  showPlaybackTime(clock,scrub,time,end,pace);
  chart.setAttribute('aria-valuenow',time.toFixed(3));chart.setAttribute('aria-valuetext',`Solver time ${time.toFixed(2)} seconds. Surrogate + NK residual ${at(data.arms.warm.history,Math.min(time,data.arms.warm.end)).toExponential(2)}. Cold-start residual ${at(data.arms.cold.history,Math.min(time,data.arms.cold.end)).toExponential(2)}.`);
  if (playing && time >= end) {
   playing = false;
   hasCompleted = true;
   syncPlay();
  }
 }
 function inspectAt(value){
  playing=false;inspecting=true;time=Math.max(0,Math.min(end,value));
  if(time>=end)hasCompleted=true;
  dirty=true;syncPlay();
 }
 function pointerTime(e){const rect=chart.getBoundingClientRect(),x=(e.clientX-rect.left)/rect.width*plotBox.width;return (x-plotBox.left)/(plotBox.right-plotBox.left)*plotBox.extent;}
 chart.onpointermove=e=>{if(!hasCompleted)return;if(e.pointerType==='mouse'||chart.hasPointerCapture(e.pointerId))inspectAt(pointerTime(e));};
 chart.onpointerdown=e=>{if(!hasCompleted||e.button!==0)return;e.preventDefault();chart.setPointerCapture(e.pointerId);inspectAt(pointerTime(e));};
 chart.onpointerup=chart.onpointercancel=e=>{if(chart.hasPointerCapture(e.pointerId))chart.releasePointerCapture(e.pointerId);};
 chart.setAttribute('role','slider');chart.setAttribute('tabindex','0');chart.setAttribute('aria-valuemin','0');chart.setAttribute('aria-valuemax',end.toFixed(3));chart.setAttribute('aria-label','Hover to inspect synchronized flow fields and residual curves. Use arrow keys to change time.');
 chart.onkeydown=e=>{if(!hasCompleted)return;if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();inspectAt(e.key==='Home'?0:e.key==='End'?end:time+(e.key==='ArrowLeft'?-1:1)*end/100);}};
 play.onclick=()=>{if(time>=end){time=0;availableTime=0;}last=0;playing=!playing;inspecting=false;dirty=true;syncPlay();};
 replay.onclick=()=>{time=0;availableTime=0;last=0;playing=true;inspecting=false;dirty=true;syncPlay();};
 scrub.oninput=()=>inspectAt(+scrub.value/1000*end);
 for(const control of [play,replay,scrub])control.disabled=false;
 motion.addEventListener('change',()=>{if(motion.matches){playing=false;time=end;hasCompleted=true;dirty=true;syncPlay();}},{signal});
 // Let readers finish the method diagram before the replay starts below it.
 const playbackVisibility = .25;
 const visibility=new IntersectionObserver(([entry])=>{
  visible=entry.isIntersecting;
  enoughPlayerInView=entry.intersectionRatio>=playbackVisibility;
  last=0;
 },{threshold:[0,playbackVisibility]});visibility.observe($('#convergence-player'));
 document.addEventListener('visibilitychange',()=>{last=0;},{signal});
 playing=!motion.matches;if(motion.matches){time=end;hasCompleted=true;}syncPlay();render();dirty=false;
 const qa=typeof location!=='undefined'&&location.search.includes('qa=1'),samples=[];
 function tick(now){
  if(signal.aborted)return;
  if(playing&&enoughPlayerInView&&!document.hidden){
   if(last)time=Math.min(end,time+(now-last)*pace/1000);
   last=now;dirty=true;
  }
  // A shared 30 fps paint budget keeps fields and curve markers in step.
  if(dirty&&visible&&!document.hidden&&now-lastPaint>=1000/30-1){
   if(qa&&lastPaint&&playing){samples.push(now-lastPaint);if(samples.length%60===0){const sorted=samples.slice().sort((a,b)=>a-b),rate=$('#journey-rate');rate.hidden=false;text(rate,`Paint median ${sorted[Math.floor(sorted.length*.5)].toFixed(1)} ms · p95 ${sorted[Math.floor(sorted.length*.95)].toFixed(1)} ms`);}}
   render();dirty=false;lastPaint=now;
  }
  animation=requestAnimationFrame(tick);
 }
 let animation=requestAnimationFrame(tick);
 signal.addEventListener('abort',()=>{
  cancelAnimationFrame(animation);chartResize.disconnect();visibility.disconnect();
  for(const renderer of Object.values(renderers))renderer.dispose?.();
  for(const outline of outlines)outline.remove();
  chart.onpointermove=chart.onpointerdown=chart.onpointerup=chart.onpointercancel=chart.onkeydown=null;
  play.onclick=replay.onclick=scrub.oninput=null;
  for(const control of [play,replay,scrub])control.disabled=true;
 },{once:true});
}

const citation=`@article{lei2026surrogate_newton,\n  title={Reliable and efficient steady CFD from surrogate predictions through Newton--Krylov correction},\n  author={Lei, Mingcheng and Tang, Weishao and Zhang, Yufei and Chen, Haixin},\n  journal={arXiv preprint arXiv:2608.04400},\n  year={2026}\n}`;
$('#copy-citation').onclick=async()=>{try{await navigator.clipboard.writeText(citation);$('#citation-label').textContent='Copied';toast('BibTeX copied to clipboard');setTimeout(()=>$('#citation-label').textContent='Copy',2500);}catch{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([citation],{type:'text/plain'}));a.download='surrogate-newton.bib';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);toast('Citation downloaded');}};

/* SuperMimic-style Explore dropdown & FAQ expand-all controller */
(()=>{
 const btn=$('#explore-btn'),menu=$('#explore-menu');
 if(btn&&menu){
  const setOpen=open=>{btn.setAttribute('aria-expanded',String(open));menu.hidden=!open;};
  btn.addEventListener('click',e=>{e.stopPropagation();setOpen(menu.hidden);});
  menu.addEventListener('click',e=>{if(e.target.closest('a'))setOpen(false);});
  document.addEventListener('click',e=>{if(!menu.hidden&&!e.target.closest('.nav-explore'))setOpen(false);});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!menu.hidden){setOpen(false);btn.focus();}});
 }
 const faqAll=$('#faq-all'),faqList=$('#faq-list');
 if(faqAll&&faqList){
  const items=[...faqList.querySelectorAll('details')];
  const syncFaq=()=>{
   const allOpen=items.every(d=>d.open);
   faqAll.setAttribute('aria-expanded',String(allOpen));
   faqAll.firstChild.textContent=allOpen?'Collapse all ':'Expand all ';
  };
  faqAll.addEventListener('click',()=>{
   const next=!items.every(d=>d.open);
   for(const d of items)d.open=next;
   syncFaq();
  });
  for(const d of items)d.addEventListener('toggle',syncFaq);
  syncFaq();
 }
 const fnDrawer=$('#footnotes-drawer');
 if(fnDrawer){
  const openFootnote=hash=>{
   if(!/^#fn\d+$/.test(hash))return;
   fnDrawer.open=true;
   const target=document.getElementById(hash.slice(1));
   if(target)requestAnimationFrame(()=>target.scrollIntoView({behavior:motion.matches?'auto':'smooth',block:'center'}));
  };
  document.addEventListener('click',e=>{
   const link=e.target.closest('a[href^="#fn"]');
   if(!link)return;
   fnDrawer.open=true;
  });
  window.addEventListener('hashchange',()=>openFootnote(location.hash));
  const initialHash=location.hash;
  if(/^#fn\d+$/.test(initialHash)){
   fnDrawer.open=true;
   const scrollToInitialFootnote=async()=>{
    await document.fonts.ready;
    if(location.hash===initialHash&&fnDrawer.open){
     document.getElementById(initialHash.slice(1))?.scrollIntoView({behavior:'instant',block:'center'});
    }
   };
   if(document.readyState==='complete')scrollToInitialFootnote();
   else window.addEventListener('load',scrollToInitialFootnote,{once:true});
  }
 }
})();

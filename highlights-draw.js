'use strict';
(function(root){
 const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
 const palette=p=>{const stops=[[.35,18,56,102],[.55,38,92,143],[.78,125,177,206],[1,255,255,255],[1.18,221,181,146],[1.46,153,76,35]];let i=0;while(i<stops.length-2&&p>stops[i+1][0])i++;const a=stops[i],b=stops[i+1],f=clamp((p-a[0])/(b[0]-a[0]));return a.slice(1).map((v,j)=>v+(b[j+1]-v)*f);};
 const colors=Array.from({length:512},(_,i)=>'rgb('+palette(.3+i/511*1.3).map(n=>Math.round(n)).join(',')+')');
 const line=(ctx,points,color,width)=>{ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineCap='round';ctx.lineJoin='round';ctx.stroke();};
 function wingProjection(p){const [x,y,z]=p;const span=z+0.32775;return [600+span*170+(x-.7)*75,245-span*18+(x-.7)*200-y*180];}
 function prepareWing(mesh){
  const faces=[];
  for(const block of mesh.blocks){const [nr,nc]=block.shape,positions=block.positions;for(let r=0;r<nr-1;r++)for(let c=0;c<nc-1;c++){const ids=[r*nc+c,(r+1)*nc+c,(r+1)*nc+c+1,r*nc+c+1],p=ids.map(i=>positions.slice(i*3,i*3+3));const center=[0,1,2].map(k=>p.reduce((s,q)=>s+q[k],0)/4);faces.push({ids,block:block.id,pts:p.map(wingProjection),depth:center[0]*.63+center[1]*.72-center[2]*.28,cut:!!block.cut});}}
  const pts=faces.flatMap(f=>f.pts),xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);
  const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys),scale=Math.min(1080/(maxX-minX),420/(maxY-minY));
  mesh.view={scale,x:600-(minX+maxX)/2*scale,y:250-(minY+maxY)/2*scale};
  for(const face of faces)face.pts=face.pts.map(p=>[p[0]*scale+mesh.view.x,p[1]*scale+mesh.view.y]);
  return faces.sort((a,b)=>a.depth-b.depth);
 }
 function drawWing(ctx,width,height,mesh,faces,fieldsA,fieldsB,blend){
  ctx.save();ctx.scale(width/1200,height/500);ctx.fillStyle='#fff';ctx.fillRect(0,0,1200,500);
  const view=p=>{const q=wingProjection(p),v=mesh.view;return [q[0]*v.scale+v.x,q[1]*v.scale+v.y];};
  for(const face of faces){const a=fieldsA[face.block],b=fieldsB[face.block];let p=0;for(const i of face.ids)p+=(a[i]*(1-blend)+b[i]*blend)/4;const color=colors[Math.round(clamp((p-.3)/1.3)*511)];ctx.beginPath();face.pts.forEach((q,i)=>i?ctx.lineTo(...q):ctx.moveTo(...q));ctx.closePath();ctx.fillStyle=color;ctx.fill();ctx.strokeStyle=color;ctx.lineWidth=.55;ctx.stroke();}
  // Sparse physical patch edges define the wing without a decorative mesh.
  ctx.strokeStyle='#24343f';ctx.lineWidth=.8;
  for(const block of mesh.blocks){if(block.cut)continue;const [nr,nc]=block.shape,p=block.positions;for(const row of [0,nr-1])line(ctx,Array.from({length:nc},(_,c)=>view(p.slice((row*nc+c)*3,(row*nc+c)*3+3))),'#3c4c57',.7);}
  ctx.restore();
 }
 root.HighlightDrawing={prepareWing,drawWing,palette,wingProjection};
})(typeof window==='undefined'?globalThis:window);

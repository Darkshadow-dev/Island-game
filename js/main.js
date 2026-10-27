(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const THREE = window.THREE;
  const WORLD_M = 447000, HALF_M = WORLD_M / 2, MAP_SIZE = 447;
  const MAX_HEIGHT_M = 5500, OCEAN_FLOOR_M = -1000, SCALE_M = 100;
  const CHUNK_M = 600, CHUNK_SEGMENTS = 20, SAVE_KEY = "islad-local-save-v1";
  const seedRandom = (seed) => { let n = seed >>> 0; return () => { n += 0x6D2B79F5; let t=n; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; }; };
  const makeId = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36)+Math.random().toString(36).slice(2,12));
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  const smooth = (a,b,x) => { const t=clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); };
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const defaultData = () => ({version:1,playerId:makeId(),settings:{brightness:108,renderDistance:1400,sfx:true,mobileCap:true},worlds:[null,null,null],shared:{},updatedAt:Date.now()});
  let appData = defaultData(), mapImage = null, mapData = null, mapCtx = null;
  let scene = null, camera = null, renderer = null, terrainMaterial = null, waterMaterial = null;
  let activeWorld = null, player = null, worldRunning = false, paused = false, serverOnline = false;
  let renderDistance = 1400, chunkMap = new Map(), chunkQueue = [], remotePlayers = new Map(), socket = null;
  let lastChunkUpdate = 0, saveClock = 0, netClock = 0, footstepClock = 0, toastClock = 0, audioContext = null;
  let settingsReturn = "homeView", deleteSlot = -1, pointerIsLocked = false, mouseDown = false;
  const keyboard = Object.create(null), touchMove = {x:0,y:0}, touchLook = {id:null,x:0,y:0};
  const peakSeeds = [
    {u:.43,v:.25,h:3100,w:.047},{u:.56,v:.32,h:4700,w:.034},{u:.48,v:.43,h:5100,w:.030},
    {u:.43,v:.55,h:4350,w:.031},{u:.36,v:.67,h:3600,w:.043},{u:.61,v:.46,h:2900,w:.046},{u:.68,v:.29,h:2550,w:.052}
  ];
  const isMobile = () => matchMedia("(pointer: coarse)").matches || innerWidth < 760;

  function showError(message){const box=$("#errorBanner");box.textContent=message;box.hidden=false;}
  function showToast(message){const node=$("#toast");node.textContent=message;node.classList.add("show");clearTimeout(toastClock);toastClock=setTimeout(()=>node.classList.remove("show"),3200);}
  function smoothSetting(){
    if(!renderer)return;
    const mobileLimit=isMobile()&&appData.settings.mobileCap;
    const ratio=Math.min(devicePixelRatio||1,mobileLimit?1.25:1.7);
    renderer.setPixelRatio(ratio);renderer.setSize(innerWidth,innerHeight,false);
    renderer.toneMappingExposure=Number(appData.settings.brightness||108)/100;
    renderDistance=Number(appData.settings.renderDistance||1400);
    if(mobileLimit)renderDistance=Math.min(renderDistance,1200);
    if(camera){camera.far=renderDistance/SCALE_M;camera.updateProjectionMatrix();}
    if(scene&&scene.fog){scene.fog.near=Math.max(4,renderDistance/SCALE_M*.18);scene.fog.far=renderDistance/SCALE_M;}
  }
  function applySettingsToInputs(){
    $("#brightnessRange").value=appData.settings.brightness;
    $("#brightnessValue").value=appData.settings.brightness+"%";
    $("#renderRange").value=appData.settings.renderDistance;
    $("#renderValue").value=Number(appData.settings.renderDistance).toLocaleString()+" m";
    $("#sfxToggle").checked=!!appData.settings.sfx;
    $("#mobileCapToggle").checked=!!appData.settings.mobileCap;
    smoothSetting();
  }

  async function loadMap(){
    try {
      mapImage=new Image();mapImage.src="images/images.jfif";
      await mapImage.decode();
      const canvas=document.createElement("canvas");canvas.width=MAP_SIZE;canvas.height=MAP_SIZE;mapCtx=canvas.getContext("2d",{willReadFrequently:true});
      mapCtx.drawImage(mapImage,0,0,MAP_SIZE,MAP_SIZE);
      const pixels=mapCtx.getImageData(0,0,MAP_SIZE,MAP_SIZE).data, raw=new Uint8Array(MAP_SIZE*MAP_SIZE);
      for(let y=0;y<MAP_SIZE;y++)for(let x=0;x<MAP_SIZE;x++){
        const i=y*MAP_SIZE+x, p=i*4, r=pixels[p],g=pixels[p+1],b=pixels[p+2],l=(r+g+b)/3;
        const frame=x>=14&&x<433&&y>=14&&y<433;
        const compass=(x>378&&y<83), legend=(x>334&&y>364);
        const blue=b>r*1.02&&b>g*1.02&&(b-r)>10;
        if(frame&&!compass&&!legend&&!blue&&l>43)raw[i]=1;
      }
      const mask=new Uint8Array(raw.length);
      for(let y=1;y<MAP_SIZE-1;y++)for(let x=1;x<MAP_SIZE-1;x++){
        let n=0;for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++)n+=raw[(y+oy)*MAP_SIZE+x+ox];
        mask[y*MAP_SIZE+x]=n>=5?1:0;
      }
      const dist=new Float32Array(mask.length);dist.fill(10000);
      for(let y=0;y<MAP_SIZE;y++)for(let x=0;x<MAP_SIZE;x++){
        const i=y*MAP_SIZE+x;if(!mask[i]){dist[i]=0;continue;}
        if(x===0||y===0||x===MAP_SIZE-1||y===MAP_SIZE-1||!mask[i-1]||!mask[i+1]||!mask[i-MAP_SIZE]||!mask[i+MAP_SIZE])dist[i]=0;
      }
      const diag=1.414;
      for(let y=0;y<MAP_SIZE;y++)for(let x=0;x<MAP_SIZE;x++){
        const i=y*MAP_SIZE+x;if(!mask[i])continue;
        if(x>0)dist[i]=Math.min(dist[i],dist[i-1]+1);
        if(y>0)dist[i]=Math.min(dist[i],dist[i-MAP_SIZE]+1);
        if(x>0&&y>0)dist[i]=Math.min(dist[i],dist[i-MAP_SIZE-1]+diag);
        if(x<MAP_SIZE-1&&y>0)dist[i]=Math.min(dist[i],dist[i-MAP_SIZE+1]+diag);
      }
      for(let y=MAP_SIZE-1;y>=0;y--)for(let x=MAP_SIZE-1;x>=0;x--){
        const i=y*MAP_SIZE+x;if(!mask[i])continue;
        if(x<MAP_SIZE-1)dist[i]=Math.min(dist[i],dist[i+1]+1);
        if(y<MAP_SIZE-1)dist[i]=Math.min(dist[i],dist[i+MAP_SIZE]+1);
        if(x<MAP_SIZE-1&&y<MAP_SIZE-1)dist[i]=Math.min(dist[i],dist[i+MAP_SIZE+1]+diag);
        if(x>0&&y<MAP_SIZE-1)dist[i]=Math.min(dist[i],dist[i+MAP_SIZE-1]+diag);
      }
      mapData={mask,dist,pixels};
    } catch(error) {
      mapImage=null;mapCtx=null;
      const mask=new Uint8Array(MAP_SIZE*MAP_SIZE),dist=new Float32Array(mask.length);
      for(let y=0;y<MAP_SIZE;y++)for(let x=0;x<MAP_SIZE;x++){const nx=(x-MAP_SIZE/2)/(MAP_SIZE*.43),ny=(y-MAP_SIZE/2)/(MAP_SIZE*.42);if(nx*nx+ny*ny<1+.13*Math.sin(x*.07)*Math.sin(y*.05)){const i=y*MAP_SIZE+x;mask[i]=1;dist[i]=Math.max(0,(1-Math.sqrt(nx*nx+ny*ny))*30);}}
      mapData={mask,dist,pixels:null};
      showToast("Map image unavailable; using a generated island outline.");
    }
  }
  function mapCoords(x,z){return {u:(x+HALF_M)/WORLD_M,v:(z+HALF_M)/WORLD_M};}
  function mapIndex(u,v){const x=clamp(Math.round(u*(MAP_SIZE-1)),0,MAP_SIZE-1),y=clamp(Math.round(v*(MAP_SIZE-1)),0,MAP_SIZE-1);return {x,y,i:y*MAP_SIZE+x};}
  function heightAt(x,z,seed){
    if(Math.abs(x)>HALF_M||Math.abs(z)>HALF_M)return null;
    const pos=mapCoords(x,z),at=mapIndex(pos.u,pos.v),m=mapData.mask[at.i];
    if(!m)return null;
    const mx=clamp(pos.u*(MAP_SIZE-1),0,MAP_SIZE-1),my=clamp(pos.v*(MAP_SIZE-1),0,MAP_SIZE-1),x0=Math.floor(mx),y0=Math.floor(my),x1=Math.min(MAP_SIZE-1,x0+1),y1=Math.min(MAP_SIZE-1,y0+1),tx=mx-x0,ty=my-y0;
    const dA=mapData.dist[y0*MAP_SIZE+x0]*(1-tx)+mapData.dist[y0*MAP_SIZE+x1]*tx,dB=mapData.dist[y1*MAP_SIZE+x0]*(1-tx)+mapData.dist[y1*MAP_SIZE+x1]*tx,d=dA*(1-ty)+dB*ty;
    let height=110+Math.min(1500,d*62);
    let ridge=0;
    for(let j=0;j<peakSeeds.length;j++){
      const p=peakSeeds[j],dx=(pos.u-p.u)*MAP_SIZE,dz=(pos.v-p.v)*MAP_SIZE;
      const wobble=1+Math.sin((seed%997)*.013+j*2.1)*.11;
      const g=p.h*wobble*Math.exp(-Math.pow(Math.hypot(dx,dz)/p.w/ MAP_SIZE,1.55));
      ridge=Math.max(ridge,g);
    }
    const seedN=(Number(seed)||1)%7919;
    const detail=Math.sin(x*.00072+seedN*.019+Math.cos(z*.00042))*Math.sin(z*.00081-seedN*.011)*115+Math.sin((x+z)*.0028+seedN)*31+Math.sin(x*.014+z*.009+seedN*.4)*22+Math.cos(z*.0042-x*.0021)*18;
    height=(height+ridge+detail)*smooth(0,1.8,d);
    return clamp(height,0,MAX_HEIGHT_M);
  }
  function findSpawn(seed){
    let best=null,bestScore=Infinity;
    for(let y=34;y<420;y+=2)for(let x=25;x<420;x+=2){
      const i=y*MAP_SIZE+x;if(!mapData.mask[i])continue;
      const u=x/(MAP_SIZE-1),v=y/(MAP_SIZE-1),worldX=(u-.5)*WORLD_M,worldZ=(v-.5)*WORLD_M;
      const h=heightAt(worldX,worldZ,seed);if(h==null)continue;
      const target=Math.hypot((x-220)*.75,y-352);
      const score=target+Math.max(0,h-1200)*.016+h*.00035;
      if(score<bestScore){bestScore=score;best={x:worldX,z:worldZ,y:h+1.72};}
    }
    return best||{x:0,z:0,y:heightAt(0,0,seed)||900};
  }
  function findScenicPosition(seed){
    let best=null,bestHeight=-1;
    for(let y=128;y<302;y+=4)for(let x=142;x<312;x+=4){const i=y*MAP_SIZE+x;if(!mapData.mask[i])continue;const wx=(x/(MAP_SIZE-1)-.5)*WORLD_M,wz=(y/(MAP_SIZE-1)-.5)*WORLD_M,h=heightAt(wx,wz,seed);if(h!==null&&h>bestHeight){bestHeight=h;best={x:wx,z:wz,y:h+180};}}
    return best||findSpawn(seed);
  }
  function terrainColor(h,x,z){
    const c=new THREE.Color();
    if(h<220)c.set(0xc4b184).lerp(new THREE.Color(0x84916b),smooth(80,300,h));
    else if(h<1800)c.set(0x667c50).lerp(new THREE.Color(0x526e49),smooth(350,1800,h));
    else if(h<3200)c.set(0x526e49).lerp(new THREE.Color(0x77776a),smooth(1800,3200,h));
    else if(h<4600)c.set(0x77776a).lerp(new THREE.Color(0xa4a69b),smooth(3200,4600,h));
    else c.set(0xa4a69b).lerp(new THREE.Color(0xe3e3d8),smooth(4600,MAX_HEIGHT_M,h));
    const variation=1+.035*Math.sin(x*.0017+z*.0011);
    c.multiplyScalar(variation);return c;
  }
  function createFoliage(parent,centerX,centerZ,world,cx,cz){
    const rand=seedRandom((Number(world.seed)||1)+cx*73856093+cz*19349663),trees=[],bushes=[],grass=[];
    const pick=(margin)=>({x:centerX+(rand()-.5)*(CHUNK_M-margin),z:centerZ+(rand()-.5)*(CHUNK_M-margin)});
    for(let n=0;n<105;n++){
      const p=pick(40),h=heightAt(p.x,p.z,world.seed);if(h==null||h<90||h>2900)continue;
      const h1=heightAt(p.x+50,p.z,world.seed),h2=heightAt(p.x-50,p.z,world.seed),h3=heightAt(p.x,p.z+50,world.seed),h4=heightAt(p.x,p.z-50,world.seed);
      if(h1==null||h2==null||h3==null||h4==null||Math.max(Math.abs(h1-h),Math.abs(h2-h),Math.abs(h3-h),Math.abs(h4-h))>340)continue;
      if(rand()>.45)continue;
      trees.push({x:(p.x-centerX)/SCALE_M,y:h/SCALE_M,z:(p.z-centerZ)/SCALE_M,s:.78+rand()*.62,turn:rand()*Math.PI*2,tint:.86+rand()*.25});
    }
    for(let n=0;n<50;n++){
      const p=pick(16),h=heightAt(p.x,p.z,world.seed);if(h==null||h<20||h>3400||rand()>.58)continue;
      bushes.push({x:(p.x-centerX)/SCALE_M,y:h/SCALE_M,z:(p.z-centerZ)/SCALE_M,s:.65+rand()*.65,turn:rand()*6.28});
    }
    for(let n=0;n<100;n++){
      const p=pick(12),h=heightAt(p.x,p.z,world.seed);if(h==null||h<20||h>2500||rand()>.48)continue;
      grass.push({x:(p.x-centerX)/SCALE_M,y:h/SCALE_M,z:(p.z-centerZ)/SCALE_M,s:.6+rand()*.9,turn:rand()*6.28});
    }
    const dummy=new THREE.Object3D();
    function addInstances(geometry,material,items,place){if(!items.length)return;const mesh=new THREE.InstancedMesh(geometry,material,items.length);mesh.frustumCulled=true;items.forEach((item,i)=>{place(dummy,item);dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);if(item.tint&&mesh.setColorAt)mesh.setColorAt(i,new THREE.Color(item.tint,item.tint,item.tint));});mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;parent.add(mesh);}
    const trunkMat=new THREE.MeshStandardMaterial({color:0x574838,roughness:1}),leafMat=new THREE.MeshStandardMaterial({color:0x536c42,roughness:1}),bushMat=new THREE.MeshStandardMaterial({color:0x637d4b,roughness:1}),grassMat=new THREE.MeshStandardMaterial({color:0x81904f,roughness:1,side:THREE.DoubleSide});
    const trunkGeo=new THREE.CylinderGeometry(.018,.031,.07,5),leafGeo=new THREE.ConeGeometry(.12,.15,5),bushGeo=new THREE.IcosahedronGeometry(.017,0),grassGeo=new THREE.ConeGeometry(.0035,.012,3);
    addInstances(trunkGeo,trunkMat,trees,(o,t)=>{o.position.set(t.x,t.y+.035*t.s,t.z);o.rotation.set(0,t.turn,0);o.scale.set(t.s,t.s,t.s);});
    for(let layer=0;layer<3;layer++)addInstances(leafGeo,leafMat,trees,(o,t)=>{o.position.set(t.x,t.y+(.085+layer*.056)*t.s,t.z);o.rotation.set(0,t.turn+layer*.8,0);o.scale.set(t.s*(1-layer*.14),t.s*(1-layer*.04),t.s*(1-layer*.14));});
    addInstances(bushGeo,bushMat,bushes,(o,b)=>{o.position.set(b.x,b.y+.012*b.s,b.z);o.rotation.set(0,b.turn,0);o.scale.set(b.s,b.s*.72,b.s);});
    addInstances(grassGeo,grassMat,grass,(o,g)=>{o.position.set(g.x,g.y+.006*g.s,g.z);o.rotation.set(0,g.turn,0);o.scale.set(g.s,g.s,g.s);});
  }
  function makeChunk(cx,cz,world){
    const startX=-HALF_M+cx*CHUNK_M,startZ=-HALF_M+cz*CHUNK_M,centerX=startX+CHUNK_M/2,centerZ=startZ+CHUNK_M/2;
    const positions=[],colors=[],indices=[],heights=new Float32Array((CHUNK_SEGMENTS+1)*(CHUNK_SEGMENTS+1));
    const step=CHUNK_M/CHUNK_SEGMENTS;
    for(let iz=0;iz<=CHUNK_SEGMENTS;iz++)for(let ix=0;ix<=CHUNK_SEGMENTS;ix++){
      const x=startX+ix*step,z=startZ+iz*step,h=heightAt(x,z,world.seed),valid=h!==null;
      heights[iz*(CHUNK_SEGMENTS+1)+ix]=valid?h:OCEAN_FLOOR_M;
      positions.push((x-centerX)/SCALE_M,(valid?h:OCEAN_FLOOR_M)/SCALE_M,(z-centerZ)/SCALE_M);
      const c=valid?terrainColor(h,x,z):new THREE.Color(0x26312b);colors.push(c.r,c.g,c.b);
    }
    for(let iz=0;iz<CHUNK_SEGMENTS;iz++)for(let ix=0;ix<CHUNK_SEGMENTS;ix++){
      const x=startX+(ix+.5)*step,z=startZ+(iz+.5)*step;if(heightAt(x,z,world.seed)===null)continue;
      const a=iz*(CHUNK_SEGMENTS+1)+ix,b=a+1,c=a+CHUNK_SEGMENTS+1,d=c+1;indices.push(a,c,b,b,c,d);
    }
    const geometry=new THREE.BufferGeometry();geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute("color",new THREE.Float32BufferAttribute(colors,3));geometry.setIndex(indices);geometry.computeVertexNormals();geometry.computeBoundingSphere();
    const group=new THREE.Group();group.position.set(centerX/SCALE_M,0,centerZ/SCALE_M);
    const mesh=new THREE.Mesh(geometry,terrainMaterial);mesh.receiveShadow=false;mesh.frustumCulled=true;group.add(mesh);
    const foliage=new THREE.Group();foliage.position.y=0;createFoliage(foliage,centerX,centerZ,world,cx,cz);group.add(foliage);
    scene.add(group);return {group,geometry,cx,cz,centerX,centerZ};
  }
  function readLocalStorage(){try{const raw=localStorage.getItem(SAVE_KEY);return raw?JSON.parse(raw):null;}catch(error){return null;}}
  async function readPrivateSave(){try{if(!navigator.storage||!navigator.storage.getDirectory)return null;const root=await navigator.storage.getDirectory();const handle=await root.getFileHandle("islad-save.json");const file=await handle.getFile();return JSON.parse(await file.text());}catch(error){return null;}}
  function normalizeData(saved){const base=defaultData();if(saved&&typeof saved==="object"){base.version=1;base.playerId=saved.playerId||base.playerId;base.settings=Object.assign(base.settings,saved.settings||{});base.worlds=Array.isArray(saved.worlds)?saved.worlds.slice(0,3):base.worlds;base.shared=Object.assign({},saved.shared||{});}while(base.worlds.length<3)base.worlds.push(null);return base;}
  function updateSaveModel(){if(!activeWorld||!player)return;activeWorld.player={x:player.x,y:player.y,z:player.z,yaw:player.yaw,pitch:player.pitch,health:player.health,stamina:player.stamina};activeWorld.updatedAt=Date.now();if(Number.isInteger(activeWorld.slot))appData.worlds[activeWorld.slot]=activeWorld;else if(activeWorld.publicId)appData.shared[activeWorld.publicId]=activeWorld;else appData.shared[String(activeWorld.seed)]=activeWorld;}
  let saveInFlight=false,saveAgain=false;
  async function saveLocal(){updateSaveModel();appData.updatedAt=Date.now();try{localStorage.setItem(SAVE_KEY,JSON.stringify(appData));}catch(error){}if(!navigator.storage||!navigator.storage.getDirectory)return;if(saveInFlight){saveAgain=true;return;}saveInFlight=true;try{const root=await navigator.storage.getDirectory(),handle=await root.getFileHandle("islad-save.json",{create:true}),writer=await handle.createWritable();await writer.write(JSON.stringify(appData));await writer.close();}catch(error){}finally{saveInFlight=false;if(saveAgain){saveAgain=false;saveLocal();}}}
  function openView(id){document.querySelectorAll(".menu-view").forEach(view=>view.hidden=view.id!==id);$("#frontMenu").hidden=false;$("#confirmDialog").hidden=true;}
  function renderWorldSlots(){
    const container=$("#worldSlots");container.innerHTML="";
    for(let i=0;i<3;i++){
      const world=appData.worlds[i],card=document.createElement("article");card.className="world-slot"+(world?"":" slot-empty");
      const name=world&&world.name?world.name:"Island "+(i+1);
      let meta=world?"LOCAL SAVE · "+new Date(world.updatedAt||world.createdAt||Date.now()).toLocaleDateString():"EMPTY SLOT · NEW ISLAND";
      if(world&&world.publicId)meta+=" · PUBLIC LINK";
      card.innerHTML='<div class="slot-head"><div><h3 class="slot-name">'+esc(name)+'</h3><p class="slot-meta">'+esc(meta)+'</p></div><span class="slot-index">0'+(i+1)+'</span></div><div class="slot-actions">'+(world?'<button class="slot-play" data-play="'+i+'">Continue</button><button class="slot-share" data-share="'+i+'">'+(world.publicId?'Copy link':'Make public')+'</button><button class="slot-delete" data-delete="'+i+'">Delete</button>':'<button class="slot-play" data-create="'+i+'">Create island</button>')+'</div>';
      container.appendChild(card);
    }
    container.querySelectorAll("[data-create]").forEach(button=>button.addEventListener("click",()=>createWorld(Number(button.dataset.create))));
    container.querySelectorAll("[data-play]").forEach(button=>button.addEventListener("click",()=>enterWorldObject(appData.worlds[Number(button.dataset.play)],true)));
    container.querySelectorAll("[data-share]").forEach(button=>button.addEventListener("click",()=>shareWorld(Number(button.dataset.share))));
    container.querySelectorAll("[data-delete]").forEach(button=>button.addEventListener("click",()=>confirmWorldDelete(Number(button.dataset.delete))));
  }
  function createWorld(slot){
    const seed=(Math.floor(Math.random()*0x7fffffff)+1)>>>0,spawn=findSpawn(seed),now=Date.now();
    const world={slot,name:"Island "+(slot+1),seed:seed,createdAt:now,updatedAt:now,publicId:null,ownerKey:null,publicState:{removedTrees:[],minedStone:[],supportColumns:[],inventory:{}},player:Object.assign({},spawn,{yaw:0,pitch:0,health:100,stamina:100})};
    appData.worlds[slot]=world;saveLocal();enterWorldObject(world,true);
  }
  function setPlayerFromWorld(world){
    const safeSpawn=findSpawn(world.seed),spawn=world.player&&Number.isFinite(world.player.x)?world.player:safeSpawn;
    player={x:Number(spawn.x)||0,y:Number(spawn.y)||0,z:Number(spawn.z)||0,vx:0,vy:0,vz:0,yaw:Number(spawn.yaw)||0,pitch:Number(spawn.pitch)||0,health:clamp(Number(spawn.health)||100,0,100),stamina:clamp(Number(spawn.stamina)||100,0,100),grounded:false,swimming:false,jumpQueued:false,damage:0,spawnX:safeSpawn.x,spawnZ:safeSpawn.z};
    if(player.y<1)player.y=(heightAt(player.x,player.z,world.seed)||0)+1.72;
  }
  function enterWorldObject(world,requestLock){
    if(!world)return;activeWorld=world;setPlayerFromWorld(world);worldRunning=true;paused=false;
    $("#frontMenu").hidden=true;$("#gameHud").hidden=false;$("#pauseView").hidden=true;$("#mobileControls").hidden=!isMobile();
    $("#hudWorldName").textContent=String(world.name||"ISLAND").toUpperCase();
    $("#hudWorldMode").textContent=world.publicId?"PUBLIC · INVITE LINK":"PRIVATE WORLD · LOCAL SAVE";
    $("#playerCount").innerHTML='1 <span>/ 4 PLAYERS</span>';
    if(renderer&&renderer.domElement){renderer.domElement.style.cursor=isMobile()?"default":"none";if(requestLock&&!isMobile()&&renderer.domElement.requestPointerLock)renderer.domElement.requestPointerLock();}
    drawMiniMap();refreshChunkSet(true);saveLocal();if(world.publicId)connectToWorld(world);else closeSocket();
    showToast(world.publicId?"Joining public island…":"World saved on this device.");
  }
  async function checkWorldServer(){
    try{const response=await fetch("/api/health",{cache:"no-store"});if(!response.ok)throw new Error("offline");const data=await response.json();serverOnline=!!data.ok;}
    catch(error){serverOnline=false;}
    const node=$("#serverStatus");node.className="server-status "+(serverOnline?"online":"offline");node.textContent=serverOnline?"WORLD SERVER ONLINE · invite links and 4-player worlds are ready":"WORLD SERVER OFFLINE · local worlds work; public multiplayer needs the Node server";
  }
  async function api(path,options){const response=await fetch(path,Object.assign({headers:{"content-type":"application/json"}},options||{}));let body={};try{body=await response.json();}catch(error){}if(!response.ok)throw new Error(body.error||("Request failed ("+response.status+")"));return body;}
  function publicLink(world){const url=new URL(location.href);url.hash="";url.search="";if(world.publicId)url.searchParams.set("world",world.publicId);else{url.searchParams.set("seed",String(world.seed));url.searchParams.set("name",world.name||"Island");}return url.toString();}
  async function copyLink(link){try{await navigator.clipboard.writeText(link);showToast("Invite link copied.");}catch(error){window.prompt("Copy this island link:",link);}}
  async function shareWorld(slot){
    const world=appData.worlds[slot];if(!world)return;
    if(world.publicId){await copyLink(publicLink(world));return;}
    try{
      const created=await api("/api/worlds",{method:"POST",body:JSON.stringify({name:world.name,seed:world.seed,publicState:world.publicState})});
      world.publicId=created.id;world.ownerKey=created.ownerKey;world.updatedAt=Date.now();serverOnline=true;await saveLocal();renderWorldSlots();await copyLink(publicLink(world));
    }catch(error){await copyLink(publicLink(world));showToast("Copied a world-seed link. Live multiplayer needs the Node world server.");}
  }
  function confirmWorldDelete(slot){
    const world=appData.worlds[slot];if(!world)return;deleteSlot=slot;
    $("#confirmTitle").textContent="Delete "+(world.name||"this world")+"?";
    $("#confirmText").textContent=world.publicId?"This removes the local save and the public world link for everyone.":"This permanently removes the world and player save from this device.";
    $("#confirmDialog").hidden=false;
  }
  async function deleteWorld(){
    const world=appData.worlds[deleteSlot];if(!world)return;
    if(world.publicId&&world.ownerKey){try{await api("/api/worlds/"+encodeURIComponent(world.publicId),{method:"DELETE",headers:{"content-type":"application/json","x-owner-key":world.ownerKey}});}catch(error){showToast("Could not reach the server. The public world was kept; try again online.");$("#confirmDialog").hidden=true;return;}}
    if(activeWorld===world){closeSocket();activeWorld=null;player=null;worldRunning=false;$("#gameHud").hidden=true;}appData.worlds[deleteSlot]=null;$("#confirmDialog").hidden=true;deleteSlot=-1;await saveLocal();renderWorldSlots();showToast("World deleted.");
  }
  async function joinFromInput(){
    const value=$("#joinLinkInput").value.trim();if(!value){showToast("Paste an island invite link first.");return;}
    let url;try{url=new URL(value,location.href);}catch(error){showToast("That link does not look right.");return;}
    const id=url.searchParams.get("world"),seed=url.searchParams.get("seed"),name=url.searchParams.get("name")||"Shared island";
    if(id){location.href=url.href;return;}
    if(seed){const n=Number(seed)>>>0,world={slot:null,name:name,seed:n,publicId:null,ownerKey:null,createdAt:Date.now(),updatedAt:Date.now(),publicState:{removedTrees:[],minedStone:[],supportColumns:[],inventory:{}},player:Object.assign({},findSpawn(n),{yaw:0,pitch:0,health:100,stamina:100})};appData.shared[String(n)]=world;await saveLocal();enterWorldObject(world,true);return;}
    showToast("This link has no island world attached.");
  }
  function openSettings(from){settingsReturn=from;openView("settingsView");}
  function openPause(){if(!worldRunning||paused)return;paused=true;worldRunning=false;$("#pauseView").hidden=false;$("#frontMenu").hidden=false;document.querySelectorAll(".menu-view").forEach(v=>v.hidden=v.id!=="pauseView");document.exitPointerLock&&document.exitPointerLock();renderer.domElement.style.cursor="default";}
  function resumeGame(){paused=false;worldRunning=true;$("#frontMenu").hidden=true;if(!isMobile()&&renderer.domElement.requestPointerLock)renderer.domElement.requestPointerLock();}
  function saveAndReturn(){saveLocal();closeSocket();worldRunning=false;paused=false;document.exitPointerLock&&document.exitPointerLock();$("#gameHud").hidden=true;$("#frontMenu").hidden=false;activeWorld=null;player=null;clearChunks();refreshChunkSet(true);renderWorldSlots();openView("worldsView");}
  function quitGame(){if(worldRunning)saveAndReturn();try{window.close();}catch(error){}setTimeout(()=>showToast("You can close this tab to quit."),100);}
  function playSfx(kind){if(!appData.settings.sfx)return;try{if(!audioContext)audioContext=new (window.AudioContext||window.webkitAudioContext)();if(audioContext.state==="suspended")audioContext.resume();const osc=audioContext.createOscillator(),gain=audioContext.createGain();osc.type=kind==="hurt"?"sawtooth":"triangle";osc.frequency.value=kind==="jump"?170:kind==="hurt"?75:95;gain.gain.setValueAtTime(kind==="hurt"?.055:.018,audioContext.currentTime);gain.gain.exponentialRampToValueAtTime(.0001,audioContext.currentTime+.08);osc.connect(gain);gain.connect(audioContext.destination);osc.start();osc.stop(audioContext.currentTime+.085);}catch(error){}}
  let previewWorld=null,previewPos=null,lastPublicSync=0;
  function clearChunks(){chunkMap.forEach(chunk=>{scene.remove(chunk.group);chunk.group.traverse(node=>{if(node.isMesh){if(node.geometry)node.geometry.dispose();if(Array.isArray(node.material))node.material.forEach(m=>m.dispose());else if(node.material)node.material.dispose();}});});chunkMap.clear();chunkQueue=[];}
  function refreshChunkSet(force){
    const world=activeWorld||previewWorld,pos=player||previewPos;if(!world||!pos||!scene)return;
    const ccx=Math.floor((pos.x+HALF_M)/CHUNK_M),ccz=Math.floor((pos.z+HALF_M)/CHUNK_M),radius=(activeWorld?renderDistance:1800)+CHUNK_M;
    const reach=Math.ceil(radius/CHUNK_M)+1,wanted=new Set();
    for(let dz=-reach;dz<=reach;dz++)for(let dx=-reach;dx<=reach;dx++){
      const cx=ccx+dx,cz=ccz+dz;if(cx<0||cz<0||cx>=Math.ceil(WORLD_M/CHUNK_M)||cz>=Math.ceil(WORLD_M/CHUNK_M))continue;
      const x=-HALF_M+cx*CHUNK_M+CHUNK_M/2,z=-HALF_M+cz*CHUNK_M+CHUNK_M/2;
      if(Math.hypot(x-pos.x,z-pos.z)>radius)continue;
      const key=String(world.seed)+":"+cx+":"+cz;wanted.add(key);
      if(!chunkMap.has(key)&&!chunkQueue.some(item=>item.key===key))chunkQueue.push({key,cx,cz,world});
    }
    chunkMap.forEach((chunk,key)=>{if(!wanted.has(key)){scene.remove(chunk.group);chunk.group.traverse(node=>{if(node.isMesh){if(node.geometry)node.geometry.dispose();if(Array.isArray(node.material))node.material.forEach(m=>m.dispose());else if(node.material)node.material.dispose();}});chunkMap.delete(key);}});
    if(force)lastChunkUpdate=0;
  }
  function pumpChunkQueue(){
    const count=isMobile()?1:2;
    for(let i=0;i<count&&chunkQueue.length;i++){const item=chunkQueue.shift();if(chunkMap.has(item.key))continue;try{chunkMap.set(item.key,makeChunk(item.cx,item.cz,item.world));}catch(error){console.error("Chunk build failed",error);}}
  }
  function createAvatar(id,name){
    const group=new THREE.Group(),hash=Array.from(String(id)).reduce((a,c)=>(a*33+c.charCodeAt(0))>>>0,5381),hue=(hash%360)/360;
    const jacket=new THREE.MeshStandardMaterial({color:new THREE.Color().setHSL(hue,.42,.52),roughness:.8}),skin=new THREE.MeshStandardMaterial({color:0xd8c39b,roughness:1}),dark=new THREE.MeshStandardMaterial({color:0x302f2a,roughness:1});
    const body=new THREE.Mesh(new THREE.CylinderGeometry(.0025,.0034,.009,6),jacket);body.position.y=.009;group.add(body);
    const head=new THREE.Mesh(new THREE.SphereGeometry(.00225,6,5),skin);head.position.y=.016;group.add(head);
    const legsGeo=new THREE.BoxGeometry(.0018,.006,.0021);for(let i=0;i<2;i++){const leg=new THREE.Mesh(legsGeo,dark);leg.position.set(i===0?-.0011:.0011,.003,0);group.add(leg);}
    group.userData.playerName=name||"Explorer";return group;
  }
  function updateRemotePlayers(players){
    if(!Array.isArray(players))players=[];const seen=new Set();
    for(const item of players){if(!item||item.id===appData.playerId)continue;seen.add(item.id);let avatar=remotePlayers.get(item.id);if(!avatar){avatar=createAvatar(item.id,item.name);remotePlayers.set(item.id,avatar);scene.add(avatar);}avatar.userData.playerName=item.name||"Explorer";avatar.position.set(Number(item.x||0)/SCALE_M,(Number(item.y||0)-1.72)/SCALE_M,Number(item.z||0)/SCALE_M);avatar.rotation.y=Number(item.yaw||0);}
    for(const [id,avatar] of remotePlayers){if(!seen.has(id)){scene.remove(avatar);remotePlayers.delete(id);}}
    const names=Array.from(remotePlayers.values()).map(v=>v.userData.playerName);$("#playerCount").innerHTML=(names.length+1)+' <span>/ 4 PLAYERS</span>';
    $("#playerNames").innerHTML=names.map(name=>'<span class="player-name-chip">'+esc(name)+'</span>').join("");
  }
  function closeSocket(){if(socket){try{socket.close(1000,"leave");}catch(error){}socket=null;}remotePlayers.forEach(avatar=>scene&&scene.remove(avatar));remotePlayers.clear();$("#playerNames").innerHTML="";$("#playerCount").innerHTML='1 <span>/ 4 PLAYERS</span>';}
  function connectToWorld(world){
    closeSocket();if(!world||!world.publicId||!serverOnline)return;
    try{
      const protocol=location.protocol==="https:"?"wss:":"ws:",name="Explorer-"+String(appData.playerId).slice(0,4).toUpperCase(),params=new URLSearchParams({world:world.publicId,player:appData.playerId,name:name});
      const connection=new WebSocket(protocol+"//"+location.host+"/ws?"+params.toString());socket=connection;
      connection.addEventListener("open",()=>{if(socket!==connection)return;connection.send(JSON.stringify({type:"hello",player:{id:appData.playerId,name:name,x:player.x,y:player.y,z:player.z,yaw:player.yaw,health:player.health}}));});
      connection.addEventListener("message",event=>{if(socket!==connection)return;let message;try{message=JSON.parse(event.data);}catch(error){return;}
        if(message.type==="welcome"){if(message.publicState&&activeWorld)activeWorld.publicState=message.publicState;updateRemotePlayers(message.players||[]);showToast("Connected to public island.");}
        else if(message.type==="players")updateRemotePlayers(message.players||[]);
        else if(message.type==="move"){const list=Array.from(remotePlayers.keys()).map(id=>{const a=remotePlayers.get(id);return {id,name:a.userData.playerName,x:a.position.x*SCALE_M,y:a.position.y*SCALE_M+1.72,z:a.position.z*SCALE_M,yaw:a.rotation.y};});const found=list.findIndex(p=>p.id===message.player.id);if(found>=0)list[found]=message.player;else list.push(message.player);updateRemotePlayers(list);}
        else if(message.type==="error"){showToast(message.message||"Could not join this island.");closeSocket();}
      });
      connection.addEventListener("close",event=>{if(socket!==connection)return;socket=null;updateRemotePlayers([]);if(worldRunning&&event.code!==1000)showToast("Multiplayer disconnected. Your local save is safe.");});
      connection.addEventListener("error",()=>{if(socket===connection)showToast("World server unavailable. Playing locally.");});
    }catch(error){showToast("Multiplayer could not connect. Playing locally.");}
  }
  function sendPlayerState(){if(!socket||socket.readyState!==WebSocket.OPEN||!player)return;socket.send(JSON.stringify({type:"move",player:{id:appData.playerId,name:"Explorer-"+String(appData.playerId).slice(0,4).toUpperCase(),x:player.x,y:player.y,z:player.z,yaw:player.yaw,health:player.health}}));}
  async function syncPublicWorld(){
    if(!activeWorld||!activeWorld.publicId||!activeWorld.ownerKey||!serverOnline||Date.now()-lastPublicSync<15000)return;
    lastPublicSync=Date.now();try{await api("/api/worlds/"+encodeURIComponent(activeWorld.publicId),{method:"PUT",headers:{"content-type":"application/json","x-owner-key":activeWorld.ownerKey},body:JSON.stringify({publicState:activeWorld.publicState||{}})});}catch(error){serverOnline=false;}
  }
  function drawMiniMap(){
    const canvas=$("#miniMap"),ctx=canvas.getContext("2d");ctx.clearRect(0,0,canvas.width,canvas.height);
    if(mapImage)ctx.drawImage(mapImage,0,0,canvas.width,canvas.height);else{ctx.fillStyle="#667c50";ctx.fillRect(0,0,canvas.width,canvas.height);}
    if(player){const p=mapCoords(player.x,player.z);ctx.beginPath();ctx.arc(p.u*canvas.width,p.v*canvas.height,5,0,Math.PI*2);ctx.fillStyle="#f07854";ctx.fill();ctx.lineWidth=2;ctx.strokeStyle="#fff2d5";ctx.stroke();}
  }
  async function loadInviteFromUrl(){
    const query=new URLSearchParams(location.search),publicId=query.get("world"),seedText=query.get("seed");
    if(publicId){
      try{
        const remote=await api("/api/worlds/"+encodeURIComponent(publicId),{method:"GET"});
        const local=appData.worlds.find(w=>w&&w.publicId===publicId)||appData.shared[publicId];
        const seed=Number(remote.seed)||Number(local&&local.seed)||1,world=local||{slot:null,name:remote.name||"Shared island",seed:seed,publicId:publicId,ownerKey:null,createdAt:remote.createdAt||Date.now(),publicState:remote.publicState||{removedTrees:[],minedStone:[],supportColumns:[],inventory:{}},player:Object.assign({},findSpawn(seed),{yaw:0,pitch:0,health:100,stamina:100})};
        world.publicId=publicId;world.name=remote.name||world.name;world.seed=seed;world.publicState=remote.publicState||world.publicState;appData.shared[publicId]=world;await saveLocal();enterWorldObject(world,false);
      }catch(error){openView("worldsView");showToast("This public world needs its world server online.");}
    }else if(seedText){
      const seed=Number(seedText)>>>0,name=query.get("name")||"Shared island";
      const world=appData.shared[String(seed)]||{slot:null,name:name,seed:seed,publicId:null,ownerKey:null,createdAt:Date.now(),publicState:{removedTrees:[],minedStone:[],supportColumns:[],inventory:{}},player:Object.assign({},findSpawn(seed),{yaw:0,pitch:0,health:100,stamina:100})};
      appData.shared[String(seed)]=world;await saveLocal();enterWorldObject(world,false);showToast("World seed loaded. Use the server to make it live multiplayer.");
    }
  }
  function rotateLook(dx,dy){if(!player)return;player.yaw-=dx*.0022;player.pitch=clamp(player.pitch-dy*.002,-1.42,1.42);}
  function setupControls(){
    document.addEventListener("keydown",event=>{
      if(event.code==="Escape"){event.preventDefault();if(worldRunning)openPause();else if(paused){if(!$("#settingsView").hidden)openView("pauseView");else resumeGame();}else if(!$("#settingsView").hidden)openView("homeView");return;}
      if(["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(event.code))event.preventDefault();
      if(event.code==="Space"&&!keyboard.Space&&player)player.jumpQueued=true;keyboard[event.code]=true;
    },{passive:false});
    document.addEventListener("keyup",event=>{keyboard[event.code]=false;});
    window.addEventListener("blur",()=>{Object.keys(keyboard).forEach(k=>keyboard[k]=false);touchMove.x=touchMove.y=0;});
    document.addEventListener("pointerlockchange",()=>{pointerIsLocked=document.pointerLockElement===renderer.domElement;if(!pointerIsLocked&&worldRunning)openPause();});
    document.addEventListener("mousemove",event=>{if(pointerIsLocked&&worldRunning)rotateLook(event.movementX,event.movementY);});
    renderer.domElement.addEventListener("click",()=>{if(worldRunning&&!isMobile()&&!pointerIsLocked&&renderer.domElement.requestPointerLock)renderer.domElement.requestPointerLock();});
    renderer.domElement.addEventListener("pointerdown",event=>{
      if(!worldRunning)return;mouseDown=true;
      if(isMobile()&&event.pointerType==="touch"&&event.clientX>innerWidth*.48){touchLook.id=event.pointerId;touchLook.x=event.clientX;touchLook.y=event.clientY;renderer.domElement.setPointerCapture(event.pointerId);}
      else if(!isMobile()&&!pointerIsLocked)renderer.domElement.setPointerCapture(event.pointerId);
    });
    renderer.domElement.addEventListener("pointermove",event=>{
      if(!worldRunning)return;
      if(touchLook.id===event.pointerId){rotateLook(event.clientX-touchLook.x,event.clientY-touchLook.y);touchLook.x=event.clientX;touchLook.y=event.clientY;}
      else if(mouseDown&&!pointerIsLocked&&!isMobile()&&event.pointerType==="mouse")rotateLook(event.movementX||0,event.movementY||0);
    });
    const endLook=event=>{mouseDown=false;if(touchLook.id===event.pointerId)touchLook.id=null;};
    renderer.domElement.addEventListener("pointerup",endLook);renderer.domElement.addEventListener("pointercancel",endLook);
    const base=$("#stickBase"),knob=$("#stickKnob");let stickId=null;
    const updateStick=event=>{const rect=base.getBoundingClientRect(),cx=rect.left+rect.width/2,cy=rect.top+rect.height/2,max=rect.width*.37;let x=(event.clientX-cx)/max,y=(event.clientY-cy)/max,len=Math.hypot(x,y);if(len>1){x/=len;y/=len;}touchMove.x=x;touchMove.y=y;knob.style.left=(50+x*37)+"%";knob.style.top=(50+y*37)+"%";};
    base.addEventListener("pointerdown",event=>{stickId=event.pointerId;base.setPointerCapture(stickId);updateStick(event);event.preventDefault();});
    base.addEventListener("pointermove",event=>{if(stickId===event.pointerId)updateStick(event);});
    const resetStick=event=>{if(stickId===event.pointerId){stickId=null;touchMove.x=touchMove.y=0;knob.style.left="50%";knob.style.top="50%";}};
    base.addEventListener("pointerup",resetStick);base.addEventListener("pointercancel",resetStick);
    $("#jumpButton").addEventListener("pointerdown",event=>{event.preventDefault();if(player)player.jumpQueued=true;});
  }
  function setupMenu(){
    $("#startButton").addEventListener("click",()=>{renderWorldSlots();openView("worldsView");});
    $("#settingsButton").addEventListener("click",()=>openSettings("homeView"));
    $("#pauseSettingsButton").addEventListener("click",()=>openSettings("pauseView"));
    $("#settingsBack").addEventListener("click",()=>openView(settingsReturn));
    $("#resumeButton").addEventListener("click",resumeGame);
    $("#saveExitButton").addEventListener("click",saveAndReturn);
    $("#quitButton").addEventListener("click",quitGame);
    $("#exportSaveButton").addEventListener("click",async()=>{await saveLocal();const blob=new Blob([JSON.stringify(appData,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download="islad-save.json";link.click();URL.revokeObjectURL(url);showToast("Local save file downloaded.");});
    document.querySelectorAll("[data-back]").forEach(button=>button.addEventListener("click",()=>openView(button.dataset.back)));
    $("#joinLinkButton").addEventListener("click",joinFromInput);
    $("#joinLinkInput").addEventListener("keydown",event=>{if(event.key==="Enter")joinFromInput();});
    $("#cancelDelete").addEventListener("click",()=>{$("#confirmDialog").hidden=true;deleteSlot=-1;});
    $("#confirmDelete").addEventListener("click",deleteWorld);
    $("#brightnessRange").addEventListener("input",event=>{appData.settings.brightness=Number(event.target.value);$("#brightnessValue").value=event.target.value+"%";smoothSetting();saveLocal();});
    $("#renderRange").addEventListener("input",event=>{appData.settings.renderDistance=Number(event.target.value);$("#renderValue").value=Number(event.target.value).toLocaleString()+" m";smoothSetting();refreshChunkSet(true);saveLocal();});
    $("#sfxToggle").addEventListener("change",event=>{appData.settings.sfx=event.target.checked;event.target.nextElementSibling.nextElementSibling.value=event.target.checked?"ON":"OFF";saveLocal();});
    $("#mobileCapToggle").addEventListener("change",event=>{appData.settings.mobileCap=event.target.checked;event.target.nextElementSibling.nextElementSibling.value=event.target.checked?"AUTO":"OFF";smoothSetting();refreshChunkSet(true);saveLocal();});
    window.addEventListener("resize",()=>{if(!renderer)return;camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();smoothSetting();});
    window.addEventListener("pagehide",()=>saveLocal());
    document.addEventListener("visibilitychange",()=>{if(document.hidden){saveLocal();if(worldRunning)openPause();}});
  }
  function updateGame(dt){
    if(!worldRunning||!player||!activeWorld)return;
    const floor=heightAt(player.x,player.z,activeWorld.seed),onGround=floor!==null&&player.y<=floor+1.75&&player.vy<=0;
    player.grounded=onGround;
    let forward=(keyboard.KeyW||keyboard.ArrowUp?1:0)-(keyboard.KeyS||keyboard.ArrowDown?1:0),side=(keyboard.KeyD||keyboard.ArrowRight?1:0)-(keyboard.KeyA||keyboard.ArrowLeft?1:0);
    if(isMobile()){side+=touchMove.x;forward-=touchMove.y;}
    const len=Math.hypot(forward,side);if(len>1){forward/=len;side/=len;}
    const sin=Math.sin(player.yaw),cos=Math.cos(player.yaw),wishX=forward*sin+side*cos,wishZ=-forward*cos+side*sin;
    const sprint=(keyboard.ShiftLeft||keyboard.ShiftRight)&&len>.1&&player.stamina>1;
    const speed=sprint?9.2:4.8,accel=player.grounded?15:4.6;
    player.vx+=clamp(wishX*speed-player.vx,-accel*dt,accel*dt);player.vz+=clamp(wishZ*speed-player.vz,-accel*dt,accel*dt);
    if(len<.08){const drag=player.grounded?10:1.2;player.vx*=Math.max(0,1-drag*dt);player.vz*=Math.max(0,1-drag*dt);}
    if(sprint)player.stamina=Math.max(0,player.stamina-19*dt);else player.stamina=Math.min(100,player.stamina+12*dt);
    const wasGrounded=player.grounded;
    if(player.jumpQueued&&player.grounded){player.vy=6.3;player.grounded=false;player.stamina=Math.max(0,player.stamina-5);playSfx("jump");}
    player.jumpQueued=false;player.vy-=19.5*dt;
    const nextX=player.x+player.vx*dt,nextZ=player.z+player.vz*dt,nextFloor=heightAt(nextX,nextZ,activeWorld.seed);
    player.x=clamp(nextX,-HALF_M,HALF_M);player.z=clamp(nextZ,-HALF_M,HALF_M);player.y+=player.vy*dt;
    if(nextFloor!==null&&player.y<=nextFloor+1.72){
      if(!wasGrounded&&player.vy<-12){const damage=Math.min(68,(Math.abs(player.vy)-12)*3.4);player.health=Math.max(0,player.health-damage);playSfx("hurt");showToast("Hard landing · "+Math.ceil(damage)+" health lost.");}
      player.y=nextFloor+1.72;player.vy=0;player.grounded=true;
    }else player.grounded=false;
    if(player.y<OCEAN_FLOOR_M+15){player.health=Math.max(0,player.health-20);player.x=player.spawnX;player.z=player.spawnZ;player.y=(heightAt(player.x,player.z,activeWorld.seed)||0)+1.72;player.vx=player.vy=player.vz=0;showToast("You fell beyond the island. Returned to your starting shore.");}
    if(player.health<=0){player.health=100;player.x=player.spawnX;player.z=player.spawnZ;player.y=(heightAt(player.x,player.z,activeWorld.seed)||0)+1.72;player.vx=player.vy=player.vz=0;showToast("You recovered at your starting shore.");}
    const moving=Math.hypot(player.vx,player.vz)>.7&&player.grounded;
    if(moving){footstepClock-=dt;if(footstepClock<=0){playSfx("step");footstepClock=sprint ? .31 : .52;}}
    else footstepClock=0;
    const bob=moving?Math.sin(performance.now()*.012)*(sprint?.0011:.00065):0;
    camera.position.set(player.x/SCALE_M,(player.y/SCALE_M)+bob,player.z/SCALE_M);camera.rotation.set(player.pitch,player.yaw,0,"YXZ");
    const groundHeight=heightAt(player.x,player.z,activeWorld.seed);$("#heightReadout").textContent=Math.max(0,Math.round(groundHeight||0)).toLocaleString()+" m";
    $("#healthBar").style.width=player.health+"%";$("#staminaBar").style.width=player.stamina+"%";
    saveClock+=dt;netClock+=dt;
    if(saveClock>4){saveClock=0;saveLocal();syncPublicWorld();drawMiniMap();}
    if(netClock>.1){netClock=0;sendPlayerState();}
    if(performance.now()-lastChunkUpdate>600){lastChunkUpdate=performance.now();refreshChunkSet(false);}
  }
  function animate(now){
    requestAnimationFrame(animate);const dt=Math.min(.04,Math.max(0,(now-(animate.last||now))/1000));animate.last=now;
    updateGame(dt);pumpChunkQueue();
    if(!worldRunning&&previewPos&&camera){const t=now*.000035;camera.position.x=previewPos.x/SCALE_M+Math.sin(t)*.035;camera.position.y=(previewPos.y+1450)/SCALE_M;camera.position.z=previewPos.z/SCALE_M-.4;camera.lookAt(previewPos.x/SCALE_M,(previewPos.y+180)/SCALE_M,previewPos.z/SCALE_M);}
    renderer.render(scene,camera);
  }
  async function bootstrap(){
    const stored=readLocalStorage()||await readPrivateSave();appData=normalizeData(stored);applySettingsToInputs();
    await loadMap();
    if(!window.THREE){showError("Three.js did not load. Connect to the internet and reload to play.");$("#startButton").disabled=true;$("#startButton").textContent="3D engine unavailable";return;}
    try{
      scene=new THREE.Scene();scene.background=new THREE.Color(0x9ead9f);scene.fog=new THREE.Fog(0x9ead9f,4,16);
      camera=new THREE.PerspectiveCamera(74,innerWidth/innerHeight,.001,30);camera.rotation.order="YXZ";
      renderer=new THREE.WebGLRenderer({antialias:!isMobile(),alpha:false,powerPreference:"high-performance"});renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.shadowMap.enabled=false;
      $("#scene").appendChild(renderer.domElement);
      scene.add(new THREE.HemisphereLight(0xe6f0dc,0x465446,1.55));const sunlight=new THREE.DirectionalLight(0xffe8bf,2.15);sunlight.position.set(-70,100,-35);scene.add(sunlight);
      terrainMaterial=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.98,metalness:0,side:THREE.DoubleSide});
      smoothSetting();
      previewWorld={seed:20251026,name:"Preview island"};previewPos=findScenicPosition(previewWorld.seed);camera.position.set(previewPos.x/SCALE_M,(previewPos.y+1450)/SCALE_M,previewPos.z/SCALE_M-.4);camera.lookAt(previewPos.x/SCALE_M,(previewPos.y+180)/SCALE_M,previewPos.z/SCALE_M);
      refreshChunkSet(true);setupControls();setupMenu();renderWorldSlots();drawMiniMap();await checkWorldServer();requestAnimationFrame(animate);
      await loadInviteFromUrl();
    }catch(error){console.error(error);showError("3D world could not start: "+(error&&error.message||"unknown error"));}
  }
  bootstrap();
})();










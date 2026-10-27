"use strict";
const http=require("node:http");
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const {WebSocketServer,WebSocket}=require("ws");
const ROOT=__dirname;
const DATA_DIR=process.env.WORLD_DATA_DIR||path.join(ROOT,"data");
const STORE_FILE=path.join(DATA_DIR,"worlds.json");
const PORT=Number(process.env.PORT)||8080;
const MAX_WORLD_BYTES=500000;
let worlds=Object.create(null);
const rooms=new Map();

function loadStore(){try{fs.mkdirSync(DATA_DIR,{recursive:true});const saved=JSON.parse(fs.readFileSync(STORE_FILE,"utf8"));if(saved&&typeof saved==="object")worlds=saved;}catch(error){if(error.code!=="ENOENT")console.warn("World store could not be read:",error.message);}}
function persistStore(){fs.mkdirSync(DATA_DIR,{recursive:true});const temp=STORE_FILE+".tmp";fs.writeFileSync(temp,JSON.stringify(worlds,null,2));fs.renameSync(temp,STORE_FILE);}
function json(res,status,value){const body=JSON.stringify(value);res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","content-length":Buffer.byteLength(body)});res.end(body);}
function readBody(req,max=MAX_WORLD_BYTES){return new Promise((resolve,reject)=>{let body="";req.on("data",chunk=>{body+=chunk;if(Buffer.byteLength(body)>max){reject(new Error("Request body is too large."));req.destroy();}});req.on("end",()=>{try{resolve(body?JSON.parse(body):{});}catch(error){reject(new Error("Invalid JSON body."));}});req.on("error",reject);});}
function cleanName(value){const name=String(value||"Island").replace(/[<>\u0000-\u001f]/g,"").trim().slice(0,40);return name||"Island";}
function cleanPublicState(value){const input=value&&typeof value==="object"?value:{};return {removedTrees:Array.isArray(input.removedTrees)?input.removedTrees.slice(0,10000):[],minedStone:Array.isArray(input.minedStone)?input.minedStone.slice(0,10000):[],supportColumns:Array.isArray(input.supportColumns)?input.supportColumns.slice(0,2000):[],inventory:input.inventory&&typeof input.inventory==="object"?input.inventory:{}};}
function safeEqual(a,b){if(typeof a!=="string"||typeof b!=="string")return false;const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);}
function publicWorld(world){return {id:world.id,name:world.name,seed:world.seed,createdAt:world.createdAt,updatedAt:world.updatedAt,publicState:world.publicState};}
function roomPlayers(id){const room=rooms.get(id);return room?Array.from(room.values()).map(session=>session.player):[];}
function send(ws,value){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(value));}
function broadcastPlayers(id){const room=rooms.get(id);if(!room)return;const players=roomPlayers(id);for(const session of room.values())send(session.ws,{type:"players",players});}
function broadcastMove(id,exceptId,player){const room=rooms.get(id);if(!room)return;for(const [playerId,session] of room)if(playerId!==exceptId)send(session.ws,{type:"move",player});}
function rejectUpgrade(socket,status,message){socket.write("HTTP/1.1 "+status+"\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n"+message);socket.destroy();}
function receivePlayer(session,raw){const p=raw&&typeof raw==="object"?raw:{};const finite=(v,lo,hi,fallback)=>Number.isFinite(Number(v))?Math.max(lo,Math.min(hi,Number(v))):fallback;return {id:session.id,name:cleanName(p.name||session.name),x:finite(p.x,-223500,223500,0),y:finite(p.y,-1200,6500,0),z:finite(p.z,-223500,223500,0),yaw:finite(p.yaw,-100000,100000,0),health:finite(p.health,0,100,100)};}

loadStore();
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,"http://localhost");
  if(url.pathname==="/api/health"&&req.method==="GET")return json(res,200,{ok:true,players:Array.from(rooms.values()).reduce((sum,r)=>sum+r.size,0)});
  const worldRoute=url.pathname.match(/^\/api\/worlds\/([a-f0-9]{32})$/i);
  if(url.pathname==="/api/worlds"&&req.method==="POST"){
    try{const body=await readBody(req);const id=crypto.randomBytes(16).toString("hex"),ownerKey=crypto.randomBytes(24).toString("hex"),now=Date.now();const seed=(Number(body.seed)>>>0)||1;
      worlds[id]={id,ownerKey,name:cleanName(body.name),seed,createdAt:now,updatedAt:now,publicState:cleanPublicState(body.publicState)};persistStore();return json(res,201,{id,ownerKey,name:worlds[id].name,createdAt:now});
    }catch(error){return json(res,400,{error:error.message||"Could not create world."});}
  }
  if(worldRoute&&req.method==="GET"){
    const world=worlds[worldRoute[1]];return world?json(res,200,publicWorld(world)):json(res,404,{error:"World link not found."});
  }
  if(worldRoute&&req.method==="PUT"){
    const world=worlds[worldRoute[1]];if(!world)return json(res,404,{error:"World link not found."});
    if(!safeEqual(req.headers["x-owner-key"],world.ownerKey))return json(res,403,{error:"Only the world owner can update its public save."});
    try{const body=await readBody(req);world.publicState=cleanPublicState(body.publicState);world.updatedAt=Date.now();persistStore();return json(res,200,{ok:true,updatedAt:world.updatedAt});}catch(error){return json(res,400,{error:error.message||"Could not save world."});}
  }
  if(worldRoute&&req.method==="DELETE"){
    const world=worlds[worldRoute[1]];if(!world)return json(res,404,{error:"World link not found."});
    if(!safeEqual(req.headers["x-owner-key"],world.ownerKey))return json(res,403,{error:"Only the world owner can delete its public save."});
    delete worlds[worldRoute[1]];persistStore();const room=rooms.get(worldRoute[1]);if(room){for(const session of room.values()){send(session.ws,{type:"error",message:"The world owner deleted this island."});session.ws.close(4004,"world deleted");}rooms.delete(worldRoute[1]);}
    return json(res,200,{ok:true});
  }
  if(url.pathname.startsWith("/api/"))return json(res,404,{error:"API endpoint not found."});
  if(req.method!=="GET"&&req.method!=="HEAD"){res.writeHead(405,{allow:"GET, HEAD"});return res.end("Method not allowed");}
  let pathname;try{pathname=decodeURIComponent(url.pathname);}catch(error){res.writeHead(400);return res.end("Bad request");}
  if(pathname==="/")pathname="/index.html";
  const file=path.resolve(ROOT,"."+pathname);
  if(file!==ROOT&&!file.startsWith(ROOT+path.sep)){res.writeHead(403);return res.end("Forbidden");}
  const relative=path.relative(ROOT,file).split(path.sep);
  if(relative.includes(".git")||relative.includes("node_modules")||relative.includes("data")){res.writeHead(404);return res.end("Not found");}
  fs.stat(file,(error,stat)=>{
    if(error||!stat.isFile()){res.writeHead(404,{"content-type":"text/plain; charset=utf-8"});return res.end("Not found");}
    const ext=path.extname(file).toLowerCase(),types={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".jfif":"image/jpeg",".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".svg":"image/svg+xml",".json":"application/json; charset=utf-8"};
    res.writeHead(200,{"content-type":types[ext]||"application/octet-stream","cache-control":ext===".html"?"no-cache":"public, max-age=3600","content-length":stat.size});
    if(req.method==="HEAD")return res.end();fs.createReadStream(file).pipe(res);
  });
});
const wss=new WebSocketServer({noServer:true,maxPayload:64*1024});
server.on("upgrade",(req,socket,head)=>{
  let url;try{url=new URL(req.url,"http://localhost");}catch(error){return rejectUpgrade(socket,400,"Bad request");}
  if(url.pathname!=="/ws")return rejectUpgrade(socket,404,"WebSocket endpoint not found");
  const worldId=url.searchParams.get("world"),world=worlds[worldId];if(!world)return rejectUpgrade(socket,404,"Public world not found");
  let room=rooms.get(worldId);if(!room){room=new Map();rooms.set(worldId,room);}
  const playerId=String(url.searchParams.get("player")||crypto.randomBytes(8).toString("hex")).slice(0,64);
  const prior=room.get(playerId);if(prior){prior.ws.close(4001,"reconnected");room.delete(playerId);}
  if(room.size>=4)return rejectUpgrade(socket,429,"This world already has four players.");
  wss.handleUpgrade(req,socket,head,ws=>{
    const session={id:playerId,name:cleanName(url.searchParams.get("name")||"Explorer"),worldId,ws,lastMove:0,player:null};
    session.player={id:playerId,name:session.name,x:0,y:0,z:0,yaw:0,health:100};room.set(playerId,session);
    send(ws,{type:"welcome",players:roomPlayers(worldId),publicState:world.publicState,world:{id:world.id,name:world.name,seed:world.seed}});
    broadcastPlayers(worldId);
    ws.on("message",raw=>{
      let message;try{message=JSON.parse(raw.toString());}catch(error){return;}
      if(message.type==="hello"){session.player=receivePlayer(session,message.player);session.name=session.player.name;broadcastPlayers(worldId);return;}
      if(message.type==="move"){
        const now=Date.now();if(now-session.lastMove<30)return;session.lastMove=now;session.player=receivePlayer(session,message.player);broadcastMove(worldId,playerId,session.player);
      }
    });
    ws.on("close",()=>{const current=rooms.get(worldId);if(!current||current.get(playerId)!==session)return;current.delete(playerId);if(current.size===0)rooms.delete(worldId);else broadcastPlayers(worldId);});
    ws.on("error",()=>{});
  });
});
server.listen(PORT,"0.0.0.0",()=>console.log("ISLAD server listening on port "+PORT+"; public worlds stored in "+DATA_DIR));



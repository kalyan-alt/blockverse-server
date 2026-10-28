// Blockverse service worker v22: network-first for the page; also nukes any old caches so stale copies can't stick.
const CACHE='blockverse-v41';
self.addEventListener('install',e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.map(k=>caches.delete(k)))).then(()=>self.skipWaiting())); });
self.addEventListener('activate',e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()).then(()=>self.clients.matchAll({type:'window'})).then(cs=>cs.forEach(c=>c.navigate(c.url)))); });
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.mode==='navigate'||req.url.endsWith('.html')||req.url.endsWith('/')){
    e.respondWith(fetch(req,{cache:'no-store'}).then(res=>{ caches.open(CACHE).then(c=>c.put(req,res.clone())); return res; }).catch(()=>caches.match(req).then(r=>r||caches.match('./index.html'))));
  } else {
    e.respondWith(caches.match(req).then(r=>r||fetch(req).then(res=>{ caches.open(CACHE).then(c=>c.put(req,res.clone())); return res; })));
  }
});

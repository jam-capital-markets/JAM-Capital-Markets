// JAM Capital Markets: read-only data layer for the public site.
// The page was written against a claude.ai database; this serves the same calls from static JSON
// files in ./data, and answers every other capability (connectors, Ask, sign-in) as unavailable.
(function(){
  const cache={};
  const load=n=>cache[n]||(cache[n]=fetch('data/'+n+'.json',{cache:'no-cache'}).then(r=>{ if(!r.ok) throw {code:'not_found'}; return r.json(); }));
  const deny=()=>Promise.reject({code:'not_granted'});
  const snap=o=>({docs:Object.entries(o||{}).map(([id,d])=>({id,exists:true,data:()=>d}))});
  const docRef=(c,id)=>({
    get:async()=>{ const o=await load(c).catch(()=>({})); return {id,exists:Object.prototype.hasOwnProperty.call(o,id),data:()=>o[id]}; },
    onSnapshot:(fn)=>{ load(c).then(o=>fn({id,exists:id in o,data:()=>o[id]})).catch(()=>{}); return ()=>{}; },
    set:deny, update:deny, delete:deny, acquire:deny
  });
  const empty={get:async()=>({exists:false,data:()=>null}),onSnapshot:()=>()=>{},set:deny,update:deny,delete:deny,acquire:deny};
  const known=['ds','cm','weekly','daily'];
  const DB={
    collection:n=>({ get:async()=>snap(await load(n)), onSnapshot:(fn)=>{ load(n).then(o=>fn(snap(o))).catch(()=>{}); return ()=>{}; }, doc:id=>docRef(n,id) }),
    doc:p=>{ const i=p.indexOf('/'), c=p.slice(0,i), id=p.slice(i+1); return known.includes(c)?docRef(c,id):empty; }
  };
  window.jamData={use:async n=>n==='db'?DB:null};
})();

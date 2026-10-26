'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const script=fs.readFileSync(path.join(__dirname,'../../../htdocs/lib/AleScanner.js'),'utf8');
const storage=new Map(),timers=new Set(),sent=[],listeners=new Set();
let mode='ale2g',source='sdr',frequency=7102000,nextTimer=0,denyStorage=false,autoStop=false;
const state={available:true,source_id:'sdr',session:'scan-one',running:true,status:'Scanning',frequency,sequence:0,events:[]};
const socket={readyState:1,addEventListener:(type,fn)=>listeners.add(fn),removeEventListener:(type,fn)=>listeners.delete(fn),
    send(text){
        const packet=JSON.parse(text);sent.push(packet);
        if(autoStop&&packet.params.action==='stop')for(const fn of [...listeners])
            fn({data:JSON.stringify({type:'ale_scan_state',value:{...state,running:false}})});
    }};
const context=vm.createContext({console,performance:{now:()=>0},ws:socket,center_freq:7100000,bandwidth:200000,
    $:()=>({val:()=>source+'|hf'}),setTimeout,clearTimeout,
    setInterval:()=>{const id=++nextTimer;timers.add(id);return id;},clearInterval:id=>timers.delete(id),
    sessionStorage:{getItem:k=>{if(denyStorage)throw Error('storage denied');return storage.get(k)||null;},
        setItem:(k,v)=>{if(denyStorage)throw Error('storage denied');storage.set(k,v);},removeItem:k=>storage.delete(k)},
    UI:{getModulation:()=>mode,setModulation:m=>{mode=m;},getDemodulator:()=>({}),
        getDemodulatorPanel:()=>({center_freq:7100000,centerFreqTimeout:false,getMagicKey:()=>null}),
        setFrequency:f=>{frequency=f;}}});
vm.runInContext(script,context);
const Client=vm.runInContext('AleServerScanClient',context);
const receive=(client,value=state)=>client.receive({data:JSON.stringify({type:'ale_scan_state',value})});
let checks=0;
(async()=>{
    const first=new Client(()=>{},()=>{});receive(first);
    assert.equal(storage.get('owrx_ale_observer_v1:sdr'),'scan-one');checks++;
    first.destroy();assert(!sent.some(p=>p.params.action==='stop'));checks++;
    // Safari can discard the document and return with the profile's AM mode.
    mode='am';const returned=new Client(()=>{},()=>{});receive(returned);
    assert.equal(mode,'ale2g');assert.equal(frequency,7102000);checks++;
    assert(!sent.some(p=>p.type==='setfrequency'||p.params.action==='start'));checks++;
    returned.resume();returned.resume();assert.equal(timers.size,1);checks++;
    autoStop=true;await returned.takeControl();
    assert(!storage.has('owrx_ale_observer_v1:sdr'));assert.equal(returned.manualTakeover,true);checks++;
    returned.destroy();autoStop=false;mode='am';
    const manual=new Client(()=>{},()=>{});receive(manual);
    assert.equal(mode,'am','Manual takeover must survive a new observer');checks++;
    manual.destroy();
    source='other';storage.set('owrx_ale_observer_v1:sdr','scan-one');mode='am';
    const other=new Client(()=>{},()=>{});other.pending=true;receive(other);
    assert.equal(other.pending,true,'Stale replies from another SDR cannot acknowledge current control');checks++;
    receive(other,{...state,source_id:'other'});assert.equal(mode,'am');checks++;
    other.destroy();source='sdr';
    const restarted=new Client(()=>{},()=>{});receive(restarted,{...state,session:'scan-two'});
    assert.equal(mode,'am','An unrelated restarted scan is not followed automatically');checks++;
    receive(restarted,{...state,running:false});assert(!storage.has('owrx_ale_observer_v1:sdr'));checks++;
    restarted.destroy();
    storage.set('owrx_ale_observer_v1:sdr','scan-one');mode='am';
    const stopping=new Client(()=>{},()=>{});receive(stopping,{...state,stopping:true});
    assert.equal(mode,'am');assert(!storage.has('owrx_ale_observer_v1:sdr'));checks++;
    stopping.destroy();
    mode='am';const starting=new Client(()=>{},()=>{});
    starting.start({bank:'hfn_us_hf',channels:[7102000],dwell:10,across:false});
    receive(starting,{...state,running:false}); // A status reply sent before Start.
    assert.equal(starting.pending,true);assert.equal(starting.following,true);
    receive(starting);assert.equal(mode,'ale2g');assert.equal(starting.pending,false);checks++;
    starting.stop();receive(starting); // An active reply already queued before Stop.
    assert(!storage.has('owrx_ale_observer_v1:sdr'));checks++;
    starting.destroy();
    denyStorage=true;mode='ale2g';const blocked=new Client(()=>{},()=>{});receive(blocked);
    assert.equal(blocked.running,true);assert.equal(mode,'ale2g');checks++;
    blocked.destroy();assert.equal(timers.size,0);checks++;
    console.log(checks+' server observer reload, session, receiver and manual-control checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

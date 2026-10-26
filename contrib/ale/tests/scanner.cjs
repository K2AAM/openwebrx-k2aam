const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const path = require('node:path');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../htdocs/lib/AleScanner.js'), 'utf8'), ctx);
const Controller = vm.runInContext('AleScanController', ctx);
const banks = JSON.parse(JSON.stringify(vm.runInContext('ALE_SCAN_BANKS', ctx)));
const catalog = require('../channels.json');
assert.deepEqual(banks.map(b=>b.channels),catalog.banks.map(b=>b.channels.map(c=>c.frequency_hz)));
let checks = 1;
function fixture() {
    let now = 0;
    const state = {connected:true, mode:'ale2g', frequency:7102000, center:7100000, profile:'40m', socket:{}, hidden:false};
    const calls = [], statuses = [];
    const api = {now:()=>now, snapshot:()=>({...state}), status:s=>statuses.push(s),
        fits:f=>f>=7000000&&f+2800<7200000, stopNativeScanner:()=>{},
        tune:async(f,shared)=>{calls.push([f,shared]);state.frequency=f;}};
    const scan = new Controller(api);
    return {scan,state,calls,api,statuses,advance:n=>{now+=n;scan.tick();},flush:()=>new Promise(setImmediate)};
}
(async()=>{
    let f=fixture();await f.scan.start([7102000,14109000,7110000],{dwell:10,shared:false});
    assert.equal(f.scan.channels.length,2);assert.equal(f.calls.length,1);checks++;
    f.advance(9999);assert.equal(f.calls.length,1);f.advance(1);await f.flush();assert.equal(f.calls[1][0],7110000);checks++;
    f.scan.event({freq:7110000,event:'activity',active:true});f.advance(20000);assert.equal(f.calls.length,2);checks++;
    f.scan.event({freq:7110000,event:'activity',active:false});f.advance(2999);assert.equal(f.calls.length,2);
    f.advance(1);await f.flush();assert.equal(f.calls.length,3);checks++;
    f.scan.event({freq:999,event:'activity',active:true});assert.equal(f.scan.holdStart,null);checks++;
    f.scan.event({freq:7102000,event:'amd'});f.advance(2999);assert.equal(f.calls.length,3);
    f.advance(1);await f.flush();assert.equal(f.calls.length,4);checks++;
    f.scan.event({freq:7110000,event:'activity',active:true});f.advance(120000);await f.flush();assert.equal(f.calls.length,5);checks++;
    for(const change of [{connected:false},{mode:'usb'},{frequency:7103000},{profile:'20m'},{center:7200000},{hidden:true},{socket:{}},{nativeScanner:true}]) {
        f=fixture();await f.scan.start([7102000,7110000],{dwell:10,shared:false});Object.assign(f.state,change);
        f.advance(1);assert.equal(f.scan.running,false);assert.equal(f.calls.length,1);checks++;
    }
    f=fixture();await f.scan.start([7102000],{dwell:10,shared:false});f.scan.event({test_audio:true,freq:7102000,event:'amd'});
    assert.equal(f.scan.running,false);checks++;
    f=fixture();await assert.rejects(f.scan.start([14109000],{dwell:10,shared:false}));assert.equal(f.calls.length,0);checks++;
    await assert.rejects(f.scan.start([7102000],{dwell:0,shared:false}));checks++;
    f=fixture();await f.scan.start([14109000],{dwell:10,shared:true});assert.deepEqual(f.calls,[[14109000,true]]);checks++;
    f=fixture();f.api.tune=async()=>{throw new Error('Permission denied');};await f.scan.start([14109000],{dwell:10,shared:true});
    assert.equal(f.scan.running,false);assert.equal(f.statuses.at(-1),'Permission denied');checks++;
    f=fixture();let finish;f.api.tune=()=>new Promise(resolve=>{finish=resolve;});
    const pending=f.scan.start([7102000],{dwell:10,shared:false});f.scan.stop();finish();await pending;
    assert.equal(f.scan.running,false);assert.equal(f.scan.deadline,undefined);checks++;
    console.log(`${checks} ALE scanner/catalog checks passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});

(async()=>{
    let poll, now=0, frequency=7102000, mode='ale2g', cancelled;
    const sent=[], listeners=new Set();
    const sock={readyState:1,send:s=>sent.push(JSON.parse(s)),addEventListener:(n,f)=>listeners.add(f),removeEventListener:(n,f)=>listeners.delete(f)};
    const panel={center_freq:7100000,centerFreqTimeout:false,getMagicKey:()=> 'test-key'};
    const native=vm.createContext({performance:{now:()=>now},document:{hidden:false},
        center_freq:7100000,bandwidth:200000,ws:sock,$:()=>({val:()=> 'sdr|40m'}),
        setInterval:f=>{poll=f;return 1;},clearInterval:()=>{},
        UI:{getDemodulator:()=>({}),getFrequency:()=>frequency,getModulation:()=>mode,
            toggleScanner:()=>{},getDemodulatorPanel:()=>panel,
            setFrequency:f=>{frequency=f;return true;},setModulation:m=>{mode=m;}}});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../../../htdocs/lib/AleScanner.js'),'utf8'),native);
    const api=vm.runInContext('aleNativeScanApi(()=>{})',native);
    assert.equal(api.fits(7199000),false); // center fits, but USB passband would not
    await api.tune(7102000,false,()=>true,f=>{cancelled=f;});assert.equal(sent.length,0);
    await assert.rejects(api.tune(14109000,false,()=>true,()=>{}));assert.equal(sent.length,0);
    let pending=api.tune(14109000,true,()=>true,f=>{cancelled=f;});
    assert.equal(sent[0].params.key,'test-key');
    for(const receive of [...listeners])receive({data:JSON.stringify({type:'config',value:{allow_center_freq_changes:false}})});
    await assert.rejects(pending);assert.equal(listeners.size,0);
    pending=api.tune(14109000,true,()=>true,f=>{cancelled=f;});
    native.center_freq=14109000;panel.center_freq=14109000;frequency=14109000;mode='nfm';
    for(const receive of [...listeners])receive({data:JSON.stringify({type:'config',value:{center_freq:14109000}})});
    poll();await pending;assert.equal(mode,'ale2g');assert.equal(frequency,14109000);assert.equal(listeners.size,0);
    pending=api.tune(5250000,true,()=>true,f=>{cancelled=f;});cancelled();await assert.rejects(pending);
    pending=api.tune(5250000,true,()=>true,f=>{cancelled=f;});now=11000;poll();await assert.rejects(pending);
    console.log('8 native ALE tuning/permission/cancellation checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

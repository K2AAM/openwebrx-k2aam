'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const source=fs.readFileSync(path.join(__dirname,'../../../../htdocs/plugins/receiver/rig_audio/rnnoise-sync.js'));
const sha=crypto.createHash('sha1').update('blob '+source.length+'\0').update(source).digest('hex');
assert.equal(sha,'d054e0640b918141ee80f7b6e2eb5bcac9fe38a4','Pinned upstream RNNoise artifact must remain byte-for-byte intact');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'rig-rnnoise-'));
(async()=>{
    try {
        const file=path.join(temporary,'rnnoise.mjs');fs.writeFileSync(file,source);
        const {default:factory}=await import(pathToFileURL(file).href);
        const module=await factory(),state=module._rnnoise_create();
        const input=module._malloc(480*4),output=module._malloc(480*4);
        assert(state&&input&&output);
        for(let frame=0;frame<100;frame++) {
            for(let i=0;i<480;i++)module.HEAPF32[input/4+i]=1000*Math.sin((frame*480+i)*.13);
            assert(Number.isFinite(module._rnnoise_process_frame(state,output,input)));
            assert(module.HEAPF32.subarray(output/4,output/4+480).every(Number.isFinite));
        }
        module._rnnoise_destroy(state);module._free(input);module._free(output);
        console.log('Pinned RNNoise WASM processed 100 real 480-sample frames');
    } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1;});

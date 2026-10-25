const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const useWebKit=process.argv.includes('--webkit');
const root=path.resolve(__dirname,'../..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
let html=read('htdocs/index.html');
html=html.replace(/<script[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,'').replace('onload="openwebrx_init();"','');
html=html.replace('${header}','<header style="display:flex;justify-content:space-between;padding:18px 24px;background:#0b1728;color:#e7eff9;font:16px system-ui"><b>OpenWebRX+ <span style="color:#75d8f1">K2AAM</span></b><span style="font-size:11px;color:#a6bacf">Preview · simulated receiver</span></header>');
html=html.replace('</header>','<button data-toggle-panel="openwebrx-panel-log" onclick="toggle_panel(\'openwebrx-panel-log\',true)">Chat</button></header>');
const scripts=['htdocs/lib/jquery-3.7.1.min.js','htdocs/lib/jquery.nanoscroller.min.js','htdocs/lib/Plugins.js','htdocs/lib/lame.min.js','htdocs/lib/AudioEngine.js','test/browser/fixture.js','htdocs/lib/Utils.js','htdocs/lib/UI.js','htdocs/lib/Modes.js','htdocs/lib/Waterfall.js','htdocs/lib/MessagePanel.js','htdocs/lib/Js8Threads.js','htdocs/lib/MetaPanel.js','htdocs/lib/DemodulatorPanel.js'];
const core=read('htdocs/openwebrx.js');
const nativeFunctions=['resize_scale','openwebrx_resize','panel_displayed','toggle_panel','first_show_panel','initPanels',...Array.from(core.matchAll(/^function (secondary_demod_\w+)\(/gm),match=>match[1])];
const resizeFunctions=nativeFunctions.map(name=>core.match(new RegExp('function '+name+'\\([^\\n]*\\)\\s*\\{[\\s\\S]*?\\n\\}'))[0]).join('\n');
html=html.replace('</head>','<link rel="stylesheet" href="/htdocs/lib/nanoscroller.css"><link rel="stylesheet" href="/htdocs/css/openwebrx.css">'+scripts.map(p=>`<script src="/${p}"></script>`).join('')+'<style>#webrx-canvas-container{display:none}#fixture-waterfall{position:absolute;inset:0;width:100%;height:100%}#webrx-canvas-background{position:relative;overflow:hidden}#openwebrx-frequency-container{background:#13273c;color:white}#openwebrx-scale-container:before{content:"7.000                 7.050                   7.100                  7.150                   7.200 MHz";display:block;white-space:pre;text-align:center;padding-top:14px;color:#9ab1c9;font:12px monospace}body{background:#081423}</style></head>');
html=html.replace('</body>',`<script>${resizeFunctions}\nsetupFixture();</script><script src="/htdocs/plugins.js"></script></body>`);
const routes={};
const server=http.createServer((req,res)=>{
    const url=req.url.split('?')[0];let data,type;
    if(url==='/'){data=html;type='text/html';}
    else if(url==='/static/plugins/receiver/init.js'){
        const studio=(req.headers.referer||'').includes('studio-init');
        const init=studio?`(async()=>{
            if(Plugins.audio_filter && Plugins.audio_filter._script_loaded === false)delete Plugins.audio_filter;
            await Plugins.load('audio_filter');
            window.studioSawFilter=window.AudioFilterPlugin?.build === 'studio-2.0.0';
            await Plugins.load('https://aganet.github.io/openwebrxplus-rig-skin/receiver/rig_skin/rig_skin.js');
            const themes=$('#openwebrx-themes-listbox');
            if(themes.length)themes.val('rig').trigger('change');
            await Plugins.load('rsp_antenna');
            window.studioFinished=true;
        })();`:"Plugins.load('rsp_antenna');\nPlugins.load('rig_skin');\nPlugins.load('audio_filter');";
        data=read('htdocs/plugins/receiver/rig_dock/bootstrap.js')+'\n'+init;type='application/javascript';
    }
    else if(url==='/static/plugins/receiver/rsp_antenna/rsp_antenna.js'){data=read('htdocs/plugins/receiver/rsp_antenna/rsp_antenna.js');type='application/javascript';}
    else if(url==='/static/plugins/receiver/rsp_antenna/rsp_antenna.css'){data=read('htdocs/plugins/receiver/rsp_antenna/rsp_antenna.css');type='text/css';}
    else if(url==='/static/gfx/svg-defs.svg'){data=read('htdocs/gfx/svg-defs.svg');type='image/svg+xml';}
    else {
        let file;
        if(url.startsWith('/static/plugins/receiver/'))file=path.join(root,'htdocs/plugins/receiver',url.slice('/static/plugins/receiver/'.length));
        else file=path.join(root,url);
        if(!file.startsWith(root+'/')||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);res.end();return;}
        data=fs.readFileSync(file);type=url.endsWith('.js')?'application/javascript':url.endsWith('.css')?'text/css':'application/octet-stream';
    }
    res.setHeader('Content-Type',type);res.end(data);
});
(async()=>{
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const browser=await (useWebKit?webkit:chromium).launch(useWebKit?{headless:true}:{headless:true,
        executablePath:process.env.CHROMIUM_EXECUTABLE_PATH||undefined,
        args:JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS||'[]')});
    const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
    page.on('pageerror',e=>{errors.push(e.message);console.error('Browser error:',e.message);});
    let checks=0;const check=(v,msg)=>{assert.ok(v,msg);checks++;};
    try{
        const mobileContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3});
        const cold=await mobileContext.newPage(),coldErrors=[];
        cold.on('pageerror',e=>coldErrors.push(e.message));
        let releaseStyles;
        await cold.route('**/rig_dock.css?*',async route=>{
            await new Promise(resolve=>{releaseStyles=resolve;});await route.continue();
        });
        await cold.goto(`http://127.0.0.1:${server.address().port}/?cold-start=1`,{waitUntil:'domcontentloaded'});
        await cold.waitForFunction(()=>window.Plugins?.rig_dock?._version);
        await cold.waitForSelector('#rig-dock-startup');
        check(await cold.locator('#openwebrx-panel-receiver').isHidden(),'cold load hides floating native controls while the stylesheet is delayed');
        check(await cold.locator('#openwebrx-panel-status').isHidden(),'cold load hides the floating status panel before dock CSS arrives');
        check(await cold.evaluate(()=>!document.getElementById('rig-dock')),'cold load waits for the dock stylesheet');
        const stylesLoaded=cold.waitForResponse(r=>r.url().includes('rig_dock.css'));
        releaseStyles();await stylesLoaded;
        await cold.evaluate(()=>{
            window.startupPaints=[];
            function capture(){
                if(document.body.classList.contains('rig-dock-active')&&!document.body.classList.contains('rig-dock-loading')){
                    startupPaints.push({frequency:document.querySelector('#rig-dock .webrx-actual-freq').textContent,
                        profile:document.getElementById('openwebrx-sdr-profiles-listbox').value});
                }
                if(startupPaints.length<3)requestAnimationFrame(capture);
            }
            requestAnimationFrame(capture);
        });
        await cold.evaluate(()=>coldStartup.config());
        await cold.waitForTimeout(200);
        check(await cold.evaluate(()=>waterfall_setup_done&&!UI.getDemodulator()&&!document.getElementById('rig-dock')),'cold load waits for receiver data after the waterfall canvas exists');
        await cold.evaluate(()=>coldStartup.modes());await cold.waitForTimeout(120);
        check(await cold.evaluate(()=>!UI.getDemodulator()&&!document.getElementById('rig-dock')),'cold load waits for supported mode features');
        await cold.evaluate(()=>coldStartup.features());await cold.waitForTimeout(120);
        check(await cold.evaluate(()=>!!UI.getDemodulator()&&!document.getElementById('rig-dock')),'cold load waits for the profile list after the demodulator starts');
        await cold.evaluate(()=>coldStartup.profiles());
        await cold.waitForSelector('body.rig-dock-active:not(.rig-dock-loading)');
        check(await cold.locator('#rig-dock .webrx-actual-freq').textContent()==='7.074000 MHz','cold load reveals the configured frequency instead of 0 Hz');
        check(await cold.locator('#rig-dock #openwebrx-sdr-profiles-listbox').inputValue()==='sdrplay|40m','cold load reveals the selected profile');
        await cold.waitForFunction(()=>startupPaints.length>=3);
        check(await cold.evaluate(()=>startupPaints.every(p=>p.frequency==='7.074000 MHz'&&p.profile==='sdrplay|40m')),'every initial visible mobile frame has a populated frequency and profile');
        check(await cold.locator('#rig-dock-startup').count()===0,'connecting notice is removed after receiver readiness');
        await cold.waitForSelector('#rig-decoder-tray');
        check(await cold.evaluate(()=>{
            const tray=document.getElementById('rig-decoder-tray'),r=tray.getBoundingClientRect();
            return !document.getElementById('openwebrx-panel-receiver').contains(tray)&&Math.abs(r.left)<1&&Math.abs(r.width-innerWidth)<1;
        }),'cold mobile decoder tray spans the viewport outside the native receiver panel');
        await cold.evaluate(()=>document.getElementById('openwebrx-panel-receiver').style.setProperty('transform','translate3d(80px,0,0)','important'));
        check(await cold.evaluate(()=>{
            const r=document.getElementById('rig-decoder-tray').getBoundingClientRect();
            return Math.abs(r.left)<1&&Math.abs(r.width-innerWidth)<1;
        }),'native receiver transforms cannot move or clip the decoder tray');
        await cold.evaluate(()=>{Plugins.rig_dock.destroy(false);});
        check(await cold.locator('#rig-decoder-tray').count()===0,'restoring stock controls removes the separate decoder tray');
        check(await cold.evaluate(()=>savedDecoderNodes.every(n=>n.parentElement===savedDecoderParents.get(n))),'cold-load decoder nodes return to their native positions');
        await cold.unroute('**/rig_dock.css?*');
        await cold.goto(`http://127.0.0.1:${server.address().port}/?cold-start=1`);
        await cold.waitForSelector('#rig-dock-startup');
        await cold.evaluate(()=>{coldStartup.modes();coldStartup.features();coldStartup.profiles();});
        await cold.waitForTimeout(150);
        check(await cold.evaluate(()=>!document.getElementById('rig-dock')),'profiles and modes arriving first still wait for the initial receiver config');
        await cold.evaluate(()=>coldStartup.config());
        await cold.waitForSelector('body.rig-dock-active:not(.rig-dock-loading)');
        check(await cold.locator('#rig-dock .webrx-actual-freq').textContent()==='7.074000 MHz','reverse startup message order settles without a refresh');
        await cold.route('**/rig_dock.css?*',route=>route.abort());
        await cold.goto(`http://127.0.0.1:${server.address().port}/`);
        await cold.waitForFunction(()=>window.Plugins?.rig_dock?._script_loaded&&!document.body.classList.contains('rig-dock-loading'));
        check(await cold.locator('#openwebrx-panel-receiver').isVisible()&&await cold.locator('#rig-dock').count()===0,'stylesheet failure restores usable stock controls');
        check(await cold.locator('#rig-dock-startup').count()===0,'stylesheet failure removes the connecting notice');
        check(coldErrors.length===0,'no errors during cold mobile startup: '+coldErrors.join('; '));
        if(process.argv.includes('--startup-only')){
            console.log(`${checks} ${useWebKit?'WebKit':'Chromium'} cold mobile startup checks passed; simulated RF transport.`);
            return;
        }
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.waitForSelector('body.rig-dock-active');
        await page.waitForSelector('.rd-antennas button');
        check(await page.evaluate(()=>!Plugins.rig_skin&&!Plugins.audio_filter&&!Plugins.rig_audio),'legacy plugins blocked and optional filter not loaded');
        check(await page.evaluate(()=>savedProfileNode===document.getElementById('openwebrx-sdr-profiles-listbox')&&savedFrequencyNode===document.querySelector('.webrx-actual-freq')),'native profile and frequency nodes retained');
        check(await page.locator('.rd-antennas button').evaluateAll(nodes=>nodes.every(n=>n.getBoundingClientRect().height>=30&&n.scrollWidth<=n.clientWidth+1)),'antenna buttons are full height and labels fit');
        check(await page.locator('#openwebrx-panel-status').isHidden(),'floating status hidden');
        check(await page.locator('#openwebrx-panel-log').isHidden(),'chat is hidden in the dock');
        await page.evaluate(()=>toggle_panel('openwebrx-panel-log',true));
        check(await page.locator('#openwebrx-panel-log').isHidden(),'chat stays hidden when OWRX tries to reopen it');
        check(await page.locator('[data-toggle-panel="openwebrx-panel-log"]').isHidden(),'header chat button is hidden');
        check(await page.evaluate(()=>document.querySelector('#webrx-page-container').getBoundingClientRect().bottom<=document.querySelector('#openwebrx-panel-receiver').getBoundingClientRect().top+1),'waterfall space reserved');
        const record=page.locator('#rig-dock .openwebrx-record-button');
        await record.click();
        check(await page.evaluate(()=>audioEngine.recording),'dock starts native recording through the visible recording control');
        check(await record.getAttribute('aria-pressed')==='true','recording state is shown immediately');
        await page.evaluate(()=>{
            const samples=new Int16Array(24000);
            for(let i=0;i<samples.length;i++)samples[i]=Math.round(6000*Math.sin(2*Math.PI*1000*i/12000));
            audioEngine.recorder.record(samples);
        });
        const downloaded=page.waitForEvent('download');await record.click();
        const recording=await downloaded,bytes=fs.readFileSync(await recording.path());
        check(bytes.length>1000&&bytes[0]===255&&(bytes[1]&224)===224,'stopping native recording downloads MP3-encoded samples');
        check(/^REC-.*\.mp3$/.test(recording.suggestedFilename()),'native recording filename is retained');
        check(await page.evaluate(()=>!audioEngine.recording),'stop clears native recording state');
        await page.evaluate(()=>{ws.reply({type:'config',value:{allow_audio_recording:false}});UI.toggleRecording(true);});
        check(await record.isHidden()&&await page.evaluate(()=>!audioEngine.recording),'server recording permission still applies');
        await page.evaluate(()=>ws.reply({type:'config',value:{allow_audio_recording:true}}));
        await page.locator('#openwebrx-sdr-profiles-listbox').selectOption('sdrplay|20m');
        check(await page.evaluate(()=>profilesChanged===1),'native profile handler works after move');
        await page.locator('.openwebrx-squelch-slider').fill('-80');await page.locator('.openwebrx-squelch-slider').dispatchEvent('change');
        check(await page.evaluate(()=>UI.getDemodulator().getSquelch()===-80),'native delegated squelch handler works');
        await page.locator('[aria-controls="rd-popover-mode"]').click();
        check(await page.locator('#rd-popover-mode').isVisible(),'mode drop-up opens');
        await page.locator('[aria-label="Search modes"]').fill('rtty');
        check(await page.locator('.rd-mode-item').count()===1,'mode search filters supported list');
        await page.locator('[data-mode="rtty"]').click();
        check(await page.evaluate(()=>UI.getModulation()==='rtty'),'native digital demodulator mode set');
        await page.locator('[aria-controls="rd-popover-mode"]').click();
        await page.locator('#rd-popover-mode .rd-field select').selectOption('lsb');
        check(await page.evaluate(()=>UI.getUnderlying()==='lsb'),'digital underlying modulation works');
        await page.locator('[aria-controls="rd-popover-waterfall"]').click();
        check(await page.locator('#rd-popover-mode').isHidden(),'one popover at a time');
        await page.locator('#openwebrx-wf-themes-listbox').selectOption('ocean');
        check(await page.evaluate(()=>UI.wfTheme==='ocean'),'native palette selector works');
        await page.getByText('Continuous auto levels',{exact:true}).click();
        check(await page.evaluate(()=>Waterfall.measure_minmax_continuous),'continuous waterfall levels on');
        check(await page.locator('#openwebrx-waterfall-color-min').isDisabled(),'native manual slider disabled in auto mode');
        await page.getByText('Continuous auto levels',{exact:true}).click();
        await page.locator('#openwebrx-waterfall-color-min').fill('-105');await page.locator('#openwebrx-waterfall-color-min').dispatchEvent('change');
        check(await page.evaluate(()=>Waterfall.levels.min===-105),'manual waterfall minimum updates');
        await page.keyboard.press('Escape');
        check(await page.locator('#rd-popover-waterfall').isHidden(),'Escape closes popover');
        check(await page.locator('[aria-controls="rd-popover-waterfall"]').evaluate(n=>n===document.activeElement),'Escape returns focus');
        await page.locator('.rd-antennas button').filter({hasText:'B - Experimental'}).click();
        await page.waitForSelector('.rd-antennas button[title="Antenna B"][aria-pressed="true"]');
        check(await page.evaluate(()=>ws.selected==='Antenna B'),'existing antenna protocol preserved');
        await page.locator('.rd-antennas button').filter({hasText:'C - HF'}).click();
        await page.waitForSelector('.rd-antennas button[title="Antenna C"][aria-pressed="true"]');
        check(await page.evaluate(()=>ws.selected==='Antenna C'),'antenna C selection works');
        await page.locator('[aria-controls="rd-popover-bandpass"]').click();
        await page.locator('#rd-popover-bandpass input').nth(0).fill('-2700');await page.locator('#rd-popover-bandpass input').nth(1).fill('-200');
        await page.getByRole('button',{name:'Apply',exact:true}).click();
        check(await page.evaluate(()=>UI.getDemodulator().low_cut===-2700&&UI.getDemodulator().high_cut===-200),'receive bandpass applies');
        await page.locator('[aria-controls="rd-popover-audio"]').click();
        check(await page.getByText('Enable audio filter for this session',{exact:true}).locator('input').isChecked()===false,'audio starts bypassed');
        await page.getByRole('button',{name:'Filter settings…',exact:true}).click();
        await page.waitForSelector('#rig-audio-master-state');
        check(await page.evaluate(()=>!Plugins.rig_audio.isEnabled()&&routeLog.length===0),'loading settings leaves native audio route untouched');
        check(await page.evaluate(()=>AudioNode.prototype.connect===originalAudioConnect),'AudioNode prototype is unchanged');
        await page.getByRole('button',{name:'Enable',exact:true}).click();
        check(await page.evaluate(()=>Plugins.rig_audio.isEnabled()),'explicit filter enable');
        check(await page.evaluate(()=>routeLog.some(x=>x[0]==='disconnect'&&x[1]==='direct')),'filter enable removes native direct route');
        await page.getByRole('button',{name:'Bypass',exact:true}).click();
        check(await page.evaluate(()=>!Plugins.rig_audio.isEnabled()),'filter bypass disables processing');
        check(await page.evaluate(()=>routeLog.some(x=>x[0]==='disconnect'&&x[1]==='filter')),'bypass detaches filter input');
        const residual=await page.evaluate(async()=>{
            const previous=audioEngine;
            const offline=new OfflineAudioContext(1,8192,48000);
            // This checks routing, independently of worklet/ScriptProcessor DSP.
            const secure=Object.getOwnPropertyDescriptor(window,'isSecureContext');
            Object.defineProperty(window,'isSecureContext',{value:false,configurable:true});
            offline.createScriptProcessor=()=>offline.createGain();
            const gainNode=offline.createGain();gainNode.connect(offline.destination);
            audioEngine={audioContext:offline,gainNode,isStarted:()=>true};
            const data=offline.createBuffer(1,8192,48000),input=data.getChannelData(0);
            for(let i=0;i<input.length;i++)input[i]=.2*Math.sin(i*.123)+.1*Math.sin(i*.617);
            const source=offline.createBufferSource();source.buffer=data;source.connect(gainNode);
            Plugins.rig_audio.setEnabled(true);Plugins.rig_audio.setEnabled(false);
            source.start();const rendered=await offline.startRendering();audioEngine=previous;
            if(secure)Object.defineProperty(window,'isSecureContext',secure);else delete window.isSecureContext;
            return Math.max(...rendered.getChannelData(0).map((v,i)=>Math.abs(v-input[i])));
        });
        check(residual<1e-7,'rendered audio is unchanged after enable then bypass (max error '+residual+')');
        await page.evaluate(()=>Plugins.toggleWindow('rig_audio',false));
        await page.waitForTimeout(600);
        check(await page.locator('[aria-controls="rd-popover-audio"]').innerText()==='Audio: Bypassed ▴','dock displays actual bypass state');
        await page.locator('[aria-controls="rd-popover-more"]').click();
        check(await page.locator('#openwebrx-themes-listbox').isVisible(),'display settings available in More');
        check(await page.getByRole('button',{name:'Chat / log',exact:true}).count()===0,'chat launcher removed from More');
        await page.keyboard.press('Escape');
        await page.locator('[aria-controls="rd-popover-tune"]').click();
        await page.locator('.rd-tune-form input').fill('7.125 MHz');await page.locator('.rd-tune-form button').click();
        check(await page.evaluate(()=>UI.getFrequency()===7125000),'frequency entry accepts MHz');
        await page.locator('[aria-controls="rd-popover-tune"]').click();
        await page.locator('.rd-tune-form input').fill('7126 kHz');await page.locator('.rd-tune-form button').click();
        check(await page.evaluate(()=>UI.getFrequency()===7126000),'frequency entry accepts kHz');
        await page.locator('[aria-controls="rd-popover-tune"]').click();
        await page.locator('.rd-tune-form input').fill('7127000 Hz');await page.locator('.rd-tune-form input').press('Enter');
        check(await page.evaluate(()=>UI.getFrequency()===7127000),'frequency entry accepts Hz with Enter');
        await page.locator('[aria-controls="rd-popover-tune"]').click();
        await page.locator('.rd-tune-form input').fill('7.128');await page.locator('.rd-tune-form button').click();
        check(await page.evaluate(()=>UI.getFrequency()===7128000),'unitless frequency remains MHz');
        check(await page.evaluate(()=>!ws.sent.some(x=>x.type==='setfrequency')),'in-window tuning does not retune the shared SDR');
        await page.evaluate(()=>{UI.setModulation('rtty','lsb');UI.getDemodulatorPanel().setMagicKey('test-key');ws.requiredKey='test-key';});
        await page.locator('[aria-controls="rd-popover-tune"]').click();
        await page.locator('.rd-tune-form input').fill('144.390 MHz');await page.locator('.rd-tune-form button').click();
        check(await page.locator('.rd-tune-form button').isDisabled(),'out-of-window tuning waits for server acknowledgment');
        await page.waitForFunction(()=>UI.getFrequency()===144390000&&!UI.getDemodulatorPanel().centerFreqTimeout).catch(async error=>{
            console.error(await page.evaluate(()=>({frequency:UI.getFrequency(),center_freq,panelCenter:UI.getDemodulatorPanel().center_freq,timeout:UI.getDemodulatorPanel().centerFreqTimeout,mode:UI.getModulation(),sent:ws.sent,feedback:document.querySelector('#rd-popover-tune [role="status"]').textContent})),errors);
            throw error;
        });
        await page.waitForSelector('#rd-popover-tune[hidden]',{state:'attached'});
        check(await page.evaluate(()=>center_freq===144390000&&UI.getFrequency()===144390000),'outside-profile frequency retunes receiver and listening frequency');
        check(await page.evaluate(()=>UI.getModulation()==='rtty'&&UI.getUnderlying()==='lsb'),'retuning retains decoder and underlying mode after native demodulator restart');
        check(await page.evaluate(()=>ws.sent.filter(x=>x.type==='setfrequency').length===1&&ws.sent.find(x=>x.type==='setfrequency').params.key==='test-key'),'retuning uses native setfrequency and current magic key once');
        await page.evaluate(()=>ws.reply({type:'config',value:{allow_center_freq_changes:false}}));
        await page.locator('[aria-controls="rd-popover-tune"]').click();
        await page.locator('.rd-tune-form input').fill('7.125 MHz');await page.locator('.rd-tune-form button').click();
        check(await page.locator('#rd-popover-tune [role="status"]').innerText().then(s=>s.includes('Allow center frequency changes')),'server-disabled retuning explains the setting');
        check(await page.evaluate(()=>ws.sent.filter(x=>x.type==='setfrequency').length===1),'disabled retuning sends no request');
        await page.evaluate(()=>{ws.reply({type:'config',value:{allow_center_freq_changes:true}});ws.allowTune=false;});
        // Keep real timers: native panel animations and MutationObservers share
        // this page. The server silently ignores a wrong/missing magic key.
        await page.locator('.rd-tune-form button').click();
        await page.locator('#rd-popover-tune [role="status"]').filter({hasText:'did not retune'}).waitFor({state:'visible',timeout:12000});
        check(await page.locator('#rd-popover-tune [role="status"]').innerText().then(s=>s.includes('did not retune')&&s.includes('magic key')),'ignored request times out without claiming success');
        check(await page.locator('.rd-tune-form button').isEnabled(),'failed retuning releases the control for retry');
        await page.locator('.rd-tune-form button').click();
        await page.locator('#openwebrx-sdr-profiles-listbox').selectOption('sdrplay|40m');
        check(await page.locator('.rd-tune-form button').isEnabled(),'profile selection cancels pending listening-frequency update');
        await page.evaluate(()=>{ws.reply({type:'config',value:{center_freq:7125000}});});
        await page.waitForTimeout(180);
        check(await page.evaluate(()=>UI.getFrequency()===7125000&&UI.getModulation()==='lsb'),'late acknowledgment after cancellation does not restore an old mode');
        await page.locator('.rd-tune-form input').fill('not a frequency');await page.locator('.rd-tune-form button').click();
        check(await page.locator('#rd-popover-tune [role="status"]').innerText().then(s=>s.includes('Enter a frequency')),'invalid frequency gets an inline message');
        await page.evaluate(()=>{ws.allowTune=true;ws.readyState=3;});
        await page.locator('.rd-tune-form input').fill('14.2 MHz');await page.locator('.rd-tune-form button').click();
        check(await page.locator('#rd-popover-tune [role="status"]').innerText().then(s=>s.includes('disconnected')),'disconnected retuning reports an inline error');
        await page.evaluate(()=>{ws.readyState=1;ws.allowTune=false;});
        await page.locator('.rd-tune-form button').click();
        await page.getByRole('button',{name:'Stop waiting',exact:true}).click();
        await page.waitForTimeout(180);
        check(await page.locator('.rd-tune-form button').isEnabled(),'stopping a wait cancels the pending client update');
        await page.keyboard.press('Escape');
        await page.evaluate(()=>{ws.allowTune=true;ws.reply({type:'config',value:{center_freq:7100000}});});
        await page.waitForTimeout(180);
        await page.evaluate(()=>{UI.setModulation('lsb');UI.setFrequency(7121000,false);document.getElementById('openwebrx-sdr-profiles-listbox').value='sdrplay|40m';});
        await page.evaluate(()=>{ws.reply({type:'cpuusage',value:.13});ws.reply({type:'clients',value:2});});
        await page.waitForTimeout(600);
        check(await page.locator('.rd-footer').innerText().then(s=>s.includes('CPU 13%')&&s.includes('2 listeners')),'footer shows live server status');
        check(await page.evaluate(()=>savedDecoderNodes.every(node=>node.parentElement.id==='rig-decoder-body')),'all native decoder panel nodes are retained in one tray');
        const families={
            ft8:'wsjt-message',ft4:'wsjt-message',wspr:'wsjt-message',js8:'js8-message',
            packet:'packet-message',ais:'packet-message',pocsag:'pocsag-message',page:'page-message',
            hfdl:'hfdl-message',vdl2:'hfdl-message',acars:'hfdl-message',uat:'hfdl-message',
            adsb:'adsb-message',ism:'ism-message',wmbus:'ism-message',dsc:'dsc-message',ale2g:'ale2g-message',
            sstv:'sstv-message',fax:'fax-message',cwskimmer:'skimmer-message',meshtastic:'meshtastic-message',
            rtty:'digimodes',dmr:'metadata-dmr',m17:'metadata-m17',ysf:'metadata-ysf',
            dstar:'metadata-dstar',nxdn:'metadata-nxdn',p25:'metadata-p25',tetra:'metadata-tetra',
            wfm:'metadata-wfm',dab:'metadata-dab',hdr:'metadata-hdr',drm:'metadata-drm'
        };
        for(const [mode,suffix] of Object.entries(families)){
            await page.evaluate(mode=>UI.setModulation(mode),mode);
            await page.waitForFunction(suffix=>{
                const node=document.getElementById('openwebrx-panel-'+suffix);
                return node&&node.parentElement.id==='rig-decoder-body'&&node.style.display!=='none'&&!node.movement&&
                    !document.getElementById('rig-decoder-tray').hidden;
            },suffix,{timeout:10000,polling:50}).catch(async error=>{
                console.error('Decoder mode failed:',mode,suffix,await page.evaluate(suffix=>{
                    const node=document.getElementById('openwebrx-panel-'+suffix);
                    return {mode:UI.getModulation(),node:node&&{style:node.getAttribute('style'),classes:node.className,parent:node.parentElement.id,movement:node.movement},tray:document.getElementById('rig-decoder-tray').outerHTML.slice(0,500)};
                },suffix));throw error;
            });
            check(await page.locator('#openwebrx-panel-'+suffix).isVisible(),`${mode} output is in the decoder tray`);
        }
        await page.evaluate(()=>{
            UI.setModulation('ale2g');
            const panel=$('#openwebrx-panel-ale2g-message').ale2gMessagePanel();
            window.alePanel=panel;
            panel.pushMessage({mode:'ALE2G',timestamp:Date.now(),freq:7102000,source:'BAS',destination:'',event:'amd',message:'AMD: <img src=x onerror=alert(1)>'});
        });
        check(await page.locator('#openwebrx-panel-ale2g-message tbody').innerText().then(s=>s.includes('BAS')&&s.includes('7102.0')),'ALE output preserves station and exact channel');
        check(await page.locator('#openwebrx-panel-ale2g-message tbody img').count()===0,'radio text cannot inject HTML into ALE output');
        await page.locator('#rig-decoder-tray').getByRole('button',{name:'Clear',exact:true}).click();
        check(await page.locator('#openwebrx-panel-ale2g-message tbody tr').count()===0,'ALE output uses the shared Clear action');
        await page.evaluate(()=>UI.setModulation('ft8'));
        await page.waitForFunction(()=>!document.getElementById('rig-decoder-tray').hidden);
        await page.evaluate(()=>{
            const panel=$('#openwebrx-panel-wsjt-message').wsjtMessagePanel();
            window.savedWsjt=panel;
            for(let i=0;i<30;i++)panel.pushMessage({mode:'FT8',timestamp:Date.now(),db:-14,dt:.2,freq:7074000+i,msg:'CQ K2AAM FN33'});
        });
        check(await page.locator('#openwebrx-panel-wsjt-message a[href="https://www.qrz.com/db/K2AAM"]').count()===30,'native decoded callsign links survive moving the panel');
        check(await page.locator('#openwebrx-panel-wsjt-message tbody').evaluate(n=>n.scrollHeight>n.clientHeight),'decoder messages scroll inside the bounded pane');
        const originalHeight=(await page.locator('#rig-decoder-tray').boundingBox()).height;
        await page.getByRole('slider',{name:'Decoder pane height',exact:true}).fill('55');
        check((await page.locator('#rig-decoder-tray').boundingBox()).height>originalHeight,'decoder height can be adjusted');
        check(await page.evaluate(()=>{
            const tray=document.getElementById('rig-decoder-tray').getBoundingClientRect();
            const dock=document.getElementById('openwebrx-panel-receiver').getBoundingClientRect();
            return document.getElementById('webrx-page-container').getBoundingClientRect().bottom<=tray.top+1&&tray.bottom<=dock.top+1;
        }),'decoder tray reserves waterfall space directly above the RIG dock');
        await page.locator('#rig-decoder-tray').getByRole('button',{name:'Collapse',exact:true}).click();
        check(await page.locator('#rig-decoder-body').isHidden(),'decoder tray collapses without hiding native panel state');
        await page.evaluate(()=>savedWsjt.pushMessage({mode:'FT8',timestamp:Date.now(),db:-9,dt:.1,freq:7074000,msg:'CQ K2AAM FN33'}));
        check(await page.locator('#openwebrx-panel-wsjt-message tbody tr').count()===31&&await page.evaluate(()=>UI.getModulation()==='ft8'),'decoding continues while the tray is collapsed');
        await page.locator('#rig-decoder-tray').getByRole('button',{name:'Expand',exact:true}).click();
        check(await page.evaluate(()=>savedWsjt===$('#openwebrx-panel-wsjt-message').wsjtMessagePanel()),'expand keeps the native message handler instance');
        await page.locator('#rig-decoder-tray').getByRole('button',{name:'Clear',exact:true}).click();
        check(await page.locator('#openwebrx-panel-wsjt-message tbody tr').count()===0,'tray Clear invokes the native decoder Clear handler');
        const ifToggle=page.locator('#rig-decoder-tray').getByRole('button',{name:'IF waterfall',exact:true});
        await ifToggle.click();
        check(await page.locator('#openwebrx-digimode-canvas-container').isHidden()&&await ifToggle.isVisible(),'decoder waterfall can be hidden and its toggle remains available');
        await ifToggle.click();
        check(await page.locator('#openwebrx-digimode-canvas-container').isVisible(),'decoder waterfall can be restored');
        await page.evaluate(()=>{UI.setModulation('rtty');secondary_demod_push_data('RTTY TEST <decoded>\n');});
        await page.waitForFunction(()=>document.getElementById('rig-decoder-tray').dataset.text==='true');
        check(await page.locator('#openwebrx-digimode-content').innerText().then(s=>s.replace(/\s/g,' ').includes('RTTY TEST <decoded>')),'native text decoder appends escaped output in the tray');
        await page.locator('#rig-decoder-tray').getByRole('button',{name:'Clear',exact:true}).click();
        check(await page.locator('#openwebrx-cursor-blink').count()===1&&await page.locator('#openwebrx-digimode-content').innerText().then(s=>!s.includes('RTTY')),'text Clear retains the native cursor and content container');
        await page.evaluate(()=>{
            UI.setModulation('js8');
            $('#openwebrx-panel-js8-message').js8().pushMessage({mode:'JS8',js8mode:'A',thread_type:3,timestamp:Date.now(),freq:7078000,msg:'K2AAM: TEST MESSAGE'});
        });
        await page.waitForFunction(()=>document.getElementById('openwebrx-panel-js8-message').style.display!=='none');
        check(await page.locator('#openwebrx-panel-js8-message').innerText().then(s=>s.includes('TEST MESSAGE')),'native JS8 thread output remains functional');
        await page.evaluate(()=>{
            UI.setModulation('sstv');
            const panel=$('#openwebrx-panel-sstv-message').sstvMessagePanel();
            panel.pushMessage({width:16,height:8,timestamp:'12:00',filename:'test-sstv',sstvMode:'Test'});
            panel.pushMessage({width:16,height:8,line:0,pixels:btoa('\x00\x00\xff'.repeat(16))});
            window.savedSstvCanvas=document.getElementById('test-sstv');
        });
        await page.waitForFunction(()=>document.getElementById('openwebrx-panel-sstv-message').style.display!=='none');
        check(await page.evaluate(()=>savedSstvCanvas.getContext('2d').getImageData(0,0,1,1).data[0]===255),'native SSTV scanlines render into the retained image canvas');
        await page.locator('#rig-decoder-tray').getByRole('button',{name:'Collapse',exact:true}).click();
        await page.evaluate(()=>{
            $('#openwebrx-panel-sstv-message').sstvMessagePanel().pushMessage({width:16,height:8,line:1,pixels:btoa('\x00\xff\x00'.repeat(16))});
            UI.setModulation('lsb');
        });
        await page.waitForSelector('#rig-decoder-tray',{state:'hidden'});
        check(await page.evaluate(()=>savedSstvCanvas.getContext('2d').getImageData(0,1,1,1).data[1]===255),'image decoding continues while the tray is collapsed');
        check(await page.evaluate(()=>savedDecoderNodes.every(node=>node.style.display==='none'&&!node.movement)),'switching to an analog mode settles all native collapse states');
        await page.evaluate(()=>UI.setModulation('fax'));
        await page.waitForSelector('#rig-decoder-tray',{state:'visible'});
        check(await page.locator('#rig-decoder-body').isHidden(),'collapsed preference survives switching decoder types');
        await page.locator('#rig-decoder-tray').getByRole('button',{name:'Expand',exact:true}).click();
        await page.evaluate(()=>{
            const panel=$('#openwebrx-panel-fax-message').faxMessagePanel();
            panel.pushMessage({width:16,height:8,timestamp:'12:01',filename:'test-fax',faxMode:'Test'});
            panel.pushMessage({width:16,height:8,line:0,depth:8,pixels:btoa('\x7f'.repeat(16))});
        });
        check(await page.evaluate(()=>document.getElementById('test-fax').getContext('2d').getImageData(0,0,1,1).data[0]===127),'native fax scanlines render in the same shared tray');
        await page.evaluate(()=>{
            UI.setModulation('lsb');
            const node=document.createElement('div');node.className='openwebrx-panel openwebrx-message-panel';node.id='future-decoder';node.textContent='Future decoder output';
            document.getElementById('openwebrx-panels-container-left').append(node);window.futureDecoder=node;
        });
        await page.waitForFunction(()=>futureDecoder.parentElement.id==='rig-decoder-body');
        check(await page.locator('#future-decoder').isVisible(),'new decoder panels are adopted without a hard-coded mode list');
        await page.evaluate(()=>{futureDecoder.remove();UI.setModulation('ft8');
            savedWsjt.pushMessage({mode:'FT8',timestamp:Date.now(),db:-14,dt:.2,freq:7074000,msg:'CQ K2AAM FN33'});});
        await page.getByRole('slider',{name:'Decoder pane height',exact:true}).fill('28');
        await page.waitForFunction(()=>document.querySelector('[aria-controls="rd-popover-mode"]').textContent.includes('FT8'));
        await page.screenshot({path:path.join(root,'test-results/rig-dock-desktop.png')});
        for(const [width,height] of [[1024,768],[390,844],[375,667],[844,390]]){
            await page.setViewportSize({width,height});await page.waitForTimeout(150);
            if(width===390){
                await page.evaluate(()=>localStorage.removeItem('rig_dock_decoder_if'));
                await page.reload();await page.waitForSelector('#rig-dock');
                await page.evaluate(()=>{UI.setModulation('ft8');
                    $('#openwebrx-panel-wsjt-message').wsjtMessagePanel().pushMessage({mode:'FT8',timestamp:Date.now(),db:-14,dt:.2,freq:7074000,msg:'CQ K2AAM FN33'});});
                await page.waitForSelector('#rig-decoder-tray',{state:'visible'});
                check(await page.locator('#openwebrx-digimode-canvas-container').isHidden(),'phone defaults to full-width decoder results with an optional IF view');
            }
            check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`no horizontal overflow ${width}×${height}`);
            check(await page.evaluate(()=>document.querySelector('#webrx-page-container').getBoundingClientRect().bottom<=document.querySelector('#openwebrx-panel-receiver').getBoundingClientRect().top+1),`waterfall reserved ${width}×${height}`);
            check(await page.evaluate(()=>{
                const tray=document.getElementById('rig-decoder-tray').getBoundingClientRect();
                return tray.left>=0&&tray.right<=innerWidth+1&&tray.top>=document.getElementById('webrx-canvas-background').getBoundingClientRect().top-1&&
                    tray.bottom<=document.getElementById('openwebrx-panel-receiver').getBoundingClientRect().top+1&&
                    document.getElementById('webrx-page-container').getBoundingClientRect().bottom<=tray.top+1;
            }),`decoder and main waterfall fit the viewport ${width}×${height}`);
            await page.locator('[aria-controls="rd-popover-mode"]').click();
            const bounds=await page.locator('#rd-popover-mode').boundingBox();
            check(bounds.x>=0&&bounds.x+bounds.width<=width+1&&bounds.y>=0&&bounds.y+bounds.height<=height+1,`popover inside viewport ${width}×${height}`);
            await page.keyboard.press('Escape');
            if(width===390)await page.screenshot({path:path.join(root,'test-results/rig-dock-mobile.png')});
        }
        await page.setViewportSize({width:1440,height:900});
        await page.evaluate(()=>{
            const node=document.createElement('div');node.className='openwebrx-panel openwebrx-message-panel';node.id='removed-decoder';
            document.getElementById('openwebrx-panels-container-left').append(node);window.removedDecoder=node;
        });
        await page.waitForFunction(()=>removedDecoder.parentElement.id==='rig-decoder-body');
        await page.evaluate(()=>removedDecoder.remove());
        await page.evaluate(()=>Plugins.rig_dock.destroy(true));
        check(await page.evaluate(()=>!document.body.classList.contains('rig-dock-active')),'stock controls restored');
        check(await page.evaluate(()=>savedSquelchNode===document.querySelector('.openwebrx-squelch-slider')&&!document.querySelector('#rig-dock')),'native nodes restored after destroy');
        check(await page.evaluate(()=>savedDecoderNodes.every(node=>node.parentElement===savedDecoderParents.get(node)&&!node.classList.contains('rd-decoder-native'))),'all native decoder panels return to their original parents');
        check(await page.locator('#removed-decoder').count()===0,'teardown does not recreate a decoder removed by its owner');
        await page.getByRole('button',{name:'RIG Dock',exact:true}).click();await page.waitForSelector('#rig-dock');
        check(await page.evaluate(()=>!Plugins.rig_audio||!Plugins.rig_audio.isEnabled()),'reenabling dock keeps filter bypassed or unloaded');
        await page.reload();await page.waitForSelector('#rig-dock');
        check(await page.evaluate(()=>!Plugins.rig_audio),'reload does not load optional filter');
        const studio=page;const studioErrors=[];
        studio.on('pageerror',e=>studioErrors.push(e.message));
        await studio.goto(`http://127.0.0.1:${server.address().port}/?studio-init=1`);
        await studio.waitForSelector('body.rig-dock-active');
        await studio.waitForFunction(()=>window.studioFinished===true);
        await studio.waitForSelector('.rd-antennas button');
        check(await studio.evaluate(()=>!Plugins.audio_filter&&!Plugins.rig_skin&&!window.studioSawFilter),'Optiplex guarded Studio checks are safe when legacy loads are skipped');
        check(await studio.locator('.rd-antennas button').count()===3,'Optiplex-style async startup continues loading other plugins');
        check(studioErrors.length===0,'Optiplex-style startup has no browser errors: '+studioErrors.join('; '));
        await page.addInitScript(()=>{if(location.search.includes('map-test'))window.mapManager={};});
        await page.goto(`http://127.0.0.1:${server.address().port}/?map-test=1`);
        await page.waitForFunction(()=>Plugins._type==='map');
        check(await page.evaluate(()=>!window.owrxRigDockLoader&&!Plugins.rig_dock),'map plugin initialization does not load the receiver dock');
        const slow=await browser.newPage();const slowErrors=[];
        slow.on('pageerror',e=>slowErrors.push(e.message));
        await slow.goto(`http://127.0.0.1:${server.address().port}/?delay-start=1`);
        await slow.waitForResponse(r=>r.url().includes('rig_dock.css'),{timeout:10000}).catch(()=>{});
        await slow.waitForTimeout(300);
        check(await slow.evaluate(()=>!document.getElementById('rig-dock')&&!waterfall_setup_done),'dock waits while native scale is uninitialized');
        check(await slow.evaluate(()=>savedProfileNode.parentElement.parentElement.id==='openwebrx-panel-receiver'),'native controls remain in place before receiver startup');
        await slow.evaluate(()=>finishReceiverStartup());
        await slow.waitForSelector('body.rig-dock-active');
        check(await slow.locator('#openwebrx-scale-canvas').evaluate(n=>n.style.width.endsWith('px')),'real native resize_scale succeeds after delayed startup');
        await slow.evaluate(()=>{waterfall_setup_done=0;scale_canvas=undefined;scale_ctx=undefined;Plugins.rig_dock.destroy(false);});
        check(await slow.evaluate(()=>!document.getElementById('rig-dock')),'cleanup works when native scale is unavailable');
        check(slowErrors.length===0,'no errors on delayed startup or early cleanup: '+slowErrors.join('; '));
        await slow.close();
        check(errors.length===0,'no browser errors: '+errors.join('; '));
        console.log(`${checks} browser checks passed; native OWRX 1.2.126 HTML, UI, demodulator panel, waterfall and plugin APIs; simulated RF transport.`);
    }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});

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
        // The station file as shipped, minus third-party plugins fetched from the internet.
data=read('htdocs/plugins/receiver/init.js');if(!(req.headers.referer||'').includes('community=1'))data=data.replace(/\/\/ BEGIN community plugins[\s\S]*?\/\/ END community plugins/,'');type='application/javascript';
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
    let checks=0;const check=(v,msg)=>{assert.ok(v,msg);checks++;if(process.env.RECEIVER_TEST_PROGRESS)console.log(checks+': '+msg);};
    async function loadScreenshotPlugin(target) {
        await target.route('**/html2canvas.min.js',route=>route.fulfill({contentType:'application/javascript',body:
            'window.html2canvas=(node,options)=>{window.screenshotCalls=(window.screenshotCalls||0)+1;options.canvas.getContext("2d").fillRect(0,0,8,8);return Promise.resolve(options.canvas);};'}));
        await target.evaluate(()=>{Plugins.screenshot={};});
        await target.addScriptTag({path:path.join(root,'test/browser/fixtures/screenshot.js')});
        await target.evaluate(async()=>{await Plugins.screenshot.init();window.originalScreenshot=document.getElementById('screenshot-btn');});
    }
    try{
        const mobileContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3});
        const cold=await mobileContext.newPage(),coldErrors=[];
        cold.on('pageerror',e=>coldErrors.push(e.message));
        const coldConsole=[];cold.on('console',m=>{if(['error','warning'].includes(m.type()))coldConsole.push(m.type()+': '+m.text());});
        let releaseStyles;
        await cold.route('**/k2aam_dock.css?*',async route=>{
            await new Promise(resolve=>{releaseStyles=resolve;});await route.continue();
        });
        await cold.goto(`http://127.0.0.1:${server.address().port}/?cold-start=1`,{waitUntil:'domcontentloaded'});
        await cold.waitForFunction(()=>window.Plugins?.k2aam_dock?._version);
        await cold.waitForSelector('#k2aam-dock-startup');
        const coldState=await cold.evaluate(()=>JSON.stringify({body:document.body.className,notice:!!document.getElementById('k2aam-dock-startup'),
            panel:getComputedStyle(document.getElementById('openwebrx-panel-receiver')).visibility,
            container:getComputedStyle(document.getElementById('openwebrx-panels-container')).visibility,
            links:Array.from(document.querySelectorAll('link[rel=stylesheet]')).map(l=>l.getAttribute('href')),
            plugins:Object.keys(Plugins).filter(k=>Plugins[k]&&typeof Plugins[k]==='object'&&'_script_loaded' in Plugins[k]).map(k=>k+'='+Plugins[k]._script_loaded)}));
        check(await cold.locator('#openwebrx-panel-receiver').isHidden(),'cold load hides floating native controls while the stylesheet is delayed '+coldState+' console='+JSON.stringify(coldConsole)+' errors='+JSON.stringify(coldErrors));
        check(await cold.locator('#openwebrx-panel-status').isHidden(),'cold load hides the floating status panel before dock CSS arrives');
        check(await cold.evaluate(()=>!document.getElementById('k2aam-dock')),'cold load waits for the dock stylesheet');
        const stylesLoaded=cold.waitForResponse(r=>r.url().includes('k2aam_dock.css'));
        releaseStyles();await stylesLoaded;
        await cold.evaluate(()=>{
            window.startupPaints=[];
            function capture(){
                if(document.body.classList.contains('k2aam-dock-active')&&!document.body.classList.contains('k2aam-dock-loading')){
                    startupPaints.push({frequency:document.querySelector('#k2aam-dock .webrx-actual-freq').textContent,
                        profile:document.getElementById('openwebrx-sdr-profiles-listbox').value});
                }
                if(startupPaints.length<3)requestAnimationFrame(capture);
            }
            requestAnimationFrame(capture);
        });
        await cold.evaluate(()=>coldStartup.config());
        await cold.waitForTimeout(200);
        check(await cold.evaluate(()=>waterfall_setup_done&&!UI.getDemodulator()&&!document.getElementById('k2aam-dock')),'cold load waits for receiver data after the waterfall canvas exists');
        await cold.evaluate(()=>coldStartup.modes());await cold.waitForTimeout(120);
        check(await cold.evaluate(()=>!UI.getDemodulator()&&!document.getElementById('k2aam-dock')),'cold load waits for supported mode features');
        await cold.evaluate(()=>coldStartup.features());await cold.waitForTimeout(120);
        check(await cold.evaluate(()=>!!UI.getDemodulator()&&!document.getElementById('k2aam-dock')),'cold load waits for the profile list after the demodulator starts');
        await cold.evaluate(()=>coldStartup.profiles());
        await cold.waitForSelector('body.k2aam-dock-active:not(.k2aam-dock-loading)');
        check(await cold.locator('#k2aam-dock .webrx-actual-freq').textContent()==='7.074000 MHz','cold load reveals the configured frequency instead of 0 Hz');
        check(await cold.locator('#k2aam-dock #openwebrx-sdr-profiles-listbox').inputValue()==='sdrplay|40m','cold load reveals the selected profile');
        await cold.waitForFunction(()=>startupPaints.length>=3);
        check(await cold.evaluate(()=>startupPaints.every(p=>p.frequency==='7.074000 MHz'&&p.profile==='sdrplay|40m')),'every initial visible mobile frame has a populated frequency and profile');
        check(await cold.locator('#k2aam-dock-startup').count()===0,'connecting notice is removed after receiver readiness');
        await cold.waitForSelector('#k2aam-decoder-tray');
        check(await cold.evaluate(()=>{
            const tray=document.getElementById('k2aam-decoder-tray'),r=tray.getBoundingClientRect();
            return !document.getElementById('openwebrx-panel-receiver').contains(tray)&&Math.abs(r.left)<1&&Math.abs(r.width-innerWidth)<1;
        }),'cold mobile decoder tray spans the viewport outside the native receiver panel');
        await cold.evaluate(()=>document.getElementById('openwebrx-panel-receiver').style.setProperty('transform','translate3d(80px,0,0)','important'));
        check(await cold.evaluate(()=>{
            const r=document.getElementById('k2aam-decoder-tray').getBoundingClientRect();
            return Math.abs(r.left)<1&&Math.abs(r.width-innerWidth)<1;
        }),'native receiver transforms cannot move or clip the decoder tray');
        await cold.evaluate(()=>{Plugins.k2aam_dock.destroy(false);});
        check(await cold.locator('#k2aam-decoder-tray').count()===0,'restoring stock controls removes the separate decoder tray');
        check(await cold.evaluate(()=>savedDecoderNodes.every(n=>n.parentElement===savedDecoderParents.get(n))),'cold-load decoder nodes return to their native positions');
        await cold.unroute('**/k2aam_dock.css?*');
        await cold.goto(`http://127.0.0.1:${server.address().port}/?cold-start=1`,{waitUntil:'domcontentloaded'});
        await cold.waitForSelector('#k2aam-dock-startup');
        await cold.evaluate(()=>{coldStartup.modes();coldStartup.features();coldStartup.profiles();});
        await cold.waitForTimeout(150);
        check(await cold.evaluate(()=>!document.getElementById('k2aam-dock')),'profiles and modes arriving first still wait for the initial receiver config');
        await cold.evaluate(()=>coldStartup.config());
        await cold.waitForSelector('body.k2aam-dock-active:not(.k2aam-dock-loading)');
        check(await cold.locator('#k2aam-dock .webrx-actual-freq').textContent()==='7.074000 MHz','reverse startup message order settles without a refresh');
        await cold.route('**/k2aam_dock.css?*',route=>route.abort());
        await cold.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
        await cold.waitForFunction(()=>window.Plugins?.k2aam_dock?._script_loaded&&!document.body.classList.contains('k2aam-dock-loading'));
        check(await cold.locator('#openwebrx-panel-receiver').isVisible()&&await cold.locator('#k2aam-dock').count()===0,'stylesheet failure restores usable stock controls');
        check(await cold.locator('#k2aam-dock-startup').count()===0,'stylesheet failure removes the connecting notice');
        check(coldErrors.length===0,'no errors during cold mobile startup: '+coldErrors.join('; '));
        if(process.argv.includes('--startup-only')){
            console.log(`${checks} ${useWebKit?'WebKit':'Chromium'} cold mobile startup checks passed; simulated RF transport.`);
            return;
        }
        await page.bringToFront();
        await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
        await page.waitForSelector('body.k2aam-dock-active');
        await page.waitForSelector('.rd-antennas button');
        check(await page.evaluate(()=>Plugins.ui_select.current()==='dock'&&!Plugins.rig_skin&&!Plugins.audio_filter),'dock is the default interface and the RIG skin is not loaded with it');
        check(await page.evaluate(()=>savedProfileNode===document.getElementById('openwebrx-sdr-profiles-listbox')&&savedFrequencyNode===document.querySelector('.webrx-actual-freq')),'native profile and frequency nodes retained');
        check(await page.locator('.rd-antennas button').evaluateAll(nodes=>nodes.every(n=>n.getBoundingClientRect().height>=30&&n.scrollWidth<=n.clientWidth+1)),'antenna buttons are full height and labels fit');
        check(await page.locator('#openwebrx-panel-status').isHidden(),'floating status hidden');
        check(await page.locator('#openwebrx-panel-log').isHidden(),'chat is hidden in the dock');
        await page.evaluate(()=>toggle_panel('openwebrx-panel-log',true));
        check(await page.locator('#openwebrx-panel-log').isHidden(),'chat stays hidden when OWRX tries to reopen it');
        check(await page.locator('[data-toggle-panel="openwebrx-panel-log"]').isHidden(),'header chat button is hidden');
        check(await page.evaluate(()=>document.querySelector('#webrx-page-container').getBoundingClientRect().bottom<=document.querySelector('#openwebrx-panel-receiver').getBoundingClientRect().top+1),'waterfall space reserved');
        await loadScreenshotPlugin(page);
        await page.waitForTimeout(600);
        const record=page.locator('#k2aam-dock .openwebrx-record-button');
        check(await record.evaluate(n=>n.scrollWidth<=n.clientWidth+1),'Screenshot plugin cannot clip the RIG Record label');
        check(await page.locator('#screenshot-btn').count()===1,'Screenshot plugin keeps one working PIC control');
        await page.locator('#k2aam-dock #screenshot-btn').waitFor({state:'visible'});
        const screenshotDownload=page.waitForEvent('download');await page.locator('#k2aam-dock #screenshot-btn').click();
        const shot=await screenshotDownload,shotBytes=fs.readFileSync(await shot.path());
        check(shotBytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&await page.evaluate(()=>screenshotCalls===1),'the retained upstream PIC handler downloads one PNG');
        await page.evaluate(()=>{ws.antennaSupported=false;ws.send(JSON.stringify({type:'getantenna'}));});
        await page.waitForFunction(()=>document.querySelector('.rd-antennas').hidden);
        for(const [width,height] of [[1918,900],[1024,768],[390,844],[375,667]]) {
            await page.setViewportSize({width,height});
            // Phones start compact; these controls live behind the Controls toggle.
            if(width<=620)await page.evaluate(()=>{const b=document.querySelector('#k2aam-dock .rd-expand');if(b.getAttribute('aria-expanded')==='false')b.click();});
            await page.waitForTimeout(550);
            check(await page.evaluate(()=>{
                const nodes=[document.querySelector('#k2aam-dock .openwebrx-record-button'),document.querySelector('#k2aam-dock #screenshot-btn'),document.querySelector('[aria-controls="rd-popover-more"]')];
                const rects=nodes.map(n=>n.getBoundingClientRect());
                return nodes.every((n,i)=>n.scrollWidth<=n.clientWidth+1&&rects[i].left>=0&&rects[i].right<=innerWidth+1)&&rects.every((r,i)=>!i||r.left>=rects[i-1].right+4);
            }),`Record, Screenshot and More fit without overlap without antenna controls ${width}×${height}`);
            if(width===1918)await page.locator('#openwebrx-panel-receiver').screenshot({path:path.join(root,'test-results/rig-screenshot-fix-desktop.png')});
            if(width===390)await page.locator('#openwebrx-panel-receiver').screenshot({path:path.join(root,'test-results/rig-screenshot-fix-mobile.png')});
        }
        await page.setViewportSize({width:1440,height:900});
        await page.evaluate(()=>{ws.antennaSupported=true;ws.send(JSON.stringify({type:'getantenna'}));});
        await page.waitForFunction(()=>!document.querySelector('.rd-antennas').hidden);
        const keyboardScreenshot=page.waitForEvent('download');
        await page.locator('#k2aam-dock #screenshot-btn').focus();await page.locator('#k2aam-dock #screenshot-btn').press('Enter');
        await keyboardScreenshot;
        check(await page.evaluate(()=>screenshotCalls===2),'Screenshot remains keyboard accessible without duplicate downloads');
        const early=await browser.newPage({viewport:{width:1024,height:768}});
        let releaseEarlyStyle,styleQueued;
        const earlyStyleRequest=new Promise(resolve=>{styleQueued=resolve;});
        await early.route('**/k2aam_dock.css?*',async route=>{await new Promise(resolve=>{releaseEarlyStyle=resolve;styleQueued();});await route.continue();});
        await early.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
        await earlyStyleRequest;await loadScreenshotPlugin(early);
        check(await early.evaluate(()=>!document.getElementById('k2aam-dock')&&!!originalScreenshot),'Screenshot can initialize before the dock mounts');
        releaseEarlyStyle();await early.waitForSelector('#k2aam-dock #screenshot-btn');
        check(await early.evaluate(()=>document.querySelector('#k2aam-dock #screenshot-btn')===originalScreenshot),'early PIC initialization retains the original handler node');
        const earlyDownload=early.waitForEvent('download');await early.locator('#k2aam-dock #screenshot-btn').click();await earlyDownload;
        check(await early.evaluate(()=>screenshotCalls===1),'an early-loaded Screenshot plugin works after adoption');
        await early.evaluate(()=>Plugins.k2aam_dock.destroy(false));
        check(await early.evaluate(()=>document.getElementById('screenshot-btn')===originalScreenshot&&!originalScreenshot.closest('#k2aam-dock')&&originalScreenshot.textContent==='PIC'),'stock fallback restores the original PIC node and label');
        const stockShot=early.waitForEvent('download');await early.locator('#screenshot-btn').click();await stockShot;
        check(await early.evaluate(()=>screenshotCalls===2),'stock PIC handler still works after dock teardown');
        // Keep this auxiliary page until browser teardown for single-process Chromium.
        await page.bringToFront();
        if(process.argv.includes('--screenshot-only')) { console.log(`${checks} Screenshot compatibility checks passed.`); return; }

        await record.click();
        check(await page.evaluate(()=>audioEngine.recording),'dock starts native recording through the visible recording control');
        check(await record.getAttribute('aria-pressed')==='true','recording state is shown immediately');
        check(await record.evaluate(n=>n.scrollWidth<=n.clientWidth+1),'active recording label fits with Screenshot loaded');
        await page.evaluate(()=>{
            const samples=new Int16Array(24000);
            for(let i=0;i<samples.length;i++)samples[i]=Math.round(6000*Math.sin(2*Math.PI*1000*i/12000));
            audioEngine.recorder.record([samples]);
        });
        const downloaded=page.waitForEvent('download');await record.click();
        const recording=await downloaded,bytes=fs.readFileSync(await recording.path());
        check(bytes.length>1000&&bytes[0]===255&&(bytes[1]&224)===224,'stopping native recording downloads MP3-encoded samples');
        check(/^REC-.*\.mp3$/.test(recording.suggestedFilename()),'native recording filename is retained');
        check(await page.evaluate(()=>!audioEngine.recording),'stop clears native recording state');
        await page.evaluate(()=>{ws.reply({type:'config',value:{allow_audio_recording:false}});UI.toggleRecording(true);});
        check(await record.isHidden()&&await page.evaluate(()=>!audioEngine.recording),'server recording permission still applies');
        check(await page.locator('#k2aam-dock #screenshot-btn').isVisible(),'Screenshot remains available when audio recording is disabled');
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
        await page.evaluate(()=>{
            const node=document.querySelector('.webrx-actual-freq');
            node.innerHTML='<span class="digit">7</span>.074000 MHz';
            node.addEventListener('click',()=>window.nativeFrequencyClick=true,{once:true});
        });
        await page.locator('.webrx-actual-freq .digit').click();
        check(await page.locator('#rd-popover-tune').isVisible()&&!await page.evaluate(()=>!!window.nativeFrequencyClick),'clicking a native frequency digit opens one RIG frequency editor');
        await page.getByLabel('Frequency units',{exact:true}).selectOption('kHz');
        await page.getByLabel('Frequency with units',{exact:true}).fill('7074');
        await page.locator('#rd-popover-tune').getByRole('button',{name:'Tune',exact:true}).click();
        await page.waitForFunction(()=>UI.getFrequency()===7074000);
        check(await page.evaluate(()=>UI.getFrequency()===7074000),'explicit unit selection tunes a unitless number correctly');
        await page.locator('[aria-controls="rd-popover-bandpass"]').click();
        await page.locator('#rd-popover-bandpass input').nth(0).fill('-2700');await page.locator('#rd-popover-bandpass input').nth(1).fill('-200');
        await page.getByRole('button',{name:'Apply',exact:true}).click();
        check(await page.evaluate(()=>UI.getDemodulator().low_cut===-2700&&UI.getDemodulator().high_cut===-200),'receive bandpass applies');
        check(await page.locator('[aria-controls="rd-popover-audio"]').count()===0,'dock has no audio filter control');

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
        await page.getByLabel('Frequency units',{exact:true}).selectOption('MHz');
        await page.locator('.rd-tune-form input').fill('7.128');await page.locator('.rd-tune-form button').click();
        check(await page.evaluate(()=>UI.getFrequency()===7128000),'a unitless frequency uses the selected MHz scale');
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
        check(await page.evaluate(()=>savedDecoderNodes.every(node=>node.parentElement.id==='k2aam-decoder-body')),'all native decoder panel nodes are retained in one tray');
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
                return node&&node.parentElement.id==='k2aam-decoder-body'&&node.style.display!=='none'&&
                    !document.getElementById('k2aam-decoder-tray').hidden;
            },suffix,{timeout:10000,polling:50}).catch(async error=>{
                console.error('Decoder mode failed:',mode,suffix,await page.evaluate(suffix=>{
                    const node=document.getElementById('openwebrx-panel-'+suffix);
                    return {mode:UI.getModulation(),node:node&&{style:node.getAttribute('style'),classes:node.className,parent:node.parentElement.id,movement:node.movement},tray:document.getElementById('k2aam-decoder-tray').outerHTML.slice(0,500)};
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
        await page.evaluate(()=>{
            ws.logEvents=Array.from({length:205},(_,i)=>({log_id:i+1,source_id:'sdrplay',timestamp:1792962000000+i,freq:11226000,source:'ADW',destination:'',event:'amd',message:i===0?'=SUM(1,2)':'Radio "text", line\nnext',bank:'hfgcs_candidates'}));
            ws.logStations=[{address:'ADW',timestamp:1792962000204,count:204,frequencies:[11226000,15043000]},
                {address:'<img src=x onerror=alert(1)>',timestamp:1792962000000,count:1,frequencies:[5708000]}];
        });
        check(await page.getByRole('button',{name:'Export CSV',exact:true}).isHidden(),'log tools stay behind the Log disclosure until opened');
        await page.locator('.ale-log > summary').click();
        await page.getByRole('button',{name:'Refresh log',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('.ale-log-status').textContent.includes('205'));
        await page.locator('.ale-heard > summary').click();
        check(await page.locator('.ale-heard-list').innerText().then(s=>s.includes('ADW')&&s.includes('15043.0')&&s.includes('204 decodes')),'stations heard shows aggregated source addresses, channels and counts');
        check(await page.locator('.ale-heard-list img').count()===0,'station summary escapes received addresses');
        const csvDownloadPromise=page.waitForEvent('download');
        await page.getByRole('button',{name:'Export CSV',exact:true}).click();
        const csvDownload=await csvDownloadPromise;
        const csvText=fs.readFileSync(await csvDownload.path(),'utf8');
        check(csvDownload.suggestedFilename().endsWith('.csv')&&csvText.includes('Frequency_Hz'),'CSV download has frequency units and column headers');
        check(csvText.includes('"' + "'=SUM(1,2)" + '"')&&csvText.includes('Radio ""text"", line'),'CSV quotes radio text and neutralizes spreadsheet formulas');
        check(await page.evaluate(()=>ws.sent.filter(p=>p.type==='ale_scan'&&p.params.action==='export').length)===2,'CSV export downloads every retained page');
        await page.locator('#k2aam-decoder-tray').getByRole('button',{name:'Clear',exact:true}).click();
        check(await page.locator('.ale-heard-list li').count()===2,'Clear removes displayed messages without erasing the durable station summary');
        await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);
        check(await page.locator('#openwebrx-panel-ale2g-message').evaluate(n=>n.scrollWidth<=n.clientWidth+1),'heard stations and CSV controls fit phone width');
        await page.screenshot({path:path.join(root,'test-results/ale-heard-mobile.png')});
        await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(150);
        await page.screenshot({path:path.join(root,'test-results/ale-heard-desktop.png')});
        await page.locator('.ale-heard > summary').click();
        await page.evaluate(()=>{ws.logFailure=true;});
        await page.getByRole('button',{name:'Refresh log',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('.ale-log-status').textContent.includes('unavailable'));
        check(await page.evaluate(()=>!alePanel.serverScanner.pending),'log failures do not change scanner control state');
        await page.evaluate(()=>{ws.logFailure=false;});

        await page.locator('#k2aam-decoder-tray').getByRole('button',{name:'Clear',exact:true}).click();
        check(await page.locator('#openwebrx-panel-ale2g-message tbody tr').count()===0,'ALE output uses the shared Clear action');
        await page.evaluate(()=>{
            for (const [source,freq] of [['ADW',15043000],['JNR',11226000],['OFF',5708000]])
                alePanel.pushMessage({mode:'ALE2G',timestamp:Date.now(),freq,source,destination:'',event:'sounding_this_was',message:`[Sounding THIS WAS] [From: ${source}]`});
        });
        const sounding=page.locator('#openwebrx-panel-ale2g-message tbody tr').last();
        check(await sounding.locator('td').nth(2).innerText()==='OFF'&&await sounding.locator('td').nth(3).innerText()==='—','sounding keeps the literal OFF address with no invented destination');
        check(await sounding.innerText().then(t=>t.includes('Sounding · TWS')&&!t.includes('[From: OFF]')),'sounding summary avoids repeating raw protocol fields');
        await sounding.getByText('Raw decode',{exact:true}).click();
        check(await sounding.locator('pre').innerText()==='[Sounding THIS WAS] [From: OFF]','original sounding remains available in raw details');
        await sounding.getByText('Raw decode',{exact:true}).click();
        check(await page.evaluate(()=>{
            const head=[...document.querySelectorAll('#openwebrx-panel-ale2g-message th')];
            const cells=[...document.querySelector('#openwebrx-panel-ale2g-message tbody tr').children];
            return head.every((th,i)=>Math.abs(th.getBoundingClientRect().left-cells[i].getBoundingClientRect().left)<1);
        }),'all ALE column headings align with their data');
        await page.evaluate(()=>{document.querySelector('.ale-log').open=true;});
        await page.getByLabel('ALE addresses to watch').fill('jnr, zz*');
        check(await page.evaluate(()=>[...document.querySelectorAll('#openwebrx-panel-ale2g-message tbody tr')].map(r=>r.children[2].textContent+':'+r.classList.contains('ale-watched')).join()==='ADW:false,JNR:true,OFF:false'),'watchlist highlights matching addresses only');
        await page.getByLabel('Show only watched ALE addresses').check();
        check(await page.locator('#openwebrx-panel-ale2g-message tbody tr:visible').count()===1,'Only watched hides other decodes without deleting them');
        await page.evaluate(()=>alePanel.pushMessage({mode:'ALE2G',timestamp:Date.now(),freq:8992000,source:'ZZ9',destination:'',event:'sounding_this_was',message:'[Sounding THIS WAS] [From: ZZ9]'}));
        check(await page.locator('#openwebrx-panel-ale2g-message tbody tr:visible').count()===2,'a new decode from a watched wildcard address is shown and highlighted');
        await page.evaluate(()=>document.querySelector('#openwebrx-panel-ale2g-message tbody tr:last-child').remove());
        await page.getByLabel('Show only watched ALE addresses').uncheck();
        await page.getByLabel('ALE addresses to watch').fill('');
        check(await page.evaluate(()=>document.querySelectorAll('#openwebrx-panel-ale2g-message tbody tr.ale-watched').length===0&&JSON.parse(localStorage.getItem('owrx_ale_watch_v1')).list===''),'clearing the watchlist removes highlights and is remembered');
        await page.evaluate(()=>{document.querySelector('.ale-log').open=false;});
        await page.getByRole('button',{name:'Fit',exact:true}).click();
        // Fit starts enabled on a fresh browser; exercise toggling back on explicitly.
        if(await page.getByRole('button',{name:'Fit',exact:true}).getAttribute('aria-pressed')==='false') await page.getByRole('button',{name:'Fit',exact:true}).click();
        await page.screenshot({path:path.join(root,'test-results/ale-compact-desktop.png')});
        const compactHeight=await page.locator('#k2aam-decoder-tray').evaluate(n=>n.getBoundingClientRect().height);
        check(compactHeight<340,'Fit bounds a few ALE rows instead of reserving a large empty pane');
        await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);
        check(await page.locator('#openwebrx-panel-ale2g-message').evaluate(n=>n.scrollWidth<=n.clientWidth+1),'ALE rows fit the phone width');
        const phoneRow=page.locator('#openwebrx-panel-ale2g-message tbody tr').first();
        check(await phoneRow.evaluate(n=>n.getBoundingClientRect().height<36&&n.children[2].textContent==='ADW'&&n.children[4].getBoundingClientRect().width>0),'a phone ALE sounding is one line with time, frequency, addresses and event');
        await phoneRow.locator('td').first().click();
        check(await phoneRow.locator('td.message').isVisible(),'tapping a phone ALE row opens its description and raw decode');
        await phoneRow.locator('td').first().click();
        await page.screenshot({path:path.join(root,'test-results/ale-compact-mobile.png')});
        await page.setViewportSize({width:1440,height:900});
        await page.locator('#k2aam-decoder-tray').getByRole('button',{name:'Clear',exact:true}).click();
        await page.locator('.ale-scan-controls > summary').click();
        check(await page.getByLabel('Run scanner on server').count()===0&&await page.evaluate(()=>typeof AleScanController==='undefined'),'scanning always runs on the server; the browser scanner is gone');
        check(await page.getByRole('button',{name:'Start ALE scan',exact:true}).isVisible(),'ALE scanner controls are visible in tray');
        check(await page.getByLabel('Scan across HF bands').isChecked()===false,'scanning outside the current view is opt-in');
        await page.getByRole('button',{name:'Start ALE scan',exact:true}).click();
        await page.waitForFunction(()=>alePanel.serverScanner.running);
        check(await page.evaluate(()=>{const p=ws.sent.filter(p=>p.type==='ale_scan'&&p.params.action==='start').pop().params;return p.across===false&&p.channels.length>1;}),'Start asks the server to watch the selected bank channels');
        check(await page.locator('.ale-scan-status').innerText().then(s=>/Watching \d+ channels/.test(s)),'status shows channels being watched together');
        check(await page.evaluate(()=>owrxAleScanner.isRunning()&&!owrxAleScanner.blocksManual()),'a scan of the current view does not block manual tuning');
        await page.evaluate(()=>UI.setModulation('usb'));
        await page.waitForFunction(()=>UI.getModulation()==='usb'&&UI.getDemodulator());
        await page.evaluate(()=>{UI.setFrequency(7150000,false);alePanel.serverScanner.poll();});
        await page.waitForTimeout(80);
        const listening=await page.evaluate(()=>({f:UI.getFrequency(),m:UI.getModulation(),r:ws.scanState.running,s:document.querySelector('.ale-scan-status').textContent}));
        check(listening.f===7150000&&listening.m==='usb'&&listening.r,'the listener can tune elsewhere while the server keeps watching '+JSON.stringify(listening));
        await page.evaluate(()=>UI.setModulation('ale2g'));
        await page.evaluate(()=>alePanel.pushMessage({mode:'ALE2G',freq:7102000,event:'activity',active:true}));
        check(await page.locator('#openwebrx-panel-ale2g-message tbody tr').count()===0,'activity events do not create message rows');
        await page.getByRole('button',{name:'Stop',exact:true}).click();
        await page.waitForFunction(()=>!alePanel.serverScanner.running&&!alePanel.serverScanner.pending);
        check(await page.evaluate(()=>!ws.scanState.running),'ALE Stop stops the server scan');
        await page.getByLabel('ALE scan bank').selectOption('cothen_candidates');
        await page.evaluate(()=>ws.reply({type:'config',value:{center_freq:7100000,start_offset_freq:0,start_mod:'usb'}}));
        await page.waitForTimeout(150);
        await page.evaluate(()=>UI.setModulation('ale2g'));
        await page.getByLabel('Scan across HF bands').check();
        await page.getByRole('button',{name:'Start ALE scan',exact:true}).click();
        await page.waitForFunction(()=>alePanel.serverScanner.running);
        check(await page.evaluate(()=>owrxAleScanner.blocksManual()),'a scan that retunes the SDR must stop before manual tuning');
        await page.evaluate(()=>{
            ws.scanState={...ws.scanState,sequence:1,events:[{mode:'ALE2G',freq:5250000,timestamp:Date.now(),source:'ADW',event:'sounding_this_was',message:'SERVER TEST',server_scan:true,scan_seq:1}]};
            alePanel.serverScanner.poll();
        });
        await page.waitForFunction(()=>document.querySelectorAll('#openwebrx-panel-ale2g-message tbody tr').length===1);
        await page.evaluate(()=>alePanel.serverScanner.poll());await page.waitForTimeout(50);
        check(await page.locator('#openwebrx-panel-ale2g-message tbody tr').count()===1,'server history is deduplicated by sequence');
        await page.evaluate(()=>{
            const first={mode:'ALE2G',freq:5250000,timestamp:Date.now(),source:'JNR',destination:'',event:'sounding_this_was',message:'REPEAT',server_scan:true,uid:'fixture-1'};
            ws.scanState={...ws.scanState,sequence:2,events:[...ws.scanState.events,{...first,repeats:1,scan_seq:2}]};alePanel.serverScanner.poll();
        });
        await page.waitForFunction(()=>document.querySelectorAll('#openwebrx-panel-ale2g-message tbody tr').length===2);
        await page.evaluate(()=>{
            const events=ws.scanState.events.filter(e=>e.uid!=='fixture-1');
            ws.scanState={...ws.scanState,sequence:3,events:[...events,{mode:'ALE2G',freq:5250000,timestamp:Date.now(),timestamp_last:Date.now(),source:'JNR',destination:'',event:'sounding_this_was',message:'REPEAT',server_scan:true,uid:'fixture-1',repeats:4,scan_seq:3}]};
            alePanel.serverScanner.poll();
        });
        await page.waitForFunction(()=>document.querySelector('#openwebrx-panel-ale2g-message tbody tr:last-child .ale-repeats').textContent.includes('×4'));
        check(await page.locator('#openwebrx-panel-ale2g-message tbody tr').count()===2,'a repeated server decode updates its row count instead of adding rows');
        await page.evaluate(()=>{ws.scanState={...ws.scanState,events:ws.scanState.events.filter(e=>e.uid!=='fixture-1')};document.querySelector('#openwebrx-panel-ale2g-message tbody tr:last-child').remove();});
        const stopsBefore=await page.evaluate(()=>ws.sent.filter(p=>p.type==='ale_scan'&&p.params.action==='stop').length);
        await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
        check(await page.evaluate(()=>ws.scanState.running),'closing/hiding a tab does not stop the server worker');
        check(await page.evaluate(()=>ws.sent.filter(p=>p.type==='ale_scan'&&p.params.action==='stop').length)===stopsBefore,'pagehide sends no server stop request');
        // A discarded mobile document loses its in-memory following flag.
        // Recreate the controller with AM selected, retaining only tab storage.
        const startsBefore=await page.evaluate(()=>ws.sent.filter(p=>p.type==='ale_scan'&&p.params.action==='start').length);
        await page.evaluate(()=>{
            const old=alePanel.serverScanner;
            UI.setModulation('am');
            alePanel.serverScanner=new AleServerScanClient(old.status,old.event,old.reset);
            window.dispatchEvent(new Event('pageshow'));
        });
        await page.waitForFunction(()=>UI.getModulation()==='ale2g'&&alePanel.serverScanner.running);
        check(await page.evaluate(()=>UI.getFrequency()===5250000),'a fresh mobile observer rejoins the running ALE scan after the profile defaults to AM');
        check(await page.evaluate(()=>ws.sent.filter(p=>p.type==='ale_scan'&&p.params.action==='start').length)===startsBefore,'mobile return observes the existing worker without starting another scan');
        await page.locator('[aria-controls="rd-popover-mode"]').click();
        await page.getByLabel('Search modes',{exact:true}).fill('');
        await page.locator('#rd-popover-mode [data-mode="usb"]').click();
        await page.waitForFunction(()=>!alePanel.serverScanner.running&&UI.getModulation()==='usb');
        check(await page.evaluate(()=>!ws.scanState.running),'choosing a RIG mode waits for server scanner Stop');
        check(await page.evaluate(()=>sessionStorage.getItem('owrx_ale_observer_v1:sdrplay')===null),'manual mode takeover clears mobile scan-following intent');
        await page.evaluate(()=>alePanel.serverScanner.poll());await page.waitForTimeout(50);
        check(await page.evaluate(()=>UI.getModulation()==='usb'),'later scanner status does not pull manual mode back to ALE');
        const savedScan = await page.evaluate(()=>JSON.parse(localStorage.getItem('owrx_ale_scan_preferences_v1')).sdrplay);
        check(savedScan.bank==='cothen_candidates'&&savedScan.across,'scan bank and scope are saved per receiver in this browser');
        await page.evaluate(()=>UI.setModulation('ale2g'));
        await page.locator('#k2aam-decoder-tray').getByRole('button',{name:'Clear',exact:true}).click();
        await page.evaluate(()=>ws.reply({type:'config',value:{center_freq:7100000,start_mod:'usb'}}));
        await page.waitForTimeout(150);
        await page.evaluate(()=>UI.setModulation('ft8'));
        await page.waitForFunction(()=>!document.getElementById('k2aam-decoder-tray').hidden);
        await page.evaluate(()=>{
            const panel=$('#openwebrx-panel-wsjt-message').wsjtMessagePanel();
            window.savedWsjt=panel;
            for(let i=0;i<30;i++)panel.pushMessage({mode:'FT8',timestamp:Date.now(),db:-14,dt:.2,freq:7074000+i,msg:'CQ K2AAM FN33'});
        });
        check(await page.locator('#openwebrx-panel-wsjt-message a[href="https://www.qrz.com/db/K2AAM"]').count()===30,'native decoded callsign links survive moving the panel');
        check(await page.locator('#openwebrx-panel-wsjt-message tbody').evaluate(n=>n.scrollHeight>n.clientHeight),'decoder messages scroll inside the bounded pane');
        const originalHeight=(await page.locator('#k2aam-decoder-tray').boundingBox()).height;
        await page.getByRole('slider',{name:'Decoder pane height',exact:true}).fill('55');
        check((await page.locator('#k2aam-decoder-tray').boundingBox()).height>originalHeight,'decoder height can be adjusted');
        check(await page.evaluate(()=>{
            const tray=document.getElementById('k2aam-decoder-tray').getBoundingClientRect();
            const dock=document.getElementById('openwebrx-panel-receiver').getBoundingClientRect();
            return document.getElementById('webrx-page-container').getBoundingClientRect().bottom<=tray.top+1&&tray.bottom<=dock.top+1;
        }),'decoder tray reserves waterfall space directly above the K2AAM Dock');
        await page.locator('#k2aam-decoder-tray').getByRole('button',{name:'Collapse',exact:true}).click();
        check(await page.locator('#k2aam-decoder-body').isHidden(),'decoder tray collapses without hiding native panel state');
        await page.evaluate(()=>savedWsjt.pushMessage({mode:'FT8',timestamp:Date.now(),db:-9,dt:.1,freq:7074000,msg:'CQ K2AAM FN33'}));
        check(await page.locator('#openwebrx-panel-wsjt-message tbody tr').count()===31&&await page.evaluate(()=>UI.getModulation()==='ft8'),'decoding continues while the tray is collapsed');
        await page.locator('#k2aam-decoder-tray').getByRole('button',{name:'Expand',exact:true}).click();
        check(await page.evaluate(()=>savedWsjt===$('#openwebrx-panel-wsjt-message').wsjtMessagePanel()),'expand keeps the native message handler instance');
        await page.locator('#k2aam-decoder-tray').getByRole('button',{name:'Clear',exact:true}).click();
        check(await page.locator('#openwebrx-panel-wsjt-message tbody tr').count()===0,'tray Clear invokes the native decoder Clear handler');
        const ifToggle=page.locator('#k2aam-decoder-tray').getByRole('button',{name:'IF waterfall',exact:true});
        await ifToggle.click();
        check(await page.locator('#openwebrx-digimode-canvas-container').isHidden()&&await ifToggle.isVisible(),'decoder waterfall can be hidden and its toggle remains available');
        await ifToggle.click();
        check(await page.locator('#openwebrx-digimode-canvas-container').isVisible(),'decoder waterfall can be restored');
        await page.evaluate(()=>{UI.setModulation('rtty');secondary_demod_push_data('RTTY TEST <decoded>\n');});
        await page.waitForFunction(()=>document.getElementById('k2aam-decoder-tray').dataset.text==='true');
        check(await page.locator('#openwebrx-digimode-content').innerText().then(s=>s.replace(/\s/g,' ').includes('RTTY TEST <decoded>')),'native text decoder appends escaped output in the tray');
        await page.locator('#k2aam-decoder-tray').getByRole('button',{name:'Clear',exact:true}).click();
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
        await page.locator('#k2aam-decoder-tray').getByRole('button',{name:'Collapse',exact:true}).click();
        await page.evaluate(()=>{
            $('#openwebrx-panel-sstv-message').sstvMessagePanel().pushMessage({width:16,height:8,line:1,pixels:btoa('\x00\xff\x00'.repeat(16))});
            UI.setModulation('lsb');
        });
        await page.waitForSelector('#k2aam-decoder-tray',{state:'hidden'});
        check(await page.evaluate(()=>savedSstvCanvas.getContext('2d').getImageData(0,1,1,1).data[1]===255),'image decoding continues while the tray is collapsed');
        check(await page.evaluate(()=>savedDecoderNodes.every(node=>node.style.display==='none'&&!node.movement)),'switching to an analog mode settles all native collapse states');
        await page.evaluate(()=>UI.setModulation('fax'));
        await page.waitForSelector('#k2aam-decoder-tray',{state:'visible'});
        check(await page.locator('#k2aam-decoder-body').isHidden(),'collapsed preference survives switching decoder types');
        await page.locator('#k2aam-decoder-tray').getByRole('button',{name:'Expand',exact:true}).click();
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
        await page.waitForFunction(()=>futureDecoder.parentElement.id==='k2aam-decoder-body');
        check(await page.locator('#future-decoder').isVisible(),'new decoder panels are adopted without a hard-coded mode list');
        await page.evaluate(()=>{futureDecoder.remove();UI.setModulation('ft8');
            savedWsjt.pushMessage({mode:'FT8',timestamp:Date.now(),db:-14,dt:.2,freq:7074000,msg:'CQ K2AAM FN33'});});
        await page.getByRole('slider',{name:'Decoder pane height',exact:true}).fill('28');
        await page.waitForFunction(()=>document.querySelector('[aria-controls="rd-popover-mode"]').textContent.includes('FT8'));
        await page.screenshot({path:path.join(root,'test-results/k2aam-dock-desktop.png')});
        for(const [width,height] of [[1024,768],[390,844],[375,667],[844,390]]){
            await page.setViewportSize({width,height});await page.waitForTimeout(150);
            if(width===390){
                await page.evaluate(()=>{localStorage.removeItem('k2aam_dock_decoder_if');localStorage.removeItem('k2aam_dock_expanded');});
                await page.reload();await page.waitForSelector('#k2aam-dock');
                check(await page.evaluate(()=>document.querySelector('#k2aam-dock .rd-expand').getAttribute('aria-expanded')==='false'&&
                    ['.rd-profiles','.rd-actions','[aria-controls="rd-popover-bandpass"]'].every(q=>document.querySelector('#k2aam-dock '+q).getBoundingClientRect().height===0)),'phone dock starts compact');
                check(await page.evaluate(()=>['.rd-frequency .webrx-actual-freq','.rd-meter #openwebrx-smeter','[aria-controls="rd-popover-mode"]','.rd-volume','.rd-footer'].every(q=>document.querySelector('#k2aam-dock '+q).getBoundingClientRect().height>0)),'compact dock keeps frequency, S-meter, mode, volume and status');
                const compactDock=await page.locator('#openwebrx-panel-receiver').evaluate(n=>n.getBoundingClientRect().height);
                check(compactDock<=190,'compact phone dock is at most 190 px tall ('+Math.round(compactDock)+')');
                check(await page.locator('#k2aam-dock .rd-nudge').evaluateAll(nodes=>nodes.length===2&&nodes.every(n=>{const r=n.getBoundingClientRect();return r.width>=44&&r.height>=44&&r.left>=0&&r.right<=innerWidth;})),'step buttons are full-size touch targets');
                const beforeNudge=await page.evaluate(()=>UI.getFrequency());
                await page.getByRole('button',{name:'Tune up one step',exact:true}).click();
                check(await page.evaluate(before=>UI.getFrequency()===before+tuning_step,beforeNudge),'step button tunes one step');
                await page.getByRole('button',{name:'Tune down one step',exact:true}).click();
                await page.getByRole('button',{name:'Tune down one step',exact:true}).dispatchEvent('pointerdown',{button:0});
                await page.waitForTimeout(900);
                await page.getByRole('button',{name:'Tune down one step',exact:true}).dispatchEvent('pointerup');
                const heldSteps=await page.evaluate(before=>(before-UI.getFrequency())/tuning_step,beforeNudge);
                check(heldSteps>=2,'holding a step button keeps tuning ('+heldSteps+' steps)');
                await page.waitForTimeout(300);
                check(await page.evaluate(expected=>UI.getFrequency()===expected,beforeNudge-heldSteps*100),'releasing the step button stops tuning');
                await page.evaluate(before=>UI.setFrequency(before,false),beforeNudge);
                await page.screenshot({path:path.join(root,'test-results/k2aam-dock-mobile-compact.png')});
                await page.locator('#k2aam-dock .rd-expand').click();
                check(await page.locator('#k2aam-dock .openwebrx-record-button').isVisible()&&await page.locator('#k2aam-dock .rd-profiles select').isVisible(),'Controls reveals the full phone dock');
                check(await page.evaluate(()=>document.querySelector('.rd-nudge')&&getComputedStyle(document.querySelector('.rd-expand')).display!=='none'),'toggle remains available when expanded');
                await page.evaluate(()=>{UI.setModulation('ft8');
                    $('#openwebrx-panel-wsjt-message').wsjtMessagePanel().pushMessage({mode:'FT8',timestamp:Date.now(),db:-14,dt:.2,freq:7074000,msg:'CQ K2AAM FN33'});});
                await page.waitForSelector('#k2aam-decoder-tray',{state:'visible'});
                check(await page.locator('#openwebrx-digimode-canvas-container').isHidden(),'phone defaults to full-width decoder results with an optional IF view');
            }
            check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`no horizontal overflow ${width}×${height}`);
            check(await page.evaluate(()=>document.querySelector('#webrx-page-container').getBoundingClientRect().bottom<=document.querySelector('#openwebrx-panel-receiver').getBoundingClientRect().top+1),`waterfall reserved ${width}×${height}`);
            check(await page.evaluate(()=>{
                const tray=document.getElementById('k2aam-decoder-tray').getBoundingClientRect();
                return tray.left>=0&&tray.right<=innerWidth+1&&tray.top>=document.getElementById('webrx-canvas-background').getBoundingClientRect().top-1&&
                    tray.bottom<=document.getElementById('openwebrx-panel-receiver').getBoundingClientRect().top+1&&
                    document.getElementById('webrx-page-container').getBoundingClientRect().bottom<=tray.top+1;
            }),`decoder and main waterfall fit the viewport ${width}×${height}`);
            await page.locator('[aria-controls="rd-popover-mode"]').click();
            const bounds=await page.locator('#rd-popover-mode').boundingBox();
            check(bounds.x>=0&&bounds.x+bounds.width<=width+1&&bounds.y>=0&&bounds.y+bounds.height<=height+1,`popover inside viewport ${width}×${height}`);
            await page.keyboard.press('Escape');
            if(width===390)await page.screenshot({path:path.join(root,'test-results/k2aam-dock-mobile.png')});
        }
        // Landscape phone: compact single row by height.
        await page.setViewportSize({width:844,height:390});await page.waitForTimeout(150);
        await page.locator('#k2aam-dock .rd-expand').click();await page.waitForTimeout(250);
        const landscape=await page.evaluate(()=>({dock:document.getElementById('openwebrx-panel-receiver').getBoundingClientRect().height,
            record:document.querySelector('#k2aam-dock .openwebrx-record-button').getBoundingClientRect().height,
            nudges:[...document.querySelectorAll('#k2aam-dock .rd-nudge')].every(n=>n.getBoundingClientRect().width>=40),
            overflow:document.documentElement.scrollWidth>innerWidth+1}));
        check(landscape.dock<=110&&landscape.record===0&&landscape.nudges&&!landscape.overflow,'landscape phone dock is one compact row with step buttons '+JSON.stringify(landscape));
        await page.screenshot({path:path.join(root,'test-results/k2aam-dock-landscape.png')});
        await page.locator('#k2aam-dock .rd-expand').click();
        await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(250);
        check(await page.evaluate(()=>{const m=document.querySelector('#k2aam-dock .rd-main .rd-meter #openwebrx-smeter').getBoundingClientRect(),f=document.querySelector('#k2aam-dock .rd-frequency').getBoundingClientRect();
            return m.width>=60&&m.height>=10&&m.left>=f.right&&Math.abs((m.top+m.bottom)/2-(f.top+f.bottom)/2)<24&&!document.querySelector('.rd-footer #openwebrx-smeter');}),'S-meter sits beside the frequency on desktop');
        check(await page.evaluate(()=>['.openwebrx-mute-button','.openwebrx-squelch-auto','.openwebrx-nr-toggle'].every(q=>{const n=document.querySelector('#k2aam-dock '+q),r=n.getBoundingClientRect(),c=getComputedStyle(n);return Math.round(r.width)===30&&Math.round(r.height)===30&&c.borderTopWidth==='1px';})),'native mute, squelch and NR buttons match the dock button style');
        // Bands
        await page.evaluate(()=>{UI.setModulation('usb');center_freq=7100000;UI.getDemodulatorPanel().setCenterFrequency(center_freq);});
        await page.waitForFunction(()=>!UI.getDemodulatorPanel().centerFreqTimeout&&UI.getDemodulator());
        await page.locator('[aria-controls="rd-popover-bands"]').click();
        check(await page.locator('#rd-popover-bands .rd-band').count()===20,'Bands lists amateur, broadcast and time-signal entries');
        await page.locator('#rd-popover-bands').getByRole('button',{name:'40m',exact:true}).click();
        check(await page.evaluate(()=>UI.getFrequency()===7150000&&UI.getModulation()==='lsb'&&document.getElementById('openwebrx-sdr-profiles-listbox').value==='sdrplay|40m'),'a band inside the current view tunes and sets its mode without changing profile');
        const changesBefore=await page.evaluate(()=>profilesChanged);
        await page.locator('[aria-controls="rd-popover-bands"]').click();
        await page.locator('#rd-popover-bands').getByRole('button',{name:'20m',exact:true}).click();
        check(await page.evaluate(before=>document.getElementById('openwebrx-sdr-profiles-listbox').value==='sdrplay|20m'&&profilesChanged===before+1&&ws.sent.filter(p=>p.type==='setfrequency'&&p.params.frequency===14200000).length===0,changesBefore),'a band outside the view selects the profile named for it instead of retuning the SDR');
        await page.evaluate(()=>{center_freq=14150000;UI.getDemodulatorPanel().setCenterFrequency(center_freq);});
        await page.waitForFunction(()=>UI.getFrequency()===14200000&&UI.getModulation()==='usb',{},{timeout:5000});
        check(true,'after the profile starts the dock lands on the band frequency and mode');
        await page.evaluate(()=>{window.k2aam_bandRequests=ws.sent.filter(p=>p.type==='setfrequency').length;});
        await page.locator('[aria-controls="rd-popover-bands"]').click();
        await page.locator('#rd-popover-bands').getByRole('button',{name:'MW',exact:true}).click();
        await page.waitForTimeout(200);
        check(await page.evaluate(()=>ws.sent.filter(p=>p.type==='setfrequency').length===k2aam_bandRequests+1&&ws.sent.filter(p=>p.type==='setfrequency').pop().params.frequency===1000000)||await page.locator('.rd-message').innerText().then(t=>/center frequency/i.test(t)),'a band with no matching profile falls back to the native retune request or explains why it cannot');
        await page.evaluate(()=>Plugins.k2aam_dock&&document.querySelector('.rd-tune-form')&&document.querySelectorAll('.rd-popover:not([hidden]) .rd-close').forEach(b=>b.click()));
        await page.waitForTimeout(150);
        await page.evaluate(()=>{const stop=[...document.querySelectorAll('#rd-popover-tune button')].find(b=>b.textContent==='Stop waiting');if(stop&&!stop.hidden)stop.click();
            const l=document.getElementById('openwebrx-sdr-profiles-listbox');l.value='sdrplay|40m';center_freq=7100000;UI.getDemodulatorPanel().setCenterFrequency(center_freq);});
        await page.waitForFunction(()=>!UI.getDemodulatorPanel().centerFreqTimeout&&UI.getDemodulator());
        // Bookmarks
        await page.evaluate(()=>{bookmarks.bookmarks={server:[{name:'<img src=x onerror="window.bookmarkXss=1">W1AW',frequency:7047500,modulation:'cw'},{name:'40m FT8',frequency:7074000,modulation:'usb'}],local:[{name:'40m FT8',frequency:7074000,modulation:'usb'},{name:'broken'}]};});
        await page.locator('[aria-controls="rd-popover-bookmarks"]').click();
        await page.waitForFunction(()=>document.querySelectorAll('#rd-popover-bookmarks .rd-bookmark').length===2);
        check(await page.evaluate(()=>!document.querySelector('#rd-popover-bookmarks img')&&!window.bookmarkXss&&document.querySelector('#rd-popover-bookmarks .rd-bookmark-name').textContent.includes('<img')),'bookmark names render as text; duplicates and malformed entries are dropped');
        await page.getByLabel('Search bookmarks').fill('ft8');
        await page.waitForFunction(()=>document.querySelectorAll('#rd-popover-bookmarks .rd-bookmark').length===1);
        await page.locator('#rd-popover-bookmarks .rd-bookmark').click();
        check(await page.evaluate(()=>UI.getFrequency()===7074000&&UI.getModulation()==='usb'&&!window.bookmarkXss&&document.getElementById('rd-popover-bookmarks').hidden),'choosing a bookmark tunes, sets its mode and closes the list');
        await page.evaluate(()=>{bookmarks.bookmarks={};UI.setModulation('ft8');});
        await page.evaluate(()=>{
            const node=document.createElement('div');node.className='openwebrx-panel openwebrx-message-panel';node.id='removed-decoder';
            document.getElementById('openwebrx-panels-container-left').append(node);window.removedDecoder=node;
        });
        await page.waitForFunction(()=>removedDecoder.parentElement.id==='k2aam-decoder-body');
        await page.evaluate(()=>removedDecoder.remove());
        await page.evaluate(()=>Plugins.k2aam_dock.destroy(true));
        check(await page.evaluate(()=>!document.body.classList.contains('k2aam-dock-active')),'stock controls restored');
        check(await page.evaluate(()=>savedSquelchNode===document.querySelector('.openwebrx-squelch-slider')&&!document.querySelector('#k2aam-dock')),'native nodes restored after destroy');
        check(await page.evaluate(()=>savedDecoderNodes.every(node=>node.parentElement===savedDecoderParents.get(node)&&!node.classList.contains('rd-decoder-native'))),'all native decoder panels return to their original parents');
        check(await page.locator('.webrx-actual-freq').getAttribute('role')===null,'stock frequency readout attributes are restored');
        check(await page.locator('#removed-decoder').count()===0,'teardown does not recreate a decoder removed by its owner');
        await page.getByRole('button',{name:'K2AAM Dock',exact:true}).click();await page.waitForSelector('#k2aam-dock');
        await page.reload();await page.waitForSelector('#k2aam-dock');
        await page.waitForFunction(()=>document.querySelector('[aria-label="ALE scan bank"]').value==='cothen_candidates');
        check(await page.getByLabel('Scan across HF bands').isChecked(),'saved scan selections restore after a page reload');
        check(await page.evaluate(()=>!window.owrxAleScanner.isRunning()),'restoring scan preferences does not start an unattended scan');
        // Interface chooser: dock by default, stock and the original RIG skin by choice.
        await page.locator('[aria-controls="rd-popover-more"]').click();
        check(await page.locator('#rd-popover-more #ui-select-listbox').inputValue()==='dock','interface chooser is reachable from the dock and shows the dock');
        await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),page.locator('#ui-select-listbox').selectOption('stock')]);
        await page.waitForFunction(()=>window.Plugins&&Plugins.ui_select&&Plugins.ui_select._script_loaded&&document.getElementById('ui-select-listbox'));
        await page.waitForTimeout(400);
        check(await page.evaluate(()=>!Plugins.k2aam_dock&&!Plugins.rig_skin&&!document.getElementById('k2aam-dock')&&!document.body.classList.contains('k2aam-dock-active')),'stock choice loads neither the dock nor the RIG skin');
        check(await page.evaluate(()=>savedProfileNode.parentElement.parentElement.id==='openwebrx-panel-receiver'&&document.getElementById('ui-select-listbox').value==='stock'),'stock choice leaves native controls in place with the chooser in settings');
        await page.evaluate(()=>UI.setModulation('ale2g'));
        await page.waitForFunction(()=>document.getElementById('openwebrx-panel-ale2g-message')&&document.getElementById('openwebrx-panel-ale2g-message').style.display!=='none');
        check(await page.locator('#openwebrx-panel-ale2g-message [aria-label="ALE scan bank"]').count()===1,'ALE plugin panel works with stock controls');
        await page.evaluate(()=>UI.setModulation('lsb'));
        await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),page.locator('#ui-select-listbox').selectOption('rig')]);
        await page.waitForFunction(()=>window.Plugins&&Plugins.rig_skin&&Plugins.rig_skin._script_loaded&&document.body.classList.contains('theme-rig'));
        check(await page.evaluate(()=>!Plugins.k2aam_dock&&!document.getElementById('k2aam-dock')&&document.getElementById('openwebrx-themes-listbox').value==='rig'),'RIG choice loads the pinned RIG skin and selects its theme without the dock');
        check(await page.evaluate(()=>Plugins.rig_skin._script_loaded.startsWith('static/plugins/receiver/rig_skin/')),'RIG skin is served from the local pinned copy');
        await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),page.evaluate(()=>Plugins.ui_select.choose('dock'))]);
        await page.waitForSelector('body.k2aam-dock-active');
        check(await page.evaluate(()=>!Plugins.rig_skin&&!document.body.classList.contains('theme-rig')&&UI.theme!=='rig'),'returning to the dock unloads the RIG skin and clears its theme');
        // Console layout: the same plugin arranged as a receiver strip with a side decoder panel.
        const con=await browser.newPage({viewport:{width:1440,height:900}});const conErrors=[];
        con.on('pageerror',e=>conErrors.push(e.message));
        await con.addInitScript(()=>{try{localStorage.setItem('ui_select_choice','console');}catch(e){}});
        await con.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
        await con.waitForSelector('body.k2aam-console.k2aam-dock-active:not(.k2aam-dock-loading)');
        await con.waitForSelector('.rd-antennas button');
        check(await con.evaluate(()=>Plugins.k2aam_dock.layout==='console'&&document.getElementById('ui-select-listbox').value==='console'&&document.getElementById('ui-select-listbox').options.length===4),'Console is a fourth interface choice and loads the dock plugin in its console layout');
        check(await con.evaluate(()=>{const f=document.querySelector('.rd-tuning .webrx-actual-freq').getBoundingClientRect(),m=document.querySelector('.rd-tuning .rd-meter #openwebrx-smeter').getBoundingClientRect();
            return parseFloat(getComputedStyle(document.querySelector('.rd-tuning .webrx-actual-freq')).fontSize)>=34&&m.top>=f.bottom-1&&m.width>=200;}),'console shows a large frequency with the S-meter directly beneath it');
        check(await con.evaluate(()=>['.rd-profiles select','.rd-volume .openwebrx-mute-button','#openwebrx-panel-volume','.rd-squelch .openwebrx-squelch-auto','.rd-squelch .openwebrx-squelch-slider','.rd-nr .openwebrx-nr-toggle','#openwebrx-panel-nr','.openwebrx-record-button','[aria-controls="rd-popover-bands"]'].every(q=>{const n=document.querySelector('#k2aam-dock '+q);if(!n)return false;const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth+1;})),'receiver strip shows profile, mute, volume, squelch, noise reduction, record and bands');
        check(await con.locator('#k2aam-dock .rd-nr .rd-label').innerText().then(t=>/noise reduction/i.test(t)),'noise reduction is labelled in the console strip');
        check(await con.evaluate(()=>!document.body.classList.contains('k2aam-side')&&Math.abs(document.body.getBoundingClientRect().width-innerWidth)<2),'with no decoder running the waterfall keeps the full width');
        await con.evaluate(()=>{UI.setModulation('ft8');const p=$('#openwebrx-panel-wsjt-message').wsjtMessagePanel();
            p.pushMessage({mode:'FT8',timestamp:Date.now(),db:-4,dt:.2,freq:7074812,msg:'CQ K2AAM FN33'});
            p.pushMessage({mode:'FT8',timestamp:Date.now(),db:-11,dt:.1,freq:7075340,msg:'K2AAM W1AW -09'});});
        await con.waitForSelector('#k2aam-decoder-tray.rd-side',{state:'visible'});
        await con.waitForTimeout(400);
        const sideGeometry=await con.evaluate(()=>{const t=document.getElementById('k2aam-decoder-tray').getBoundingClientRect(),d=document.getElementById('openwebrx-panel-receiver').getBoundingClientRect(),b=document.body.getBoundingClientRect(),w=document.getElementById('webrx-page-container').getBoundingClientRect();
            return {trayLeft:Math.round(t.left),trayRight:Math.round(t.right),trayTop:Math.round(t.top),trayBottom:Math.round(t.bottom),dockTop:Math.round(d.top),dockWidth:Math.round(d.width),body:Math.round(b.width),page:Math.round(w.right),inner:innerWidth};});
        check(sideGeometry.trayRight===sideGeometry.inner&&sideGeometry.trayTop===0&&Math.abs(sideGeometry.trayBottom-sideGeometry.dockTop)<=1&&sideGeometry.trayRight-sideGeometry.trayLeft>=340,'decoders open as a full-height panel on the right, above the strip '+JSON.stringify(sideGeometry));
        check(Math.abs(sideGeometry.body-sideGeometry.trayLeft)<=1&&sideGeometry.page<=sideGeometry.trayLeft+1&&sideGeometry.dockWidth===sideGeometry.inner,'the waterfall narrows to make room for the panel and the strip stays full width');
        check(await con.evaluate(()=>{const rows=[...document.querySelectorAll('#openwebrx-panel-wsjt-message tbody tr')];return rows.length===2&&rows[0].classList.contains('rd-cq')&&!rows[1].classList.contains('rd-cq');}),'CQ calls are highlighted in the FT8 list');
        check(await con.locator('.rd-decoder-tabs .rd-tab').evaluateAll(tabs=>tabs.map(t=>t.textContent+':'+t.getAttribute('aria-selected')).join()==='FT8:true,Aircraft:false,Packet:false,ALE:false'),'decoder tabs list the families this receiver offers, with the current one selected');
        check(await con.locator('#rd-popover-bandpass').count()===1&&await con.locator('[aria-controls="rd-popover-bandpass"]').innerText().then(t=>/^Filter \d/.test(t)),'the filter button shows the current filter width');
        await con.screenshot({path:path.join(root,'test-results/k2aam-console-desktop.png')});
        await con.locator('.rd-decoder-tabs .rd-tab',{hasText:'Aircraft'}).click();
        await con.waitForFunction(()=>UI.getModulation()==='hfdl');
        await con.waitForFunction(()=>document.querySelectorAll('.rd-decoder-modes .rd-family-mode').length>=4);
        check(await con.locator('.rd-decoder-modes .rd-family-mode').evaluateAll(n=>n.map(b=>b.textContent+':'+b.getAttribute('aria-pressed')).join()).then(t=>t.startsWith('HFDL:true')&&t.includes('ACARS:false')&&t.includes('ADSB:false')),'the Aircraft tab switches to HFDL and offers the other aircraft modes');
        await con.locator('.rd-decoder-modes .rd-family-mode',{hasText:'ACARS'}).click();
        await con.waitForFunction(()=>UI.getModulation()==='acars');
        await con.locator('.rd-decoder-tabs .rd-tab',{hasText:'FT8'}).click();
        await con.waitForFunction(()=>UI.getModulation()==='ft8');
        await con.locator('.rd-decoder-tabs .rd-tab',{hasText:'Aircraft'}).click();
        await con.waitForFunction(()=>UI.getModulation()==='acars');
        check(true,'a tab returns to the mode last used in that family');
        await con.screenshot({path:path.join(root,'test-results/k2aam-console-aircraft.png')});
        await con.getByRole('button',{name:'Side panel',exact:true}).click();
        await con.waitForTimeout(300);
        check(await con.evaluate(()=>{const t=document.getElementById('k2aam-decoder-tray'),r=t.getBoundingClientRect(),d=document.getElementById('openwebrx-panel-receiver').getBoundingClientRect();
            return !t.classList.contains('rd-side')&&!document.body.classList.contains('k2aam-side')&&Math.abs(document.body.getBoundingClientRect().width-innerWidth)<2&&r.left===0&&Math.abs(r.bottom-d.top)<=1&&r.top>100;}),'Side panel can be switched off, putting decoders back below the waterfall at full width');
        await con.getByRole('button',{name:'Side panel',exact:true}).click();
        await con.waitForSelector('#k2aam-decoder-tray.rd-side');
        await con.evaluate(()=>UI.setModulation('usb'));
        await con.waitForFunction(()=>!document.body.classList.contains('k2aam-side')&&document.getElementById('k2aam-decoder-tray').hidden);
        check(await con.evaluate(()=>Math.abs(document.body.getBoundingClientRect().width-innerWidth)<2),'leaving a decoder mode gives the waterfall its full width back');
        await con.evaluate(()=>UI.setModulation('ft8'));
        await con.setViewportSize({width:390,height:844});await con.waitForTimeout(500);
        const conPhone=await con.evaluate(()=>({side:document.body.classList.contains('k2aam-side'),overflow:document.documentElement.scrollWidth>innerWidth+1,dock:Math.round(document.getElementById('openwebrx-panel-receiver').getBoundingClientRect().height),
            shown:['.rd-nudge','#openwebrx-panel-volume','.rd-squelch .openwebrx-squelch-slider','#openwebrx-panel-nr','.rd-profiles select','[aria-controls="rd-popover-mode"]','[aria-controls="rd-popover-bandpass"]','[aria-controls="rd-popover-bands"]','.rd-step select','.rd-expand'].filter(q=>{const n=document.querySelector('#k2aam-dock '+q),r=n&&n.getBoundingClientRect();return !(r&&r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth+1);}),
            hidden:['.openwebrx-record-button','[aria-controls="rd-popover-waterfall"]'].filter(q=>document.querySelector('#k2aam-dock '+q).getBoundingClientRect().height>0)}));
        check(!conPhone.side&&!conPhone.overflow&&conPhone.shown.length===0&&conPhone.hidden.length===0,'phone console shows tuning, tags, volume, squelch, noise reduction and profile, with the rest behind Controls '+JSON.stringify(conPhone));
        check(conPhone.dock<=340,'phone console strip is at most 340 px tall ('+conPhone.dock+')');
        check(await con.evaluate(()=>{const b=document.getElementById('k2aam-decoder-body').getBoundingClientRect(),d=document.getElementById('openwebrx-panel-receiver').getBoundingClientRect(),r=document.querySelector('#openwebrx-panel-wsjt-message tbody tr').getBoundingClientRect();
            return b.height>=60&&b.bottom<=d.top+1&&r.bottom<=d.top+1&&r.height>0;}),'on a phone the decode list keeps room below the tabs and above the strip');
        await con.screenshot({path:path.join(root,'test-results/k2aam-console-phone.png')});
        check(conErrors.length===0,'no browser errors in the console layout: '+conErrors.join('; '));
        await con.close();
        // Community plugins: pinned local copies, loaded alongside the dock.
        const community=await browser.newPage({viewport:{width:1440,height:900}});const communityErrors=[],outside=[];
        community.on('pageerror',e=>communityErrors.push(e.message));
        community.on('request',r=>{const u=new URL(r.url());if(u.hostname!=='127.0.0.1'&&u.protocol.startsWith('http'))outside.push(r.url());});
        await community.goto(`http://127.0.0.1:${server.address().port}/?community=1`,{waitUntil:'domcontentloaded'});
        await community.waitForSelector('body.k2aam-dock-active');
        const communityNames=['utils','notify','colorful_spectrum','connect_notify','doppler','freq_scanner','frequency_far_jump','mouse_freq','screenshot','search_bookmarks','show_band_plan','toggle_scannable','tune_checkbox','tune_precise'];
        await community.waitForFunction(names=>names.every(n=>Plugins[n]&&Plugins[n]._script_loaded!==undefined)&&Plugins.tune_precise._script_loaded,communityNames,{timeout:20000}).catch(()=>{});
        await community.waitForTimeout(1500);
        const communityState=await community.evaluate(names=>names.map(n=>n+':'+(Plugins[n]?String(Plugins[n]._script_loaded):'absent')),communityNames);
        check(communityState.every(s=>s.includes('/static/plugins/receiver/community/')),'all fourteen community plugins load from the pinned local copies '+JSON.stringify(communityState.filter(s=>!s.includes('/community/'))));
        check(outside.length===0,'community plugins fetch nothing from other hosts on page load '+JSON.stringify(outside));
        check(await community.evaluate(()=>Plugins.utils._version>=0.9&&document.body.classList.contains('k2aam-dock-active')&&!!document.getElementById('k2aam-dock')),'the dock stays active with the newer utils plugin loaded');
        check(communityErrors.length===0,'no browser errors with community plugins loaded: '+communityErrors.join('; '));
        await community.screenshot({path:path.join(root,'test-results/k2aam-dock-community.png')});
        await community.close();
        await page.addInitScript(()=>{if(location.search.includes('map-test'))window.mapManager={};});
        await page.goto(`http://127.0.0.1:${server.address().port}/?map-test=1`,{waitUntil:'domcontentloaded'});
        await page.waitForFunction(()=>Plugins._type==='map');
        check(await page.evaluate(()=>!Plugins.ui_select&&!Plugins.k2aam_dock&&!Plugins.ale),'map plugin initialization does not load the receiver plugins');
        const slow=await browser.newPage();const slowErrors=[];
        slow.on('pageerror',e=>slowErrors.push(e.message));
        await slow.goto(`http://127.0.0.1:${server.address().port}/?delay-start=1`,{waitUntil:'domcontentloaded'});
        await slow.waitForResponse(r=>r.url().includes('k2aam_dock.css'),{timeout:10000}).catch(()=>{});
        await slow.waitForTimeout(300);
        check(await slow.evaluate(()=>!document.getElementById('k2aam-dock')&&!waterfall_setup_done),'dock waits while native scale is uninitialized');
        check(await slow.evaluate(()=>savedProfileNode.parentElement.parentElement.id==='openwebrx-panel-receiver'),'native controls remain in place before receiver startup');
        await slow.evaluate(()=>finishReceiverStartup());
        await slow.waitForSelector('body.k2aam-dock-active');
        check(await slow.locator('#openwebrx-scale-canvas').evaluate(n=>n.style.width.endsWith('px')),'real native resize_scale succeeds after delayed startup');
        await slow.evaluate(()=>{waterfall_setup_done=0;scale_canvas=undefined;scale_ctx=undefined;Plugins.k2aam_dock.destroy(false);});
        check(await slow.evaluate(()=>!document.getElementById('k2aam-dock')),'cleanup works when native scale is unavailable');
        check(slowErrors.length===0,'no errors on delayed startup or early cleanup: '+slowErrors.join('; '));
        await slow.close();
        check(errors.length===0,'no browser errors: '+errors.join('; '));
        console.log(`${checks} browser checks passed; native OWRX+ HTML, UI, demodulator panel, waterfall and plugin APIs; simulated RF transport.`);
    }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});

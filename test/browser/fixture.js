/* Test harness only. Native OWRX browser code is loaded separately. RF is simulated. */
window.LS = {
    has: k => localStorage.getItem(k) !== null, save: (k,v) => localStorage.setItem(k,v),
    loadStr: k => localStorage.getItem(k), loadInt: k => parseInt(localStorage.getItem(k)),
    loadBool: k => localStorage.getItem(k) === 'true', delete: k => localStorage.removeItem(k)
};
window.Lookup = {call2cname:()=>'',mmsi2cname:()=>''};
window.chroma = {scale: () => ({colors: () => Array.from({length:256},(_,i) => [i,i,i])})};
window.center_freq = 7100000; window.bandwidth = 400000; window.tuning_step = 100;
window.smeter_level = 0.004; window.getLogSmeterValue = () => -85;
window.zoomLevel = 0; window.zoomInOneStep = () => zoomLevel++;
window.zoomOutOneStep = () => zoomLevel--; window.zoomOutTotal = () => zoomLevel = 0;
window.zoomInTotal = () => zoomLevel = 5;
window.waterfall_setup_done = 0;
window.resize_canvases = () => { if (!waterfall_setup_done) throw new Error('resize before waterfall setup'); };
window.mkscale = () => {}; window.bandplan = {draw:()=>{}}; window.bookmarks = {position:()=>{}};
window.finishReceiverStartup = () => {
    window.scale_canvas=document.getElementById('openwebrx-scale-canvas');
    window.scale_ctx=scale_canvas.getContext('2d');
    window.waterfall_setup_done=1;
};
window.spectrum = {show: () => {}};
window.profilesChanged = 0; window.sdr_profile_changed = () => profilesChanged++;
window.tuning_step_changed = () => tuning_step=Number(document.getElementById('openwebrx-tuning-step-listbox').value);
window.tuning_step_reset = () => {}; window.tuneBySteps = n => UI.setFrequency(UI.getFrequency()+n*tuning_step);
window.jumpBySteps = tuneBySteps;
window.Demodulator = function(offset, modulation) {
    this.offset=offset; this.modulation=modulation; this.secondary=false; this.sql=-150; this.low_cut=-3000; this.high_cut=-300; this.events={};
};
Object.assign(Demodulator.prototype, {
    get_offset_frequency(){return this.offset;}, get_modulation(){return this.modulation;}, get_secondary_demod(){return this.secondary;},
    set_offset_frequency(f){ if(Math.abs(f)>bandwidth/2) return false; this.offset=f; (this.events.frequencychange||[]).forEach(fn=>fn(f)); return true; },
    on(n,f){(this.events[n] ||= []).push(f);}, getSquelch(){return this.sql;},
    setSquelch(v){this.sql=v;(this.events.squelchchange||[]).forEach(fn=>fn(v));},
    set_secondary_demod(v){this.secondary=v;},setBandpass(b){Object.assign(this,b);},disableBandpass(){},setIfRate(){}, start(){},stop(){}
});
$.fn.tuneableFrequencyDisplay = function(){const node=this[0];return {setFrequency(f){node.textContent=(f/1e6).toFixed(6)+' MHz';},setTuningPrecision(){}};};
$.fn.frequencyDisplay = function(){return {setFrequency(){},setTuningPrecision(){}};};

window.setupFixture = function () {
    window.secondary_demod_canvases_initialized=false;
    window.secondary_fft_size=256;window.secondary_bw=100;window.if_samp_rate=12000;
    window.secondary_demod_channel_freq=1000;window.secondary_demod_low_cut=0;window.secondary_demod_high_cut=3000;
    window.secondary_demod_update_channel_freq_from_event=()=>{};
    Modes.features = {sdr: true};
    Modes.modes = [
        {modulation:'lsb',name:'LSB',type:'analog',squelch:true}, {modulation:'usb',name:'USB',type:'analog',squelch:true},
        {modulation:'am',name:'AM',type:'analog',squelch:true}, {modulation:'nfm',name:'NFM',type:'analog',squelch:true},
        {modulation:'wfm',name:'WFM',type:'analog',squelch:true}, {modulation:'cw',name:'CW',type:'analog',squelch:true},
        {modulation:'dmr',name:'DMR',type:'analog',squelch:false},
        ...['ft8','ft4','wspr','js8','packet','ais','pocsag','page','hfdl','vdl2','acars','uat','adsb','ism','wmbus','dsc','sstv','fax','cwskimmer','meshtastic'].map(modulation=>({modulation,name:modulation.toUpperCase(),type:'digimode',squelch:false,underlying:['usb'],secondaryFft:true})),
        {modulation:'ale2g',name:'ALE 2G',type:'digimode',squelch:false,underlying:['usb'],secondaryFft:false},
        {modulation:'rtty',name:'RTTY',type:'digimode',squelch:false,underlying:['usb','lsb'],secondaryFft:true},
        ...['m17','ysf','dstar','nxdn','p25','tetra','dab','hdr','drm'].map(modulation=>({modulation,name:modulation.toUpperCase(),type:'analog',squelch:false}))
    ].map(x=>new Mode(x));
    initPanels(); secondary_demod_init();
    Utils.setCallsignUrl('https://www.qrz.com/db/{}');
    const p=$('#openwebrx-panel-receiver').demodulatorPanel(); p.center_freq=center_freq;
    p.updateHash=()=>{};p.render();p.setMode('lsb');p.getDemodulator().set_offset_frequency(21000);
    $('#openwebrx-panel-metadata-wfm').metaPanel()[0].setEnabled(true);
    $('#openwebrx-sdr-profiles-listbox').html('<option value="sdrplay|40m">RSPdx-R2 · 40m</option><option value="sdrplay|20m">RSPdx-R2 · 20m</option>');
    window.ctx = new AudioContext(); const gainNode=ctx.createGain(); gainNode.connect(ctx.destination);
    window.routeLog=[];
    const originalConnect=gainNode.connect.bind(gainNode), originalDisconnect=gainNode.disconnect.bind(gainNode);
    gainNode.connect=function(target,...args){routeLog.push(['connect',target===ctx.destination?'direct':'filter']);return originalConnect(target,...args);};
    gainNode.disconnect=function(target,...args){routeLog.push(['disconnect',target===ctx.destination?'direct':'filter']);return originalDisconnect(target,...args);};
    window.originalAudioConnect=AudioNode.prototype.connect;
    window.audioEngine={audioContext:ctx,gainNode,isStarted:()=>true,recording:false,lastHd:false,
        recorder:new AudioRecorder(12000,128),hdRecorder:new AudioRecorder(48000,128),
        setVolume(v){gainNode.gain.value=v;},
        startRecording:AudioEngine.prototype.startRecording,stopRecording:AudioEngine.prototype.stopRecording};
    UI.toggleScanner=()=>{};
    UI.setVolume(100); UI.wfTheme='turbo';Waterfall.levels={min:-96,max:-22};Waterfall.updateSliders();
    $('#openwebrx-tuning-step-listbox').val('100');
    $('.openwebrx-panel').css('transform','none');
    window.currentprofile={sdr_id:'sdrplay'};
    class Socket extends EventTarget {
        readyState=1;
        selected='Antenna C';
        sent=[];
        allowTune=true;
        requiredKey=null;
        tuneDelay=30;
        send(value){const packet=JSON.parse(value);this.sent.push(packet); if(packet.type==='setantenna')this.selected=packet.params.antenna;
            if(packet.type==='setfrequency' && this.allowTune && (!this.requiredKey || packet.params.key===this.requiredKey)) {
                const frequency=packet.params.frequency;
                setTimeout(()=>this.reply({type:'config',value:{center_freq:frequency,start_offset_freq:0,start_mod:'nfm'}}),this.tuneDelay);
            }
            if(['getantenna','setantenna'].includes(packet.type))setTimeout(()=>this.reply({type:'rsp_antenna_state',value:{supported:true,ready:true,sdr_id:'sdrplay',selected:this.selected,held:true,antennas:[{value:'Antenna A',label:'A - VHF'},{value:'Antenna B',label:'B - Experimental'},{value:'Antenna C',label:'C - HF'}]}}),10);
        }
        reply(data){
            if(data.type==='config') {
                if('allow_audio_recording' in data.value)$('.openwebrx-record-button').css('display',data.value.allow_audio_recording?'':'none');
                if('center_freq' in data.value){center_freq=data.value.center_freq;p.setCenterFrequency(center_freq);}
                if('samp_rate' in data.value)bandwidth=data.value.samp_rate;
                p.setInitialParams({offset_frequency:data.value.start_offset_freq||0,mod:data.value.start_mod||'lsb'});
            }
            this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));
        }
    }
    window.ws=new Socket();
    const canvas=document.createElement('canvas');canvas.id='fixture-waterfall';
    const host=document.getElementById('webrx-canvas-background');host.append(canvas);
    function paint(){
        const rect=host.getBoundingClientRect();canvas.width=Math.max(1,rect.width);canvas.height=Math.max(1,rect.height);
        const c=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
        c.fillStyle='#061427';c.fillRect(0,0,w,h);
        let seed=254;const rand=()=>{seed=(seed*16807)%2147483647;return seed/2147483647;};
        for(let y=0;y<h;y+=2)for(let x=0;x<w;x+=3){const n=Math.floor(20+rand()*35);c.fillStyle=`rgb(3,${n},${n+25})`;c.fillRect(x,y,3,2);}
        [.12,.23,.25,.39,.41,.58,.7,.82,.89].forEach((x,i)=>{const grad=c.createLinearGradient(w*x-8,0,w*x+8,0);grad.addColorStop(0,'#00b1e800');grad.addColorStop(.3,'#00cfc755');grad.addColorStop(.48,i%3?'#8df6b9':'#ffdf45');grad.addColorStop(.52,i%3?'#d4ffbd':'#ff802c');grad.addColorStop(.7,'#00cfc755');grad.addColorStop(1,'#00b1e800');c.fillStyle=grad;c.fillRect(w*x-8,0,16,h);});
        c.strokeStyle='#ffffff14';c.lineWidth=1;for(let y=0;y<h;y+=80){c.beginPath();c.moveTo(0,y);c.lineTo(w,y);c.stroke();}
    }
    new ResizeObserver(paint).observe(host);paint();
    window.savedProfileNode=document.getElementById('openwebrx-sdr-profiles-listbox');
    window.savedFrequencyNode=document.querySelector('.webrx-actual-freq');
    window.savedSquelchNode=document.querySelector('.openwebrx-squelch-slider');
    window.savedDecoderNodes=Array.from(document.querySelectorAll('.openwebrx-message-panel,.openwebrx-meta-panel,#openwebrx-panel-digimodes'));
    window.savedDecoderParents=new Map(savedDecoderNodes.map(node=>[node,node.parentElement]));
    if(location.search.includes('cold-start')) {
        // The first config can initialize the waterfall before modes/features
        // and the profile list arrive in separate websocket messages.
        const startupModes=Modes.modes;
        p.stopDemodulator();p.center_freq=undefined;
        Modes.modes=[];Modes.features={};
        $('#openwebrx-sdr-profiles-listbox').empty();
        savedFrequencyNode.textContent='0 Hz';
        window.coldStartup={
            config(){finishReceiverStartup();p.setCenterFrequency(center_freq);p.setInitialParams({offset_frequency:-26000,secondary_mod:'ft8',mod:'usb'});},
            modes(){Modes.modes=startupModes;Modes.updatePanels();},
            features(){Modes.setFeatures({sdr:true});},
            profiles(){$('#openwebrx-sdr-profiles-listbox').html('<option value="sdrplay|40m">RSPdx-R2 · 40m</option>').val('sdrplay|40m');}
        };
    } else if(!location.search.includes('delay-start'))finishReceiverStartup();
};

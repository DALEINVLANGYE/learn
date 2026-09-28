const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const logic = require(path.join(root, 'logic.js'));
const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };

test('course origin and route stay scoped', () => {
  assert.equal(logic.courseFromUrl('https://buaa.yuketang.cn/ai-workspace/lms-graph/123/video/5'), '123');
  for (const url of ['https://other.yuketang.cn/ai-workspace/lms-graph/123/video/5','http://buaa.yuketang.cn/ai-workspace/lms-graph/123/video/5','https://buaa.yuketang.cn.evil.test/ai-workspace/lms-graph/123/video/5']) assert.equal(logic.courseFromUrl(url), null);
});
test('next video skips assignments and exam, rejects ambiguous current row', () => {
  const list = [{type:'视频',title:'A',active:true},{type:'作业',title:'题'},{type:'考试',title:'考试'},{type:'视频',title:'B'}];
  assert.deepEqual(logic.chooseNext(list), {kind:'next',index:3,title:'B'});
  assert.equal(logic.chooseNext(list.slice(0,3)).kind, 'complete');
  list[3].active = true;
  assert.equal(logic.chooseNext(list).kind, 'error');
});
test('only an actual ended state qualifies, not time near the end', () => {
  assert.equal(logic.naturallyEnded({ended:false,currentTime:100,duration:100}), false);
  assert.equal(logic.naturallyEnded({ended:true,duration:Infinity}), false);
  assert.equal(logic.naturallyEnded({ended:true,duration:100}), true);
});

function harness(options={}) {
  let now = 1000, timerId=0, handler, mutation, saved={enabled:false}, holdSave=null;
  const timers = new Map(), controls = {};
  const location = {href:'https://buaa.yuketang.cn/ai-workspace/lms-graph/123/video/1?node_id=11',pathname:'/ai-workspace/lms-graph/123/video/1'};
  class Element extends EventTarget {
    constructor() { super(); this.style={};this.textContent='';this.hidden=false;this.disabled=false;this.nodeType=1;this.attributes={};this.clicks=0; }
    setAttribute(name,value){ this.attributes[name]=value; }
    querySelector(){ return null; }
    matches(){ return false; }
    click(){ this.clicks++;this.dispatchEvent(new Event('click')); }
    attachShadow(){ return {set innerHTML(value){},getElementById(id){ return controls[id] ||= new Element(); }}; }
  }
  class Video extends EventTarget {
    constructor() { super();this.readyState=1;this.duration=100;this.ended=false;this.paused=false;this.playbackRate=1;this.plays=0;this.rejectPlay=false;this.nodeType=1; }
    getClientRects(){ return this.hidden ? [] : [{}]; }
    closest(){ return {querySelector:()=>({click:()=>{ if(!options.rejectCustomSpeed){this.playbackRate=2;this.dispatchEvent(new Event('ratechange'));} }})}; }
    play(){ this.plays++; if(this.rejectPlay)return Promise.reject(new Error('autoplay'));this.paused=false;this.dispatchEvent(new Event('play'));return Promise.resolve(); }
    matches(){return true;} querySelector(){return null;}
  }
  let video=new Video(), currentTitle='A', search='', collapsed=false;
  const row = (type,title,active=false) => {
    const e = new Element();e.type=type;e.title=title;e.active=active;
    e.classList={contains: c => c==='is-active'&&e.active};
    e.querySelector= s=>({textContent:s==='.leaf-item-tag'?type:title});
    return e;
  };
  let rowList=[row('视频','A',true),row('作业','题'),row('视频','B'),row('考试','考试')];
  const document = new EventTarget();
  document.visibilityState='visible';document.hidden=false;
  document.createElement=()=>new Element();document.body=new Element();document.documentElement={append(){}};
  document.querySelector=s=>s==='.unit-title'?{textContent:currentTitle}:s.startsWith('input[')?{value:search}:s.includes(':not(.is-expand)')&&collapsed?new Element():null;
  document.querySelectorAll=s=>s==='.leaf-item'?rowList:s.startsWith('video.xt_video_player')?(video?[video]:[]):s==='.nav-item-title'&&collapsed?[{querySelector:()=>({}),classList:{contains:()=>false}}]:[];
  const chrome = {runtime:{id:'test-extension',onMessage:{addListener:f=>handler=f},sendMessage:async message=>{
    if(message.type==='YK_STATE_GET')return saved;
    if(holdSave)await holdSave;
    saved={enabled:message.enabled,courseId:'123',pending:message.pending};return saved;
  }}};
  const context=vm.createContext({console,URL,Event,EventTarget,AbortController,document,window:new EventTarget(),location,chrome,
    Date:{now:()=>now},setTimeout:(f,delay=0)=>{const id=++timerId;timers.set(id,{at:now+delay,f});return id;},clearTimeout:id=>timers.delete(id),setInterval:()=>++timerId,clearInterval:()=>{},
    MutationObserver:class{constructor(f){mutation=f;}observe(){}}});
  vm.runInContext(fs.readFileSync(path.join(root,'logic.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(root,'content.js'),'utf8'),context);
  async function message(type, enabled) { return await new Promise(resolve=>handler({type,enabled},{id:'test-extension'},resolve)); }
  async function advance(ms) {
    const limit=now+ms;
    for (;;) {
      await flush();
      const entry=Array.from(timers).filter(([,t])=>t.at<=limit).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!entry)break;
      now=entry[1].at;timers.delete(entry[0]);entry[1].f();
    }
    now=limit;await flush();
  }
  return {controls,ready:flush,advance,enable:()=>message('YK_ASSIST_SET_ENABLED',true),disable:()=>message('YK_ASSIST_SET_ENABLED',false),status:()=>message('YK_ASSIST_GET_STATUS'),
    get video(){return video;},get rows(){return rowList;},get saved(){return saved;},
    end(){video.ended=true;video.paused=true;video.dispatchEvent(new Event('ended'));},
    search(value){search=value;},collapse(){collapsed=true;},last(){rowList=rowList.slice(0,2);},
    loadNext(id=2,name='B',after='C',reject=false){ const previous=new URL(location.href);previous.pathname=previous.pathname.replace(/\/video\/\d+$/,`/video/${id}`);previous.searchParams.set('node_id',String(10+id));location.href=previous.href;location.pathname=previous.pathname;currentTitle=name;rowList=[row('视频',name,true),row('视频',after)];video=new Video();video.paused=true;video.rejectPlay=reject;mutation([{type:'childList',target:document.body,addedNodes:[video],removedNodes:[]}]);},
    background(hidden){ document.visibilityState=hidden?'hidden':'visible';document.hidden=hidden;document.dispatchEvent(new Event('visibilitychange')); },
    userInput(){ document.dispatchEvent(new Event('pointerdown')); },
    hold(){holdSave=new Promise(resolve=>this.release=()=>{holdSave=null;resolve();});}
  };
}
test('default is off; enable sets 2x but leaves a manually paused video paused', async()=>{
  const h=harness();await h.ready();assert.equal((await h.status()).enabled,false);assert.equal(h.video.playbackRate,1);
  h.video.paused=true;await h.enable();assert.equal(h.video.playbackRate,2);assert.equal(h.video.plays,0);
  assert.equal((await h.status()).phase,'paused');
});
test('background and delayed foreground pauses resume while manual input cancels recovery',async()=>{
  const h=harness();await h.ready();await h.enable();
  h.background(true);h.video.paused=true;h.video.dispatchEvent(new Event('pause'));await h.advance(250);
  assert.equal(h.video.plays,1);assert.equal(h.video.paused,false);
  h.background(false);await h.advance(300);
  h.video.paused=true;h.video.dispatchEvent(new Event('pause'));await h.advance(250);
  assert.equal(h.video.plays,2);assert.equal(h.video.paused,false);
  h.userInput();h.video.paused=true;h.video.dispatchEvent(new Event('pause'));await h.advance(250);
  assert.equal(h.video.plays,2);assert.equal(h.video.paused,true);
});
test('duplicate ended events navigate once, skip work, then play next at 2x',async()=>{
  const h=harness();await h.ready();await h.enable();h.end();h.end();await h.advance(1600);
  assert.equal(h.rows[1].clicks,0);assert.equal(h.rows[2].clicks,1);
  h.loadNext();await h.advance(200);assert.equal(h.video.playbackRate,2);assert.equal(h.video.plays,1);assert.equal((await h.status()).phase,'playing');
});
test('two successive videos both switch once and keep 2x when the site ignores custom menu clicks',async()=>{
  const h=harness({rejectCustomSpeed:true});await h.ready();await h.enable();h.end();await h.advance(1600);
  h.loadNext(2,'B','C');await h.advance(200);
  assert.equal(h.video.playbackRate,2);assert.equal(h.video.plays,1);
  h.end();await h.advance(1600);
  assert.equal(h.rows[1].clicks,1);
  h.loadNext(3,'C','D');await h.advance(200);
  assert.equal(h.video.playbackRate,2);assert.equal(h.video.plays,1);assert.equal((await h.status()).phase,'playing');
});
test('stop cancels a scheduled navigation without pausing current media',async()=>{
  const h=harness();await h.ready();await h.enable();h.end();await h.disable();await h.advance(2000);
  assert.equal(h.rows[2].clicks,0);assert.equal((await h.status()).enabled,false);
});
test('restart during pending storage cancels stale navigation',async()=>{
  const h=harness();await h.ready();await h.enable();h.hold();h.end();await h.advance(1600);
  h.video.ended=false;h.video.paused=true;h.release();await flush();
  assert.equal(h.rows[2].clicks,0);assert.equal(h.saved.pending,null);
});
test('search filtering or collapsed directory stops instead of skipping lessons',async()=>{
  for(const setup of [h=>h.search('B'),h=>h.collapse()]){
    const h=harness();await h.ready();await h.enable();setup(h);h.end();await h.advance(2000);
    assert.equal(h.rows[2].clicks,0);assert.equal((await h.status()).enabled,false);assert.equal((await h.status()).phase,'error');
  }
});
test('autoplay denial exposes a user gesture resume without retry loop',async()=>{
  const h=harness();await h.ready();await h.enable();h.end();await h.advance(1600);h.loadNext(2,'B','C',true);await h.advance(200);
  assert.equal((await h.status()).phase,'paused');assert.equal(h.controls.resume.hidden,false);await h.advance(10000);assert.equal(h.video.plays,1);
  h.video.rejectPlay=false;h.controls.resume.click();await flush();assert.equal(h.video.plays,2);assert.equal((await h.status()).phase,'playing');
});
test('last video finishes without opening assignment or exam',async()=>{
  const h=harness();await h.ready();h.last();await h.enable();h.end();await h.advance(2000);
  assert.equal((await h.status()).phase,'complete');assert.equal(h.rows[1].clicks,0);assert.equal(h.saved.enabled,false);
});
test('navigation timeout disables assist',async()=>{
  const h=harness();await h.ready();await h.enable();h.end();await h.advance(47000);
  assert.equal((await h.status()).enabled,false);assert.equal((await h.status()).phase,'error');
});
test('background stores state per tab and serializes a quick stop after start',async()=>{
  let listener;const data={};
  const chrome={runtime:{onMessage:{addListener:f=>listener=f}},tabs:{onRemoved:{addListener(){}}},storage:{session:{
    get:async key=>({[key]:data[key]}),set:async value=>{await flush();Object.assign(data,value);},remove:async key=>delete data[key]
  }}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),{chrome,URL,Promise,Map,Date,Number});
  const call=(tab,type,enabled)=>new Promise(resolve=>listener({type,enabled},{tab:{id:tab},frameId:0,url:'https://buaa.yuketang.cn/ai-workspace/lms-graph/123/video/1'},resolve));
  await Promise.all([call(1,'YK_STATE_SET',true),call(1,'YK_STATE_SET',false),call(2,'YK_STATE_SET',true)]);
  assert.equal((await call(1,'YK_STATE_GET')).enabled,false);assert.equal((await call(2,'YK_STATE_GET')).enabled,true);
});

 test('a transient player rate reset does not disable autoplay',async()=>{
  const h=harness();await h.ready();await h.enable();
  h.video.playbackRate=1;h.video.dispatchEvent(new Event('ratechange'));
  await h.advance(2500);
  assert.equal((await h.status()).enabled,true);
  assert.equal(h.video.playbackRate,2);
 });
 test('a replacement video becoming visible without a DOM mutation binds and continues twice',async()=>{
  const h=harness();await h.ready();await h.enable();h.end();await h.advance(1600);
  h.loadNext();h.video.hidden=true;await h.advance(200);
  h.video.hidden=false;await h.advance(2200);
  assert.equal(h.video.playbackRate,2);assert.equal(h.video.plays,1);
  h.end();await h.advance(1600);assert.equal(h.rows[1].clicks,1);
  h.loadNext(3,'C','D');await h.advance(2200);
  assert.equal(h.video.playbackRate,2);assert.equal(h.video.plays,1);
 });

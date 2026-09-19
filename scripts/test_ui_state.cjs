// Runs the actual dashboard script in a minimal DOM to reproduce out-of-order responses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, {id, value:'',dataset:{},classList:{toggle(){}},addEventListener(){},showModal(){},close(){},textContent:'',innerHTML:''});
  return elements.get(id);
};
const pending = [];
const context = vm.createContext({
  document:{getElementById:element,querySelectorAll:()=>[]},
  window:{addEventListener(){}},
  location:{protocol:'http:',host:'localhost'},
  WebSocket:class {close(){}},
  fetch:()=>new Promise(()=>{}),
  setInterval:()=>0, clearInterval(){}, setTimeout:()=>0, clearTimeout(){},
  URL, console, pending,
});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../edgepulse/static/app.js'),'utf8'),context);
vm.runInContext('api = () => new Promise(resolve => pending.push(resolve))',context);
async function main(){
  element('replay-device').value='device-A';
  const first=vm.runInContext('loadReplay()',context);
  element('replay-device').value='device-B';
  const second=vm.runInContext('loadReplay()',context);
  const sample=device_id=>({device_id,ts:1700000000000,temperature:40,vibration:1,current:5});
  pending[1]({json:async()=>[sample('device-B')]});
  await second;
  pending[0]({json:async()=>[sample('device-A')]});
  await first;
  assert.equal(vm.runInContext('state.replay[0].device_id',context),'device-B','stale responses must not replace the selected device history');
  vm.runInContext(`state.device='device-B'; state.snapshot={alerts:[
    {id:1,device_id:'device-A'}, {id:2,device_id:'device-B'}]}`,context);
  assert.equal(vm.runInContext('selectedAlerts().length',context),1);
  assert.equal(vm.runInContext('selectedAlerts()[0].id',context),2,'events must follow device selection');
  vm.runInContext('state.history=Array.from({length:100},(_,i)=>({ts:i*1000})); state.windowSize=30; state.focusTs=50000',context);
  assert.equal(vm.runInContext('windowRows().length',context),30);
  assert.equal(vm.runInContext('windowRows()[15].ts',context),50000,'focused event must be centered in the inspection window');
  vm.runInContext('state.focusTs=null',context);
  assert.equal(vm.runInContext('windowRows()[0].ts',context),70000,'live view must show the newest points');
  vm.runInContext('state.snapshot=null; state.history=[]; state.frozen=true; state.focusTs=50000',context);
  element('clear-focus').onclick();
  assert.equal(vm.runInContext('state.frozen',context),false,'return to latest must leave frozen mode');
  console.log('UI replay request ordering passed');
}
main().catch(error=>{console.error(error);process.exitCode=1});

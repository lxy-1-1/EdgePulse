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
  console.log('UI replay request ordering passed');
}
main().catch(error=>{console.error(error);process.exitCode=1});

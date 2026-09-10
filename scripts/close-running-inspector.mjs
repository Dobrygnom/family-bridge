// Only for a diagnostic listener deliberately opened on the running app.
// See docs/diagnostics-safety.md. Never close with a pending protocol response.
const targets = await fetch('http://127.0.0.1:9229/json/list').then(r => r.json());
const target = targets.find(t => t.title === 'electron/js2c/browser_init');
if (!target) throw Error('No running Electron main inspector');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, {once:true}));
const acknowledged = new Promise((resolve,reject) => socket.addEventListener('message',event => {
  const reply=JSON.parse(event.data);
  if(reply.id===1) reply.error || reply.result?.exceptionDetails ? reject(Error('Inspector shutdown request failed')) : resolve(reply);
}));
socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{
  expression:"setTimeout(()=>process.getBuiltinModule('inspector').close(),1500);true",returnByValue:true,
}}));
await acknowledged;
const closed = new Promise(resolve=>socket.addEventListener('close',resolve,{once:true}));
socket.close();
await closed;
console.log('Shutdown acknowledged; diagnostic socket safely disconnected.');

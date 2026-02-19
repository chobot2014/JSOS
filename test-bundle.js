const kernel = {
  vgaPut:()=>{},vgaGet:()=>0,vgaDrawRow:()=>{},vgaCopyRow:()=>{},vgaFillRow:()=>{},
  vgaFill:()=>{},vgaSetCursor:()=>{},vgaHideCursor:()=>{},vgaShowCursor:()=>{},
  getScreenSize:()=>({width:80,height:25}),
  readKey:()=>'',waitKey:()=>'q',
  waitKeyEx:(()=>{let n=0;return ()=>{if(n++>2)throw Object.assign(new Error('DONE'),{isDone:true});return {ch:'\n',ext:0};}})(),
  hasKey:()=>false,getTicks:()=>0,getUptime:()=>0,sleep:()=>{},
  getMemoryInfo:()=>({total:536870912,free:268435456,used:268435456}),
  inb:()=>0,outb:()=>{},callNative:()=>{},callNativeI:()=>0,readMem8:()=>0,writeMem8:()=>{},
  halt:()=>{console.log('HALT called');process.exit(0);},
  reboot:()=>{console.log('REBOOT called');process.exit(0);},
  eval:()=>'',serialPut:()=>{},serialGetchar:()=>-1,
  KEY_UP:128,KEY_DOWN:129,KEY_LEFT:130,KEY_RIGHT:131,KEY_HOME:132,KEY_END:133,
  KEY_PAGEUP:134,KEY_PAGEDOWN:135,KEY_DELETE:136,
  KEY_F1:1,KEY_F2:2,KEY_F3:3,KEY_F4:4,KEY_F5:5,KEY_F6:6,KEY_F7:7,KEY_F8:8,
  colors:{},
  print:(s)=>console.log('KERNEL_PRINT:',s)
};
global.kernel = kernel;

process.on('uncaughtException', (e) => {
  if (e && e.isDone) { console.log('DONE (normal exit)'); process.exit(0); }
  console.error('UNCAUGHT:', e && e.stack || String(e));
  process.exit(1);
});

try {
  require('./build/bundle.js');
  console.log('NO_CRASH');
} catch(e) {
  if (e && e.isDone) { console.log('DONE (normal exit via catch)'); process.exit(0); }
  console.error('CRASH:', e && e.stack || String(e));
  process.exit(1);
}

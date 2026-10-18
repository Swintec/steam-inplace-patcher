// Fake progress to preview the GUI; touches nothing.
const http=require('http');const cp=require('child_process');cp.exec=(c)=>console.log('would open',c);
const gui=require('./gui.js');gui.start();
gui.setTotals(7.31*2**30,191.3*2**30,191.3*2**30);
gui.set({message:'patch: 97.21 GiB / 191.30 GiB, 208 MiB/s'});
gui.add('download',7.31*2**30);
gui.add('patch',97.21*2**30);
setTimeout(()=>{},60000);

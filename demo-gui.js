// Fake progress to preview the GUI; touches nothing.
const http=require('http');const cp=require('child_process');cp.exec=(c)=>console.log('would open',c);
const gui=require('./gui.js');gui.start();
gui.setInstallTotals(191.3*2**30,191.3*2**30);gui.set({dl:{done:5.3*2**30,total:7.31*2**30},message:'download: 5.30 GiB / 7.31 GiB, 35 MiB/s'});
gui.progress('download',5.3*2**30);
setTimeout(()=>{},60000);

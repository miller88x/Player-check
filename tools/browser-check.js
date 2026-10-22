// Phone-size browser check of the app before shipping: node tools/browser-check.js (needs a local server and maplibre dist)
const { chromium } = require('playwright');
const fs=require('fs');
(async()=>{const b=await chromium.launch();
for (const scenario of ["new","returning"]) {
const ctx=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,geolocation:{latitude:40.6705,longitude:-73.8935},permissions:['geolocation'],serviceWorkers:'block'});
const p=await ctx.newPage();
await p.route('**/unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',r=>r.fulfill({body:fs.readFileSync('/tmp/claude-0/ml/dist/maplibre-gl.js'),contentType:'application/javascript'}));
await p.route('**/unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',r=>r.fulfill({body:fs.readFileSync('/tmp/claude-0/ml/dist/maplibre-gl.css'),contentType:'text/css'}));
const errs=[];p.on('pageerror',e=>errs.push('PAGEERROR '+e.message+' @'+(e.stack||'').split('\n')[1]));p.on('console',m=>{if(m.type()==='error'||m.type()==='warning')errs.push(m.type()+' '+m.text())});
if(scenario==="returning") await p.addInitScript(()=>{localStorage.setItem('welcomed','1');localStorage.setItem('plate',JSON.stringify({p:'ROVADEMO',s:'NY'}));localStorage.setItem('parked',JSON.stringify({at:[-73.8935,40.6705],moveBy:new Date(Date.now()+3*3600e3).toISOString(),where:'Elmwood Ave',savedAt:Date.now()-60000}));localStorage.setItem('darkMode','"auto"');});
await p.goto('http://localhost:3457/',{waitUntil:'domcontentloaded'});await p.waitForTimeout(8000);
for(let i=0;i<3;i++){const n=await p.$('#wcNext:visible');if(n)await n.click();await p.waitForTimeout(400);}
await p.screenshot({path:`/tmp/claude-0/vis/${scenario}1.png`});
// interactions
const tryClick=async(sel,label)=>{try{await p.click(sel,{timeout:3000});await p.waitForTimeout(1200);}catch(e){errs.push(`CLICK FAIL ${label}: ${e.message.split('\n')[0]}`)}};
await tryClick('#q','search'); await p.keyboard.type('565'); await p.waitForTimeout(1500); await p.keyboard.press('Escape');
await p.reload({waitUntil:'domcontentloaded'});await p.waitForTimeout(5000);await tryClick('#layersBtn','layers'); await p.screenshot({path:`/tmp/claude-0/vis/${scenario}2.png`}); await tryClick('[data-dark="on"]','dark on');
await p.keyboard.press('Escape');await p.mouse.click(200,400);await p.waitForTimeout(500);await tryClick('#parkBtn','park tab'); await p.waitForTimeout(3000); await p.screenshot({path:`/tmp/claude-0/vis/${scenario}3.png`});
await p.reload({waitUntil:'domcontentloaded'});await p.waitForTimeout(5000);await tryClick('#youBtn','you tab'); await p.screenshot({path:`/tmp/claude-0/vis/${scenario}4.png`});
console.log(`== ${scenario}:`, errs.filter(e=>!/net::ERR|Failed to load resource|openfreemap|photon|fonts\.g|ERR_TUNNEL|tiles|arcgis|osrm|overpass|open-meteo/.test(e)).slice(0,25).join('\n')||'no JS errors');
await ctx.close();}
await b.close();})();

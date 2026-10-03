const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const url = process.env.VIEWER_URL || pathToFileURL(path.join(root, 'index.html')).href;
const artifactDir = path.join(root, '.test-output');
fs.mkdirSync(artifactDir, {recursive:true});

(async () => {
  const browser = await chromium.launch({headless:true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(() => typeof charmViewer !== 'undefined' && charmViewer && charmViewer.simulation);
    const initialFrame=await page.evaluate(()=>{
      scene.updateMatrixWorld(true);cam.updateMatrixWorld(true);
      let extent=0;
      for(const mesh of charmViewer.assembly.meshes) {
        const position=mesh.geometry.attributes.position;
        for(let i=0;i<position.count;i++) {
          const p=new THREE.Vector3().fromBufferAttribute(position,i).applyMatrix4(mesh.matrixWorld).project(cam);
          extent=Math.max(extent,Math.abs(p.x),Math.abs(p.y));
        }
      }
      return extent;
    });
    assert.ok(initialFrame<.98,'The native-size charm must fit in the initial camera frame: '+initialFrame);
    const fixedClearance=await page.evaluate(()=>{
      const inverse=phoneGroup.matrixWorld.clone().invert();let maxY=-Infinity;
      for(const mapping of charmViewer.simulation._mappings) for(const vertex of mapping.fixed) {
        const p=new THREE.Vector3().fromBufferAttribute(mapping.position,vertex).applyMatrix4(mapping.mesh.matrixWorld).applyMatrix4(inverse);
        maxY=Math.max(maxY,p.y);
      }
      return maxY-charmViewer.phoneBox.max.y;
    });
    assert.ok(fixedClearance>0,'The fixed attachment must protrude above the case: '+fixedClearance);
    await page.screenshot({path:path.join(artifactDir,'desktop-native-initial.png')});
    await page.click('#tgt [data-i="3"]');
    await page.screenshot({path:path.join(artifactDir,'desktop-charm-native-initial.png')});
    await page.click('#tgt [data-i="0"]');
    await page.waitForTimeout(2500);
    const initial = await page.evaluate(() => ({stats:charmViewer.simulation.stats,
      vertices:Array.from(charmViewer.assembly.meshes[0].geometry.attributes.position.array),
      phone:phoneGroup.quaternion.toArray(),camera:cam.position.toArray(),mount:charmViewer.mount.position.toArray(),
      expectedMount:[charmViewer.phoneBox.max.x+(.035-.25)*charmViewer.height,
        charmViewer.phoneBox.max.y+.02*charmViewer.height,
        charmViewer.phoneBox.max.z+(.035-.15)*charmViewer.height],
      scale:charmViewer.assembly.root.scale.toArray(),
      orientation:charmViewer.assembly.root.rotation.x,
      collisionMasks:charmViewer.simulation.world.bodies.map(b=>b.collisionFilterMask)}));
    assert.equal(initial.stats.particleCount,60);assert.equal(initial.stats.pinnedCount,4);
    assert.equal(initial.stats.pinnedRenderCount,45);
    assert.equal(initial.stats.preset,'MC2');assert.equal(initial.stats.angleCount,112);assert.equal(initial.stats.tetherCount,56);
    assert.deepEqual(initial.mount,initial.expectedMount);assert.ok(Math.abs(initial.orientation+Math.PI/2)<1e-6);
    assert.deepEqual(initial.scale,[1,1,1],'Charm must retain its native bundle scale');
    assert.ok(initial.collisionMasks.every(mask=>mask===0),'Phone collisions must be disabled');
    assert.equal(await page.locator('#charmOptions').isVisible(),false,'Charm controls must stay inside the Charm tab');
    assert.equal(await page.locator('#charmMotion,#charmMount,#charmSize,#charmPhysics,#charmExport,#charmHeight,#charmHeightNumber').count(),0);
    await page.waitForTimeout(250);
    assert.deepEqual(await page.evaluate(()=>phoneGroup.quaternion.toArray()),initial.phone,'Phone must stay still without input');
    const pixels = await page.evaluate(() => {
      ren.render(scene,cam);
      const gl=ren.getContext(),data=new Uint8Array(ren.domElement.width*ren.domElement.height*4);
      gl.readPixels(0,0,ren.domElement.width,ren.domElement.height,gl.RGBA,gl.UNSIGNED_BYTE,data);
      const base=Array.from(data.slice(0,3));let differing=0;
      for(let i=0;i<data.length;i+=4) if(Math.abs(data[i]-base[0])+Math.abs(data[i+1]-base[1])+Math.abs(data[i+2]-base[2])>20) differing++;
      return differing;
    });
    assert.ok(pixels>5000,'Canvas must contain visible geometry');
    await page.screenshot({path:path.join(artifactDir,'desktop.png')});
    await page.waitForFunction(()=>charmViewer.simulation._mc2.sleeping,{},{timeout:15000});
    const resting=await page.evaluate(()=>Array.from(charmViewer.assembly.meshes[0].geometry.attributes.position.array));
    await page.waitForTimeout(500);
    assert.deepEqual(await page.evaluate(()=>Array.from(charmViewer.assembly.meshes[0].geometry.attributes.position.array)),resting,
      'The charm must not simulate ambient wind while the phone is stationary');
    await page.screenshot({path:path.join(artifactDir,'desktop-rest.png')});
    const canvas=await page.locator('canvas').boundingBox();
    await page.mouse.move(canvas.x+canvas.width*.5,canvas.y+canvas.height*.5);
    await page.mouse.down();await page.mouse.move(canvas.x+canvas.width*.7,canvas.y+canvas.height*.38,{steps:14});await page.mouse.up();
    await page.waitForTimeout(600);
    const dragged=await page.evaluate(()=>({phone:phoneGroup.quaternion.toArray(),camera:cam.position.toArray(),
      vertices:Array.from(charmViewer.assembly.meshes[0].geometry.attributes.position.array)}));
    assert.ok(dragged.phone.some((v,i)=>Math.abs(v-initial.phone[i])>.05),'Drag must rotate the phone');
    assert.equal(await page.evaluate(()=>charmViewer.simulation._mc2.sleeping),false,'Drag must wake physics');
    assert.deepEqual(dragged.camera,initial.camera,'Drag must not orbit the camera');
    assert.ok(dragged.vertices.some((v,i)=>Math.abs(v-initial.vertices[i])>.003),'Drag must physically deform the charm');
    await page.screenshot({path:path.join(artifactDir,'desktop-motion.png')});
    const pins=await page.evaluate(()=>{
      const s=charmViewer.simulation;
      return s._particles.filter(p=>p.fixed).map(p=>new THREE.Vector3(p.body.position.x,p.body.position.y,p.body.position.z)
        .distanceTo(p.rest.clone().applyMatrix4(s._simulationMatrix)));
    });
    assert.ok(pins.every(d=>d<1e-5),'Pins must follow the rotating phone: '+JSON.stringify(pins));
    const renderPins=await page.evaluate(()=>charmViewer.simulation._mappings.flatMap(mapping=>
      Array.from(mapping.fixed,vertex=>Math.max(...[0,1,2].map(axis=>{
        const i=vertex*3+axis;return Math.abs(mapping.position.array[i]-mapping.restPositions[i]);
      })))));
    assert.equal(renderPins.length,45);
    assert.ok(renderPins.every(d=>d===0),'The visible attachment must remain fixed during drag');
    await page.click('#tgt [data-i="3"]');
    assert.equal(await page.locator('#charmOptions input[type="checkbox"]').count(),2);
    assert.equal(await page.locator('#hidePhone').isChecked(),false);
    assert.equal(await page.locator('#charmCollisions').isChecked(),false);
    await page.check('#hidePhone');
    assert.ok(await page.evaluate(()=>!charmViewer.phoneModel.visible&&phoneGroup.visible&&charmViewer.assembly.root.visible),
      'Hiding the phone must not hide its attached charm');
    const hiddenPhonePose=await page.evaluate(()=>phoneGroup.quaternion.toArray());
    await page.mouse.move(canvas.x+canvas.width*.5,canvas.y+canvas.height*.5);
    await page.mouse.down();await page.mouse.move(canvas.x+canvas.width*.36,canvas.y+canvas.height*.55,{steps:10});await page.mouse.up();
    await page.waitForTimeout(350);
    assert.ok(await page.evaluate(previous=>phoneGroup.quaternion.toArray().some((v,i)=>Math.abs(v-previous[i])>.05),hiddenPhonePose),
      'The hidden phone and its charm must remain interactive');
    await page.screenshot({path:path.join(artifactDir,'desktop-charm-only.png')});
    await page.check('#charmCollisions');
    assert.ok(await page.evaluate(()=>charmViewer.simulation.collisionsEnabled&&charmViewer.simulation._phoneBody&&
      charmViewer.simulation._particles.filter(p=>!p.fixed).every(p=>p.body.collisionFilterMask===2)),
      'Collision checkbox must enable the physical phone even when it is hidden');
    await page.waitForTimeout(500);
    assert.ok(await page.evaluate(()=>charmViewer.simulation._particles.every(p=>Number.isFinite(p.body.position.x+p.body.position.y+p.body.position.z))));
    await page.uncheck('#hidePhone');
    assert.ok(await page.evaluate(()=>charmViewer.phoneModel.visible&&charmViewer.simulation.collisionsEnabled),
      'Visibility must not change the collision setting');
    await page.uncheck('#charmCollisions');
    assert.ok(await page.evaluate(()=>!charmViewer.simulation._phoneBody&&charmViewer.simulation.world.bodies.every(b=>b.collisionFilterMask===0)),
      'Disabling collisions must remove the physical phone volume');
    await page.click('#tgt [data-i="0"]');
    assert.equal(await page.locator('#charmOptions').isVisible(),false);
    await page.click('[data-view="back"]');await page.waitForTimeout(500);
    assert.ok(await page.evaluate(()=>phoneGroup.quaternion.angleTo(new THREE.Quaternion())>.5));
    await page.waitForFunction(()=>charmViewer.simulation._mc2.sleeping,{},{timeout:15000});
    const backResting=await page.evaluate(()=>Array.from(charmViewer.assembly.meshes[0].geometry.attributes.position.array));
    await page.waitForTimeout(500);
    assert.deepEqual(await page.evaluate(()=>Array.from(charmViewer.assembly.meshes[0].geometry.attributes.position.array)),backResting,
      'The charm must settle again after rotating the phone');
    await page.screenshot({path:path.join(artifactDir,'desktop-back-rest.png')});
    await page.click('[data-view="left"]');await page.waitForTimeout(500);
    await page.waitForFunction(()=>charmViewer.simulation._mc2.sleeping,{},{timeout:15000});
    await page.screenshot({path:path.join(artifactDir,'desktop-side-rest.png')});
    await page.click('#cameraReset');await page.waitForTimeout(650);
    const sample=JSON.parse(fs.readFileSync(path.join(root,'assets/charms/hat.json'),'utf8'));
    const texture={name:'texture.png',mimeType:'image/png',buffer:Buffer.from(sample.materials[0].map.split(',')[1],'base64')};
    await page.locator('#f').setInputFiles(texture);await page.waitForFunction(()=>textureHistory[0].undo.length===1);
    await page.click('#undo');await page.click('#redo');await page.click('#resetTarget');
    await page.click('#tgt [data-i="3"]');
    assert.equal(await page.locator('#drop').getAttribute('aria-label'),'Upload charm');
    await page.locator('#f').setInputFiles(path.join(root,'assets/charms/hat-preset.json'));
    await page.waitForFunction(()=>document.getElementById('charmStatus').textContent.includes('MC2: hat-preset.json'));
    assert.equal(await page.evaluate(()=>charmViewer.currentKey),'hat','A preset must preserve the loaded mesh');
    const invalidPreset=JSON.parse(fs.readFileSync(path.join(root,'assets/charms/hat-preset.json'),'utf8'));
    invalidPreset.gravity=-100;
    await page.locator('#f').setInputFiles({name:'bad-preset.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(invalidPreset))});
    await page.waitForFunction(()=>document.getElementById('charmStatus').textContent==='Invalid MC2 gravity.');
    assert.equal(await page.evaluate(()=>charmViewer.simulation._mc2.preset.gravity),10,'Invalid presets must preserve current physics');
    await page.locator('#f').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{"invalid":true}')});
    await page.waitForFunction(()=>document.getElementById('charmStatus').classList.contains('error'));
    assert.ok(await page.evaluate(()=>Boolean(charmViewer.simulation)),'Invalid imports must keep current charm');
    const malformed=structuredClone(sample);malformed.physics.triangles[0]=60;
    await page.locator('#f').setInputFiles({name:'bad-proxy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(malformed))});
    await page.waitForFunction(()=>document.getElementById('charmStatus').textContent==='Invalid cloth triangles.');
    assert.equal(await page.evaluate(()=>charmViewer.currentKey),'hat');
    const malformedLines=structuredClone(sample);malformedLines.physics.lines[0]=60;
    await page.locator('#f').setInputFiles({name:'bad-lines.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(malformedLines))});
    await page.waitForFunction(()=>document.getElementById('charmStatus').textContent==='Invalid cloth lines.');
    assert.equal(await page.evaluate(()=>charmViewer.currentKey),'hat');
    const malformedFixed=structuredClone(sample);malformedFixed.physics.renderMappings[0].fixed=[451];
    await page.locator('#f').setInputFiles({name:'bad-fixed.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(malformedFixed))});
    await page.waitForFunction(()=>document.getElementById('charmStatus').textContent==='Invalid fixed render vertices.');
    assert.equal(await page.evaluate(()=>charmViewer.currentKey),'hat');
    await page.check('#hidePhone');await page.check('#charmCollisions');
    await page.locator('#f').setInputFiles(path.join(root,'assets/charms/hat.json'));
    await page.waitForFunction(()=>charmViewer.currentKey==='import-1'&&!document.getElementById('charmStatus').classList.contains('error'));
    assert.ok(await page.evaluate(()=>!charmViewer.phoneModel.visible&&charmViewer.simulation.collisionsEnabled),
      'New imports must retain the visibility and collision settings');
    assert.ok(await page.evaluate(()=>Math.abs(charmViewer.mount.position.y-charmViewer.phoneBox.max.y-.02*charmViewer.height)<1e-9),
      'New imports must retain the fixed 2% height offset');
    await page.evaluate(data=>{
      const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(data)],'dropped.json',{type:'application/json'}));
      document.getElementById('drop').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    },sample);
    await page.waitForFunction(()=>charmViewer.currentKey==='import-2');
    if(process.env.CHARM_BUNDLE&&url.startsWith('http:')){
      await page.locator('#f').setInputFiles(process.env.CHARM_BUNDLE);
      await page.waitForFunction(()=>charmViewer.currentKey==='import-3'&&!document.getElementById('charmStatus').classList.contains('error'),{},{timeout:60000});
      assert.equal(await page.evaluate(()=>charmViewer.simulation.stats.pinnedRenderCount),45,
        'Direct bundle imports must preserve the original fixed render selection');
    }
    await page.click('#removeCharm');assert.ok(await page.evaluate(()=>charmViewer.simulation===null));
    assert.equal(await page.locator('#charmCollisions').isDisabled(),true);
    await page.click('#resetTarget');await page.waitForFunction(()=>charmViewer.simulation&&charmViewer.currentKey==='hat');
    assert.equal(await page.locator('#charmCollisions').isDisabled(),false);
    assert.ok(await page.evaluate(()=>!charmViewer.phoneModel.visible&&charmViewer.simulation.collisionsEnabled));
    await page.uncheck('#charmCollisions');await page.uncheck('#hidePhone');
    await page.click('#tgt [data-i="0"]');
    for(const viewport of [{width:390,height:844},{width:700,height:700},{width:1024,height:768}]){
      await page.setViewportSize(viewport);await page.waitForTimeout(250);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'No horizontal overflow');
      await page.screenshot({path:path.join(artifactDir,'viewport-'+viewport.width+'.png'),fullPage:true});
      await page.click('#tgt [data-i="3"]');
      assert.equal(await page.locator('#charmOptions').isVisible(),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'Charm controls must fit on mobile');
      await page.screenshot({path:path.join(artifactDir,'viewport-charm-'+viewport.width+'.png'),fullPage:true});
      await page.click('#tgt [data-i="0"]');
    }
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({url,stats:initial.stats,mount:initial.mount,scale:initial.scale,initialFrame,fixedClearance,nonbackgroundPixels:pixels,pinErrors:pins,renderPinErrors:renderPins,errors,
      bundleTested:Boolean(process.env.CHARM_BUNDLE&&url.startsWith('http:'))}));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

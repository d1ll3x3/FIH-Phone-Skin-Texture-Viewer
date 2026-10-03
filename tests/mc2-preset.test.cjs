const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
global.THREE = require('../vendor/three.min.js');
global.CANNON = require('../vendor/cannon.min.js');
for (const file of ['mc2-preset.js', 'charm-physics.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../scripts', file), 'utf8'));
}
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/charms/hat.json'), 'utf8'));
const source = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/charms/hat-preset.json'), 'utf8'));
const preset = MC2Preset.validate(source);
assert.equal(preset.gravity, 10);
assert.equal(preset.damping.value, 0);
assert.equal(MC2Preset.curve(preset.angleRestorationConstraint.stiffness, 0), 1);
assert.ok(Math.abs(MC2Preset.curve(preset.angleRestorationConstraint.stiffness, .5) - .6) < 1e-6);
assert.ok(Math.abs(MC2Preset.curve(preset.angleRestorationConstraint.stiffness, 1) - .2) < 1e-6);
assert.equal(MC2Preset.curve(preset.angleLimitConstraint.limitAngle, .5, 180), 90);
const hermite = {value:99,useCurve:true,curve:{m_Curve:[
  {time:0,value:0,inSlope:0,outSlope:0},{time:1,value:1,inSlope:0,outSlope:0}]}};
assert.equal(MC2Preset.curve(hermite, .25), .15625);
assert.equal(MC2Preset.curve({...hermite,useCurve:false}, .25), 99);
assert.throws(()=>MC2Preset.validate({...source,gravity:NaN}), /number/);
assert.throws(()=>MC2Preset.validate({...source,clothType:1}), /MeshCloth/);
const malformed = structuredClone(source); malformed.angleLimitConstraint.limitAngle.curve.m_Curve[1].time = 0;
assert.throws(()=>MC2Preset.validate(malformed), /curve/);

function build(settings) {
  const phone = new THREE.Group(), root = new THREE.Group(), node = new THREE.Group();
  phone.add(root); root.add(node); root.rotation.x = -Math.PI / 2; root.scale.setScalar(1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.meshes[0].positions, 3));
  geometry.setIndex(data.meshes[0].indices);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()); node.add(mesh);
  const simulation = new CharmPhysics({root,nodes:new Map([[data.physics.node,node]]),meshes:[mesh],
    physics:data.physics,preset:settings});
  const capCenter = () => simulation._particles.slice(21).reduce((v,p)=>v.add(new THREE.Vector3().copy(p.body.position)),
    new THREE.Vector3()).multiplyScalar(1/39);
  return {phone,root,mesh,simulation,capCenter};
}
const baseline = build(null), mc2 = build(preset);
assert.equal(mc2.simulation.stats.angleCount, 112);
assert.equal(mc2.simulation.stats.tetherCount, 56);
assert.equal(mc2.simulation.stats.pinnedRenderCount, 45);
assert.equal(mc2.simulation._springs, undefined);
assert.deepEqual(mc2.simulation._mc2.preset, source, 'Viewer tuning must preserve the original MC2 preset.');
assert.deepEqual(mc2.simulation._mc2.depths, data.physics.depths);
const rootLimit = mc2.simulation._mc2.constraints.find(c=>c.kind==='angle'&&c.limit&&c.index===6);
assert.ok(Math.abs(rootLimit.maxAngle-data.physics.depths[6]*Math.PI)<1e-8);
const initial = mc2.capCenter();
for (let frame=0;frame<720;frame++) { baseline.simulation.update(1/60); mc2.simulation.update(1/60); }
const settled = mc2.capCenter(), loose = baseline.capCenter();
const deformation = settled.distanceTo(initial), looseDeformation = loose.distanceTo(initial);
assert.equal(mc2.simulation._mc2.sleeping,true,'A settled charm must stop moving without phone input: '+
  JSON.stringify({speed:mc2.simulation._mc2.restSpeed,idle:mc2.simulation._mc2._idleTime,stable:mc2.simulation._mc2._stableTime}));
let restSpeed=0,restTravel=0;
for(let frame=0;frame<360;frame++) {
  mc2.simulation.update(1/60);
  restTravel=Math.max(restTravel,mc2.capCenter().distanceTo(settled));
  for(const p of mc2.simulation._particles) if(!p.fixed) restSpeed=Math.max(restSpeed,p.body.velocity.norm());
}
assert.ok(deformation>1e-4, 'The preset must preserve physical deformation, not lock the mesh.');
assert.ok(deformation<looseDeformation, 'The MC2 angular/tether constraints should reduce the baseline collapse.');
assert.ok(deformation>looseDeformation*.95, 'The loose calibration must stay close to the original flexible version.');
assert.ok(new THREE.Vector3().copy(mc2.simulation.world.gravity).distanceTo(new THREE.Vector3(0,-10,0))<1e-8);
assert.ok(mc2.simulation._particles.every(p=>p.body.linearDamping===0));
assert.equal(mc2.simulation.world.contacts.length,0);
const beforeMove = mc2.capCenter();
mc2.phone.rotation.z=.5;mc2.simulation.update(1/60);
assert.equal(mc2.simulation._mc2.sleeping,false,'Moving the phone must wake its physical charm.');
const rigid = beforeMove.clone().applyAxisAngle(new THREE.Vector3(0,0,1),.5);
assert.ok(mc2.capCenter().distanceTo(rigid)>.01, 'MC2 preview must retain visible inertia during rotation.');
let maxSpeed=0,maxStrain=0,maxRenderPinError=0;
for(let frame=0;frame<720;frame++) {
  mc2.phone.rotation.z=.4*Math.sin(frame/70);mc2.phone.rotation.y=.3*Math.sin(frame/55);
  mc2.phone.position.x=.06*Math.sin(frame/25);mc2.simulation.update(1/60);
  for(const mapping of mc2.simulation._mappings) for(const vertex of mapping.fixed) {
    for(let axis=0;axis<3;axis++) {
      const i=vertex*3+axis;
      maxRenderPinError=Math.max(maxRenderPinError,Math.abs(mapping.position.array[i]-mapping.restPositions[i]));
    }
  }
  for(const p of mc2.simulation._particles) if(!p.fixed) maxSpeed=Math.max(maxSpeed,p.body.velocity.norm());
  for(const link of mc2.simulation._links) if(!link.secondary) {
    maxStrain=Math.max(maxStrain,Math.abs(link.constraint.bodyA.position.distanceTo(link.constraint.bodyB.position)
      -link.constraint.distance)/link.constraint.distance);
  }
}
assert.ok(maxSpeed<=4.000001,'The preset particle speed limit must be enforced.');
assert.ok(maxStrain<.15,'Looser angles must not overstretch the structural links.');
assert.equal(maxRenderPinError,0,'MC2 fixed render selection must not deform while the rest stays loose.');
for(const p of mc2.simulation._particles) {
  assert.ok(Number.isFinite(p.body.position.x+p.body.position.y+p.body.position.z));
  if(p.fixed) assert.ok(new THREE.Vector3().copy(p.body.position).distanceTo(p.rest.clone()
    .applyMatrix4(mc2.simulation._simulationMatrix))<1e-8);
}
const count=mc2.simulation.world.constraints.length;
mc2.simulation.setPreset(preset);assert.equal(mc2.simulation.world.constraints.length,count,'Changing presets must not leak constraints.');
mc2.simulation.update(2);assert.ok(mc2.capCenter().distanceTo(initial.clone().applyEuler(mc2.phone.rotation)
  .add(mc2.phone.position))<1e-6,'A time gap must reset the MC2 inertial filter and pose.');
mc2.simulation.dispose();baseline.simulation.dispose();
assert.equal(mc2.simulation.world.constraints.length,0);
assert.equal(mc2.simulation.world.bodies.length,0);
console.log(JSON.stringify({deformation,looseDeformation,settled:settled.toArray(),loose:loose.toArray(),maxSpeed,maxStrain,maxRenderPinError,restSpeed,restTravel}));

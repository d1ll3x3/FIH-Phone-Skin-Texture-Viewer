const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
global.THREE = require('../vendor/three.min.js');
global.CANNON = require('../vendor/cannon.min.js');
vm.runInThisContext(fs.readFileSync(path.join(__dirname,'../scripts/charm-physics.js'),'utf8'));

const phone = new THREE.Group(), root = new THREE.Group(), node = new THREE.Group();
phone.add(root);root.add(node);
const positions = [0,.2,0,.4,.2,0,.4,.25,0];
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
geometry.setIndex([0,1,2]);
const mesh = new THREE.Mesh(geometry,new THREE.MeshBasicMaterial());node.add(mesh);
const box = new THREE.Box3(new THREE.Vector3(-1,-.1,-1),new THREE.Vector3(1,0,1));
const physics = {type:'mesh',node:'node',positions,fixed:[0],triangles:[0,1,2],parentIndices:[-1,0,1],
  links:[[0,1,.4],[1,2,.05],[0,2,Math.hypot(.4,.05)]],renderMappings:[{mesh:0,fixed:[0],
    indices:[0,0,0,0,1,1,1,1,2,2,2,2],weights:[1,0,0,0,1,0,0,0,1,0,0,0]}]};
const simulation = new CharmPhysics({root,nodes:new Map([['node',node]]),meshes:[mesh],physics,
  phoneBounds:{object:phone,box}});
const moving = simulation._particles.filter(p=>!p.fixed);
assert.equal(simulation.collisionsEnabled,false);
assert.equal(simulation.world.bodies.length,3);
for(let frame=0;frame<360;frame++) simulation.update(1/60);
assert.equal(simulation.world.contacts.length,0);
assert.ok(Math.min(...moving.map(p=>p.body.position.y))<-.15,'Disabled collisions must allow the charm through the phone.');

const before = moving.map(p=>p.body.position.toArray());
simulation.collisionsEnabled=true;
assert.deepEqual(moving.map(p=>p.body.position.toArray()),before,'Enabling collisions must not reset the charm pose.');
assert.equal(simulation.world.bodies.length,4);
assert.ok(moving.every(p=>p.body.collisionFilterMask===2&&p.body.shapes.length===1));
assert.equal(simulation._phoneBody.collisionFilterGroup,2);
assert.equal(simulation._phoneBody.collisionFilterMask,1);
assert.equal(simulation._particles[0].body.collisionFilterMask,0,'Attachment pins must not collide with their phone.');
simulation.reset();
let contactCount=0;
for(let frame=0;frame<360;frame++) {
  simulation.update(1/60);contactCount=Math.max(contactCount,simulation.world.contacts.length);
}
assert.ok(contactCount>0,'Enabled collisions must produce real Cannon contact equations.');
const minimumY = Math.min(...moving.map(p=>p.body.position.y));
assert.ok(minimumY>-.003,'The charm must remain above the phone surface: '+minimumY);
for(const contact of simulation.world.contacts) {
  assert.ok(contact.bi===simulation._phoneBody||contact.bj===simulation._phoneBody,'No charm self-collisions should be added.');
}

phone.position.set(.12,.05,-.07);phone.rotation.set(.2,-.1,.3);
simulation.update(1/60);
const expectedCenter = box.getCenter(new THREE.Vector3()).applyMatrix4(phone.matrixWorld);
assert.ok(expectedCenter.distanceTo(new THREE.Vector3().copy(simulation._phoneBody.position))<1e-8);
const expectedRotation = phone.getWorldQuaternion(new THREE.Quaternion());
const actualRotation = new THREE.Quaternion(simulation._phoneBody.quaternion.x,simulation._phoneBody.quaternion.y,
  simulation._phoneBody.quaternion.z,simulation._phoneBody.quaternion.w);
assert.ok(expectedRotation.angleTo(actualRotation)<1e-7,'The collision volume must rotate with the real phone.');
simulation.update(2);
assert.ok(expectedCenter.distanceTo(new THREE.Vector3().copy(simulation._phoneBody.position))<1e-8);

const count = simulation.world.constraints.length;
for(let repeat=0;repeat<10;repeat++) {
  simulation.collisionsEnabled=false;assert.equal(simulation.world.bodies.length,3);
  assert.ok(simulation.world.bodies.every(body=>body.collisionFilterMask===0));
  simulation.collisionsEnabled=true;assert.equal(simulation.world.bodies.length,4);
  assert.ok(moving.every(p=>p.body.shapes.length===1),'Toggling must not duplicate particle collision shapes.');
  assert.equal(simulation.world.constraints.length,count);
}
simulation.collisionsEnabled=false;
phone.position.set(0,0,0);phone.rotation.set(0,0,0);simulation.reset();
for(let frame=0;frame<360;frame++) simulation.update(1/60);
assert.equal(simulation.world.contacts.length,0);
assert.ok(Math.min(...moving.map(p=>p.body.position.y))<-.15,'Disabling must remove the collision response again.');
simulation.dispose();
assert.equal(simulation.world.bodies.length,0);assert.equal(simulation.world.constraints.length,0);

const rigidRoot = new THREE.Group();phone.add(rigidRoot);
rigidRoot.add(new THREE.Mesh(new THREE.BoxGeometry(.03,.06,.03),new THREE.MeshBasicMaterial()));
const rigid = new CharmPhysics({root:rigidRoot,phoneBounds:{object:phone,box}});
rigid.collisionsEnabled=true;
assert.equal(rigid._rigidBody.collisionFilterMask,2);
assert.equal(rigid.world.bodies.length,3);
rigid.collisionsEnabled=false;assert.equal(rigid._rigidBody.collisionFilterMask,0);
rigid.dispose();assert.equal(rigid.world.bodies.length,0);
console.log(JSON.stringify({contactCount,minimumY,phonePoseError:expectedRotation.angleTo(actualRotation)}));

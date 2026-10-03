const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
global.THREE = require('../vendor/three.min.js');
global.CANNON = require('../vendor/cannon.min.js');
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../scripts/charm-physics.js'), 'utf8'));

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/charms/hat.json'), 'utf8'));
const scene = new THREE.Scene();
const phone = new THREE.Group();
scene.add(phone);
const root = new THREE.Group();
root.rotation.x = Math.PI / 2;
root.scale.setScalar(0.1);
phone.add(root);
const node = new THREE.Group();
root.add(node);
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.meshes[0].positions, 3));
geometry.setIndex(data.meshes[0].indices);
const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
node.add(mesh);
const positions = new Float32Array(geometry.attributes.position.array);
const simulation = new CharmPhysics({ root, nodes: new Map([[data.physics.node, node]]), meshes: [mesh], physics: data.physics, phoneBounds: { object: phone, box: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)) } });
assert.equal(simulation.stats.particleCount, 60);
assert.equal(simulation.stats.pinnedCount, 4);
assert.equal(simulation.stats.pinnedRenderCount, 45);
assert.equal(simulation.world.bodies.length, 60, 'Phone bounds must not create a collision body.');
assert.ok(simulation.world.bodies.every(body => body.collisionFilterMask === 0), 'Charm physics must disable all collision pairs.');
const restError = Math.max(...positions.map((position, i) => Math.abs(position - geometry.attributes.position.array[i])));
assert.ok(restError < 1e-6, 'Rest skinning must preserve the original mesh.');
function assertFixedRender(simulation) {
  for (const mapping of simulation._mappings) for (const vertex of mapping.fixed) {
    for (let axis=0;axis<3;axis++) {
      const i=vertex*3+axis;
      assert.equal(mapping.position.array[i],mapping.restPositions[i],'Fixed render vertices must remain attached to the phone.');
    }
  }
  simulation._particles.forEach((p,i)=>{
    if(p.fixed) assert.ok(simulation._frames[i].angleTo(new THREE.Quaternion())<1e-8,
      'Fixed proxy frames must not rotate with moving cloth neighbors.');
  });
}

simulation.impulse(1);
for (let frame = 0; frame < 720; frame++) {
  phone.rotation.z = 0.4 * Math.sin(frame / 70);
  phone.position.x = 0.02 * Math.sin(frame / 25);
  simulation.update(1 / 60);
  assertFixedRender(simulation);
}
scene.updateMatrixWorld(true);
for (const particle of simulation._particles) {
  assert.ok(Number.isFinite(particle.body.position.x + particle.body.position.y + particle.body.position.z));
  if (particle.fixed) {
    const expected = particle.rest.clone().applyMatrix4(node.matrixWorld);
    assert.ok(expected.distanceTo(new THREE.Vector3().copy(particle.body.position)) < 1e-8, 'Pinned vertices must follow the phone without drift.');
  }
}
const deformation = Math.max(...positions.map((position, i) => Math.abs(position - geometry.attributes.position.array[i])));
assert.equal(simulation.world.contacts.length, 0, 'The charm must remain collision-free inside the phone bounds.');
assert.ok(deformation > 1e-3, 'The actual hat must deform after moving its attachment.');
const maxLengthError = Math.max(...simulation._links.map(link => Math.abs(link.constraint.distance - link.constraint.bodyA.position.distanceTo(link.constraint.bodyB.position)) / link.constraint.distance));
assert.ok(maxLengthError < 0.2, 'The cloth distance graph must remain bounded: ' + maxLengthError);

simulation.update(2);
const gapError = Math.max(...positions.map((position, i) => Math.abs(position - geometry.attributes.position.array[i])));
assert.ok(gapError < 1e-6, 'A hidden-tab time gap must reset velocity without advancing a huge timestep.');
simulation.enabled = false;
simulation.update(1 / 60);
assert.equal(simulation.world.constraints.length, simulation._links.length);
simulation.dispose();
assert.equal(simulation.world.bodies.length, 0);
assert.equal(simulation.world.constraints.length, 0);
assert.deepEqual(geometry.attributes.position.array, positions);

phone.position.set(0, 0, 0);
phone.rotation.set(0, 0, 0);
root.rotation.x = -Math.PI / 2;
root.scale.setScalar(0.69);
const flippedSimulation = new CharmPhysics({ root, nodes: new Map([[data.physics.node, node]]), meshes: [mesh], physics: data.physics });
const capCenter = () => {
  const cap = flippedSimulation._particles.slice(21);
  return cap.reduce((center, particle) => center.add(new THREE.Vector3().copy(particle.body.position)), new THREE.Vector3()).multiplyScalar(1 / cap.length);
};
const pinCenter = () => {
  const pins = flippedSimulation._particles.filter(particle => particle.fixed);
  return pins.reduce((center, particle) => center.add(new THREE.Vector3().copy(particle.body.position)), new THREE.Vector3()).multiplyScalar(1 / pins.length);
};
const initialFlippedHeight = capCenter().y - pinCenter().y;
const initialCapCenter = capCenter();
assert.equal(flippedSimulation._springs, undefined, 'The charm must not use springs to retain an imposed pose.');
for (let frame = 0; frame < 720; frame++) {
  flippedSimulation.update(1 / 60);
}
const settledFlippedHeight = capCenter().y - pinCenter().y;
assert.ok(capCenter().distanceTo(initialCapCenter) > initialFlippedHeight * 0.2, 'Gravity must deform the flexible charm instead of retaining an imposed pose.');
const beforeRotation = capCenter();
phone.rotation.z = 0.35;
flippedSimulation.update(1 / 60);
const immediatelyAfterRotation = capCenter();
scene.updateMatrixWorld(true);
const expectedRigidCenter = beforeRotation.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), 0.35);
assert.ok(immediatelyAfterRotation.distanceTo(expectedRigidCenter) > 0.001, 'The flipped hat must retain inertia when the phone rotates.');
for (let frame = 0; frame < 180; frame++) flippedSimulation.update(1 / 60);
assert.ok(capCenter().distanceTo(immediatelyAfterRotation) > 0.001, 'The flipped hat must move physically after the rotation.');
flippedSimulation.dispose();
root.rotation.x = Math.PI / 2;
root.scale.setScalar(0.1);

const proxyTransform = new THREE.Matrix4().makeRotationZ(0.3);
proxyTransform.setPosition(0.02, -0.04, 0.01);
const inverseProxy = proxyTransform.clone().invert();
const transformedData = JSON.parse(JSON.stringify(data.physics));
transformedData.proxyToNodeMatrix = proxyTransform.toArray();
transformedData.renderMappings[0].toProxyMatrix = inverseProxy.toArray();
for (let i = 0; i < transformedData.positions.length; i += 3) {
  const transformed = new THREE.Vector3().fromArray(data.physics.positions, i).applyMatrix4(inverseProxy);
  transformed.toArray(transformedData.positions, i);
}
const transformedSimulation = new CharmPhysics({ root, nodes: new Map([[data.physics.node, node]]), meshes: [mesh], physics: transformedData });
for (let i = 0; i < transformedSimulation._particles.length; i++) {
  const expected = new THREE.Vector3().fromArray(data.physics.positions, i * 3).applyMatrix4(node.matrixWorld);
  const actual = new THREE.Vector3().copy(transformedSimulation._particles[i].body.position);
  assert.ok(actual.distanceTo(expected) < 1e-8, 'A nonidentity proxy frame must preserve world-space rest positions.');
}
for(let frame=0;frame<120;frame++) {
  phone.rotation.y=.4*Math.sin(frame/20);transformedSimulation.update(1/60);
  assertFixedRender(transformedSimulation);
}
transformedSimulation.dispose();

const rigidRoot = new THREE.Group();
rigidRoot.position.set(0, 0.1, 0);
phone.add(rigidRoot);
const rigidMesh = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.06, 0.01), new THREE.MeshBasicMaterial());
rigidMesh.position.y = -0.03;
rigidRoot.add(rigidMesh);
const rigid = new CharmPhysics({ root: rigidRoot });
rigid.impulse();
for (let frame = 0; frame < 360; frame++) {
  phone.rotation.z = Math.sin(frame / 70) * 0.3;
  rigid.update(1 / 60);
}
const rigidPivot = rigidRoot.localToWorld(new THREE.Vector3());
const expectedPivot = phone.localToWorld(new THREE.Vector3(0, 0.1, 0));
assert.ok(rigidPivot.distanceTo(expectedPivot) < 0.001, 'The rigid charm attachment must remain constrained.');
rigid.dispose();

const skeletonRoot = new THREE.Group();
phone.add(skeletonRoot);
const first = new THREE.Bone(), second = new THREE.Bone(), tip = new THREE.Bone();
skeletonRoot.add(first);
first.add(second);
second.add(tip);
second.position.x = 0.05;
tip.position.x = 0.04;
const skeleton = new CharmPhysics({ root: skeletonRoot, nodes: new Map([['first', first], ['second', second], ['tip', tip]]), physics: { roots: ['first'] } });
const firstTwist = first.quaternion.clone();
for (let frame = 0; frame < 120; frame++) skeleton.update(1 / 60);
assert.ok(first.quaternion.angleTo(firstTwist) > 0.3, 'Bone rotations must respond to physical gravity.');
assert.ok(Math.abs(first.getWorldPosition(new THREE.Vector3()).distanceTo(second.getWorldPosition(new THREE.Vector3())) - 0.05) < 1e-8, 'Simulating bones must preserve their original local lengths.');
skeleton.dispose();
assert.ok(first.quaternion.angleTo(firstTwist) < 1e-6);

console.log(JSON.stringify({ particleCount: 60, pinnedCount: 4, restError, deformation, maxLengthError, gapError, rigidPivotError: rigidPivot.distanceTo(expectedPivot), initialFlippedHeight, settledFlippedHeight }));

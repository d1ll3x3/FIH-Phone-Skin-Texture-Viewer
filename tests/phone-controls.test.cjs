const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
global.THREE = require('../vendor/three.min.js');
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../scripts/phone-controls.js'), 'utf8'));

class Canvas {
  constructor() { this.listeners = new Map(); this.captured = new Set(); this.clientHeight = 800; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  removeEventListener(name) { this.listeners.delete(name); }
  hasPointerCapture(id) { return this.captured.has(id); }
  setPointerCapture(id) { this.captured.add(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  dispatch(type, values) {
    const event = Object.assign({
      pointerId: 1, pointerType: 'mouse', button: 0, clientX: 100, clientY: 100,
      timeStamp: 0, preventDefault() {}
    }, values);
    this.listeners.get(type)?.(event);
  }
}

const scene = new THREE.Scene();
const phone = new THREE.Group();
const anchor = new THREE.Object3D();
anchor.position.set(-0.25, 0.05, -0.15);
phone.add(anchor);
scene.add(phone);
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
camera.position.set(2, 1, 5);
camera.lookAt(new THREE.Vector3());
const element = new Canvas();
const orbit = {
  target: new THREE.Vector3(), mouseButtons: {}, touches: {}, enableDamping: true,
  saveState() {}, update() { camera.lookAt(this.target); }
};
const controls = new PhoneControls({ camera, element, phone, orbitControls: orbit });
const cameraPosition = camera.position.clone();
const cameraRotation = camera.quaternion.clone();
const anchorBefore = anchor.getWorldPosition(new THREE.Vector3());
assert.equal(orbit.enableRotate, false);
assert.equal(orbit.autoRotate, false);

element.dispatch('pointerdown', {});
element.dispatch('pointermove', { clientX: 220, clientY: 130, timeStamp: 20 });
assert.ok(phone.quaternion.angleTo(new THREE.Quaternion()) > 0.5, 'Dragging must rotate the phone.');
assert.ok(anchorBefore.distanceTo(anchor.getWorldPosition(new THREE.Vector3())) > 0.05, 'The physical charm anchor must move.');
assert.ok(camera.quaternion.angleTo(cameraRotation) < 1e-7, 'Dragging must keep the camera orientation fixed.');
element.dispatch('pointerup', { clientX: 220, clientY: 130, timeStamp: 21 });
const releaseRotation = phone.quaternion.clone();
controls.update(1 / 60);
assert.ok(phone.quaternion.angleTo(releaseRotation) > 0, 'A released drag should retain bounded momentum.');
for (let frame = 0; frame < 240; frame++) controls.update(1 / 60);
assert.ok(controls._velocity.length() < 0.005, 'Momentum must decay.');
assert.ok(camera.position.distanceTo(cameraPosition) < 1e-8);

const beforePan = phone.quaternion.clone();
element.dispatch('pointerdown', { button: 2, timeStamp: 300 });
element.dispatch('pointermove', { button: 2, clientX: 200, clientY: 200, timeStamp: 320 });
element.dispatch('pointerup', { button: 2, timeStamp: 330 });
assert.ok(phone.quaternion.angleTo(beforePan) < 1e-7, 'Right-button pan must not rotate the phone.');
element.dispatch('pointerdown', { shiftKey: true, timeStamp: 340 });
element.dispatch('pointermove', { clientX: 200, clientY: 200, timeStamp: 360 });
element.dispatch('pointerup', { timeStamp: 370 });
assert.ok(phone.quaternion.angleTo(beforePan) < 1e-7, 'Modifier-left pan must not rotate the phone.');

element.dispatch('pointerdown', { pointerId: 2, pointerType: 'touch', timeStamp: 400 });
element.dispatch('pointerdown', { pointerId: 3, pointerType: 'touch', timeStamp: 401 });
element.dispatch('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 200, timeStamp: 420 });
element.dispatch('pointermove', { pointerId: 3, pointerType: 'touch', clientX: 250, timeStamp: 421 });
assert.ok(phone.quaternion.angleTo(beforePan) < 1e-7, 'Two-finger pinch/pan must not rotate the phone.');
element.dispatch('pointerup', { pointerId: 3, pointerType: 'touch', timeStamp: 430 });
element.dispatch('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 210, timeStamp: 440 });
assert.ok(phone.quaternion.angleTo(beforePan) > 0.05, 'The remaining touch must resume phone rotation without a jump.');
element.dispatch('pointerup', { pointerId: 2, pointerType: 'touch', timeStamp: 530 });
assert.equal(controls._velocity.length(), 0, 'Holding still before release should not impart momentum.');

controls.setView('front');
for (let frame = 0; frame < 90; frame++) controls.update(1 / 60);
const front = new THREE.Vector3(0, 0, 1).applyQuaternion(phone.getWorldQuaternion(new THREE.Quaternion()));
const towardCamera = camera.position.clone().sub(orbit.target).normalize();
assert.ok(front.distanceTo(towardCamera) < 1e-5, 'Front preset must face the fixed camera.');
controls.setView('back');
for (let frame = 0; frame < 90; frame++) controls.update(1 / 60);
front.set(0, 0, -1).applyQuaternion(phone.getWorldQuaternion(new THREE.Quaternion()));
assert.ok(front.distanceTo(towardCamera) < 1e-5, 'Back preset must turn the phone, not orbit the camera.');
controls.setView('top');
for (let frame = 0; frame < 90; frame++) controls.update(1 / 60);
const top = new THREE.Vector3(0, 1, 0).applyQuaternion(phone.getWorldQuaternion(new THREE.Quaternion()));
assert.ok(top.distanceTo(towardCamera) < 1e-5, 'Top preset must point the phone top toward the fixed camera.');

controls.reset();
for (let frame = 0; frame < 90; frame++) controls.update(1 / 60);
assert.ok(phone.quaternion.angleTo(new THREE.Quaternion()) < 1e-7);
controls.autoRotate = true;
controls.update(1 / 60);
assert.ok(phone.quaternion.angleTo(new THREE.Quaternion()) > 0, 'Automatic rotation must move the phone.');
assert.ok(camera.position.distanceTo(cameraPosition) < 1e-8);
assert.ok(camera.quaternion.angleTo(cameraRotation) < 1e-7);
controls.dispose();
assert.equal(element.listeners.size, 0);
assert.equal(element.captured.size, 0);
console.log('Phone controls: drag, momentum, anchor motion, pan separation, touch, presets and cleanup passed.');

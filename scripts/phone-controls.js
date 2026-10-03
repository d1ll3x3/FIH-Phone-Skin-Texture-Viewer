(function (global) {
  'use strict';

  class PhoneControls {
    constructor({ camera, element, phone, orbitControls }) {
      if (!global.THREE || !camera || !element || !phone || !orbitControls) {
        throw new Error('Phone controls require a camera, canvas, phone and OrbitControls.');
      }
      this.camera = camera;
      this.element = element;
      this.phone = phone;
      this.orbit = orbitControls;
      this.autoRotate = false;
      this._pointers = new Map();
      this._velocity = new THREE.Vector3();
      this._rotation = new THREE.Quaternion();
      this._cameraQuaternion = new THREE.Quaternion();
      this._parentQuaternion = new THREE.Quaternion();
      this._axis = new THREE.Vector3();
      this._targetQuaternion = null;
      this._disposed = false;
      this.orbit.enableRotate = false;
      this.orbit.autoRotate = false;
      this.orbit.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      this.orbit.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
      this.orbit.mouseButtons.RIGHT = THREE.MOUSE.PAN;
      this.orbit.touches.ONE = THREE.TOUCH.ROTATE;
      this.orbit.touches.TWO = THREE.TOUCH.DOLLY_PAN;
      this._onDown = event => this._pointerDown(event);
      this._onMove = event => this._pointerMove(event);
      this._onUp = event => this._pointerUp(event);
      this._onCancel = event => this._pointerUp(event, true);
      element.addEventListener('pointerdown', this._onDown);
      element.addEventListener('pointermove', this._onMove);
      element.addEventListener('pointerup', this._onUp);
      element.addEventListener('pointercancel', this._onCancel);
      element.addEventListener('lostpointercapture', this._onCancel);
      this.saveCamera();
    }

    saveCamera() {
      this._defaultCamera = {
        position: this.camera.position.clone(),
        target: this.orbit.target.clone(),
        up: this.camera.up.clone(),
        zoom: this.camera.zoom
      };
      this.orbit.saveState();
    }

    _pointerDown(event) {
      const touch = event.pointerType === 'touch';
      const rotate = touch || (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey);
      this._pointers.set(event.pointerId, {
        x: event.clientX, y: event.clientY, time: event.timeStamp, rotate
      });
      this._velocity.set(0, 0, 0);
      if (rotate) this._targetQuaternion = null;
      if (!this.element.hasPointerCapture(event.pointerId)) {
        this.element.setPointerCapture(event.pointerId);
      }
    }

    _pointerMove(event) {
      const previous = this._pointers.get(event.pointerId);
      if (!previous) return;
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      const elapsed = Math.max(1 / 240, Math.min(0.1, (event.timeStamp - previous.time) / 1000));
      previous.x = event.clientX;
      previous.y = event.clientY;
      previous.time = event.timeStamp;
      if (this._pointers.size !== 1 || !previous.rotate) return;
      const height = Math.max(1, this.element.clientHeight);
      this._axis.set(dy, dx, 0).multiplyScalar(2 * Math.PI / height);
      const angle = Math.min(Math.PI / 2, this._axis.length());
      if (angle < 1e-8) return;
      // Drag axes follow the screen, while the phone and its anchors move in world space.
      this.camera.getWorldQuaternion(this._cameraQuaternion);
      this._axis.normalize().applyQuaternion(this._cameraQuaternion);
      this._applyRotation(this._axis, angle);
      this._velocity.multiplyScalar(0.4).addScaledVector(this._axis, Math.min(5, angle / elapsed) * 0.6);
      event.preventDefault();
    }

    _pointerUp(event, cancelled = false) {
      const previous = this._pointers.get(event.pointerId);
      if (!previous) return;
      this._pointers.delete(event.pointerId);
      if (cancelled || event.timeStamp - previous.time > 80 || this._pointers.size) {
        this._velocity.set(0, 0, 0);
      }
      // OrbitControls receives the same touch pointers for two-finger zoom and pan.
      if (this.element.hasPointerCapture(event.pointerId)) {
        this.element.releasePointerCapture(event.pointerId);
      }
    }

    _applyRotation(axis, angle) {
      this._rotation.setFromAxisAngle(axis, angle);
      if (this.phone.parent) {
        this.phone.parent.getWorldQuaternion(this._parentQuaternion);
        this._rotation.premultiply(this._parentQuaternion.clone().invert()).multiply(this._parentQuaternion);
      }
      this.phone.quaternion.premultiply(this._rotation).normalize();
      this.phone.updateWorldMatrix(true, true);
    }

    _restoreCamera(preserveDistance = false) {
      const defaults = this._defaultCamera;
      const distance = this.camera.position.distanceTo(this.orbit.target);
      const damping = this.orbit.enableDamping;
      this.orbit.enableDamping = false;
      this.orbit.update();
      this.orbit.enableDamping = damping;
      this.camera.position.copy(defaults.position);
      this.camera.up.copy(defaults.up);
      this.camera.zoom = defaults.zoom;
      this.orbit.target.copy(defaults.target);
      if (preserveDistance && distance > 0) {
        this.camera.position.sub(defaults.target).setLength(distance).add(defaults.target);
      }
      this.camera.updateProjectionMatrix();
      this.orbit.update();
    }

    setView(which) {
      if (which === 'reset') { this.reset(); return; }
      const directions = {
        front: [0, 0, 1], back: [0, 0, -1], left: [1, 0, 0],
        right: [-1, 0, 0], top: [0, 1, 0]
      };
      if (!directions[which]) return;
      this._restoreCamera(true);
      this._velocity.set(0, 0, 0);
      const direction = new THREE.Vector3().fromArray(directions[which]);
      const up = new THREE.Vector3(0, which === 'top' ? 0 : 1, which === 'top' ? 1 : 0);
      const viewRotation = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().lookAt(direction, new THREE.Vector3(), up)
      );
      this.camera.getWorldQuaternion(this._cameraQuaternion);
      this._targetQuaternion = this._cameraQuaternion.clone().multiply(viewRotation.invert());
      if (this.phone.parent) {
        this.phone.parent.getWorldQuaternion(this._parentQuaternion);
        this._targetQuaternion.premultiply(this._parentQuaternion.invert());
      }
    }

    reset() {
      this._restoreCamera();
      this._velocity.set(0, 0, 0);
      this._targetQuaternion = new THREE.Quaternion();
    }

    update(delta) {
      if (this._disposed) return;
      this.orbit.update();
      if (!Number.isFinite(delta) || delta < 0 || delta > 0.25) {
        this._velocity.set(0, 0, 0);
        return;
      }
      const dt = Math.min(delta, 0.05);
      if (this._pointers.size) return;
      if (this._targetQuaternion) {
        this.phone.quaternion.slerp(this._targetQuaternion, 1 - Math.exp(-16 * dt));
        if (this.phone.quaternion.angleTo(this._targetQuaternion) < 0.0001) {
          this.phone.quaternion.copy(this._targetQuaternion);
          this._targetQuaternion = null;
        }
      } else {
        const speed = this._velocity.length();
        if (speed > 0.005) {
          const decay = Math.exp(-8 * dt);
          this._axis.copy(this._velocity).normalize();
          this._applyRotation(this._axis, speed * (1 - decay) / 8);
          this._velocity.multiplyScalar(decay);
        } else this._velocity.set(0, 0, 0);
        if (this.autoRotate) {
          this._axis.set(0, 1, 0);
          this._applyRotation(this._axis, dt * Math.PI / 15);
        }
      }
      this.phone.updateWorldMatrix(true, true);
    }

    dispose() {
      if (this._disposed) return;
      this._disposed = true;
      this.element.removeEventListener('pointerdown', this._onDown);
      this.element.removeEventListener('pointermove', this._onMove);
      this.element.removeEventListener('pointerup', this._onUp);
      this.element.removeEventListener('pointercancel', this._onCancel);
      this.element.removeEventListener('lostpointercapture', this._onCancel);
      for (const pointerId of this._pointers.keys()) {
        if (this.element.hasPointerCapture(pointerId)) this.element.releasePointerCapture(pointerId);
      }
      this._pointers.clear();
      this._velocity.set(0, 0, 0);
    }
  }

  global.PhoneControls = PhoneControls;
})(typeof window !== 'undefined' ? window : globalThis);

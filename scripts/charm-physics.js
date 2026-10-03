(function (global) {
  'use strict';

  const STEP = 1 / 240;
  const MAX_STEPS = 12;
  const EPSILON = 1e-8;
  const vector = value => new THREE.Vector3().fromArray(value);
  const cannonVector = value => new CANNON.Vec3(value.x, value.y, value.z);
  const copyPosition = (body, value) => body.position.set(value.x, value.y, value.z);
  const fromBody = body => new THREE.Vector3(body.position.x, body.position.y, body.position.z);
  const bounded = (value, fallback, min, max) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

  class CharmPhysics {
    constructor({ root, nodes = new Map(), meshes = [], physics = {}, preset = null, phoneBounds = null }) {
      if (!global.THREE || !global.CANNON) throw new Error('Charm physics requires Three.js and Cannon.js.');
      if (!root) throw new Error('Charm physics requires an attached charm root.');
      this.root = root;
      this.nodes = nodes;
      this.physics = physics;
      this.meshes = meshes;
      this.gravityScale = 1;
      this.damping = 0.65;
      this._enabled = true;
      this._disposed = false;
      this._accumulator = 0;
      this._particles = [];
      this._links = [];
      this._mappings = [];
      this._phoneBounds = phoneBounds;
      this._phoneBody = null;
      this._collisionsEnabled = false;
      this._restRootPosition = root.position.clone();
      this._restRootQuaternion = root.quaternion.clone();
      this._space = nodeLookup(nodes, physics.node) || root;
      this._proxyTransform = physics.proxyToNodeMatrix ? new THREE.Matrix4().fromArray(physics.proxyToNodeMatrix) : new THREE.Matrix4();
      this._simulationMatrix = new THREE.Matrix4();
      root.updateWorldMatrix(true, true);
      this._updateSpaceMatrix();
      this.world = new CANNON.World();
      this.world.solver.iterations = 48;
      this.world.solver.tolerance = 1e-8;

      if ((physics.type === 'mesh' || physics.cloth) && (physics.cloth || physics).positions) {
        this.mode = 'mesh';
        this._buildCloth(physics.cloth || physics);
      } else if (physics.roots && physics.roots.length && nodes.size) {
        this.mode = 'bones';
        this._buildBones();
      } else {
        this.mode = 'rigid';
        this._buildRigid();
      }
      this.stats = {
        mode: this.mode,
        particleCount: this._particles.length,
        pinnedCount: this._particles.filter(p => p.fixed).length,
        pinnedRenderCount: this._mappings.reduce((sum, mapping) => sum + mapping.fixed.size, 0),
        linkCount: this._links.length
      };
      this._mc2 = null;
      if (preset || (physics.parameters && physics.parameters.mc2)) this.setPreset(preset || physics.parameters.mc2);
      this._onVisibility = () => { this._resume = true; this._accumulator = 0; };
      if (global.document) document.addEventListener('visibilitychange', this._onVisibility);
      this.reset();
    }

    get enabled() { return this._enabled; }
    set enabled(value) {
      const enabled = Boolean(value);
      if (enabled === this._enabled) return;
      this._enabled = enabled;
      this.reset();
    }

    setPreset(preset) {
      if (this.mode !== 'mesh') throw new Error('MC2 presets currently require a MeshCloth charm.');
      const validated = MC2Preset.validate(preset);
      if (this._mc2) this._mc2.dispose();
      this._mc2 = new MC2Preset.Constraints(this, validated, STEP);
      this.reset();
    }

    get collisionsEnabled() { return this._collisionsEnabled; }
    set collisionsEnabled(value) {
      const enabled = Boolean(value && this._phoneBounds);
      if (this._disposed || enabled === this._collisionsEnabled) return;
      this._collisionsEnabled = enabled;
      if (enabled) {
        const bounds = this._phoneBounds, scale = bounds.object.getWorldScale(new THREE.Vector3());
        const half = bounds.box.getSize(new THREE.Vector3()).multiply(scale).multiplyScalar(.5);
        const body = new CANNON.Body({mass:0,type:CANNON.Body.KINEMATIC});
        body.addShape(new CANNON.Box(cannonVector(half)));
        body.collisionFilterGroup = 2; body.collisionFilterMask = 1;
        this._phoneBody = body; this.world.addBody(body);
        this._syncPhoneBody();
        const lengths = this._links.filter(link => !link.secondary).map(link => link.constraint.distance).sort((a,b) => a-b);
        const height = half.y * 2;
        const radius = Math.max(height * .002, Math.min(height * .02, (lengths[Math.floor(lengths.length / 2)] || height * .04) * .25));
        for (const p of this._particles) {
          if (!p.fixed && !p.body.shapes.length) p.body.addShape(new CANNON.Sphere(radius));
        }
        this.world.defaultContactMaterial.friction = .15;
        this.world.defaultContactMaterial.restitution = 0;
      } else {
        this.world.removeBody(this._phoneBody); this._phoneBody = null;
      }
      for (const p of this._particles) p.body.collisionFilterMask = enabled && !p.fixed ? 2 : 0;
      if (this._rigidBody) { this._rigidBody.collisionFilterGroup = 1; this._rigidBody.collisionFilterMask = enabled ? 2 : 0; }
      if (this._mc2) this._mc2.wake();
      this._particles.forEach(p => p.body.wakeUp());
      if (this._rigidBody) this._rigidBody.wakeUp();
    }

    _phonePose() {
      const {object,box} = this._phoneBounds;
      object.updateWorldMatrix(true,false);
      return {position:box.getCenter(new THREE.Vector3()).applyMatrix4(object.matrixWorld),
        quaternion:object.getWorldQuaternion(new THREE.Quaternion())};
    }

    _syncPhoneBody() {
      if (!this._phoneBody) return;
      const pose = this._phonePose(), q = pose.quaternion;
      copyPosition(this._phoneBody,pose.position);
      this._phoneBody.quaternion.set(q.x,q.y,q.z,q.w);
      this._clearBody(this._phoneBody);
    }

    _phoneStep(target,remaining) {
      const body = this._phoneBody, position = this._anchorStep(body,target.position,remaining);
      const previous = new THREE.Quaternion(body.quaternion.x,body.quaternion.y,body.quaternion.z,body.quaternion.w);
      const quaternion = previous.clone().slerp(target.quaternion,1 / remaining);
      const rotation = quaternion.clone().multiply(previous.invert());
      if (rotation.w < 0) rotation.set(-rotation.x,-rotation.y,-rotation.z,-rotation.w);
      const angle = 2 * Math.acos(bounded(rotation.w,1,-1,1));
      const sine = Math.sqrt(Math.max(0,1-rotation.w*rotation.w));
      if (sine > EPSILON) body.angularVelocity.set(rotation.x*angle/sine/STEP,rotation.y*angle/sine/STEP,rotation.z*angle/sine/STEP);
      else body.angularVelocity.setZero();
      return {position,quaternion};
    }

    _addParticle(rest, fixed, extra = {}) {
      const body = new CANNON.Body({ mass: fixed ? 0 : 0.001, type: fixed ? CANNON.Body.KINEMATIC : CANNON.Body.DYNAMIC });
      body.collisionFilterMask = 0;
      body.fixedRotation = true;
      body.updateMassProperties();
      body.linearDamping = this.damping;
      this.world.addBody(body);
      const particle = Object.assign({ rest, fixed, body }, extra);
      this._particles.push(particle);
      return particle;
    }

    _addLink(a, b, restLength, secondary = false, stiffness = null) {
      if (a === b || restLength < EPSILON) return;
      const pa = this._particles[a], pb = this._particles[b];
      if (!pa || !pb) return;
      const direction = pb.rest.clone().sub(pa.rest);
      const scaleLength = this._worldDirection(direction).length();
      const localLength = direction.length();
      const constraint = new CANNON.DistanceConstraint(pa.body, pb.body, restLength * scaleLength / localLength, 1e5);
      constraint.collideConnected = false;
      constraint.equations.forEach(e => e.setSpookParams(stiffness || (secondary ? 2000 : 1e7), secondary ? 6 : 3, STEP));
      this.world.addConstraint(constraint);
      this._links.push({ a, b, restLength, direction, secondary, constraint,
        bending: stiffness != null, baselineStiffness: stiffness || (secondary ? 2000 : 1e7) });
    }

    _worldDirection(direction) {
      const e = this._simulationMatrix.elements;
      return new THREE.Vector3(
        e[0] * direction.x + e[4] * direction.y + e[8] * direction.z,
        e[1] * direction.x + e[5] * direction.y + e[9] * direction.z,
        e[2] * direction.x + e[6] * direction.y + e[10] * direction.z
      );
    }

    _updateSpaceMatrix() {
      this._space.updateWorldMatrix(true, false);
      this._simulationMatrix.multiplyMatrices(this._space.matrixWorld, this._proxyTransform);
    }

    _buildCloth(cloth) {
      if (cloth.positions.length % 3 || cloth.positions.length > 6000) throw new Error('Invalid or excessively large charm cloth proxy.');
      const count = cloth.positions.length / 3;
      const fixed = new Set(cloth.fixed || []);
      if (!fixed.size) throw new Error('Charm cloth has no fixed attachment vertices.');
      for (let i = 0; i < count; i++) this._addParticle(vector(cloth.positions.slice(i * 3, i * 3 + 3)), fixed.has(i));
      const seen = new Set();
      for (const link of cloth.links || []) {
        const a = link[0], b = link[1], key = Math.min(a, b) + ':' + Math.max(a, b);
        if (!seen.has(key)) {
          seen.add(key);
          this._addLink(a, b, Math.abs(link[2]), Boolean(link[3]) || link[2] < 0);
        }
      }
      if (!this._links.length) throw new Error('Charm cloth has no structural constraints.');
      this._triangles = cloth.triangles || [];
      this._frameNeighbors = this._particles.map(() => []);
      for (let i = 0; i < this._triangles.length; i += 3) {
        const [a, b, c] = this._triangles.slice(i, i + 3);
        if (!this._particles[a] || !this._particles[b] || !this._particles[c]) continue;
        this._frameNeighbors[a].push([b, c]);
        this._frameNeighbors[b].push([c, a]);
        this._frameNeighbors[c].push([a, b]);
      }
      // Opposite vertices across an edge retain the cloth's rest bend without a Unity runtime.
      const addBend = (a, b) => {
        if (!this._particles[a] || !this._particles[b] || a === b) return;
        const bendKey = Math.min(a, b) + ':' + Math.max(a, b);
        if (seen.has(bendKey)) {
          const link = this._links.find(link => (link.a === a && link.b === b) || (link.a === b && link.b === a));
          if (link && link.secondary) {
            link.bending = true; link.baselineStiffness = 15000;
            link.constraint.equations.forEach(e => e.setSpookParams(15000, 6, STEP));
          }
        } else {
          seen.add(bendKey);
          this._addLink(a, b, this._particles[a].rest.distanceTo(this._particles[b].rest), true, 15000);
        }
      };
      for (const pair of (cloth.bending && cloth.bending.pairs) || []) addBend(pair[2], pair[3]);
      const triangleEdges = new Map();
      for (let i = 0; i < this._triangles.length; i += 3) {
        const [a, b, c] = this._triangles.slice(i, i + 3);
        for (const [u, v, opposite] of [[a, b, c], [b, c, a], [c, a, b]]) {
          const key = Math.min(u, v) + ':' + Math.max(u, v);
          const previous = triangleEdges.get(key);
          if (previous !== undefined && previous !== opposite && this._particles[previous] && this._particles[opposite]) {
            addBend(previous, opposite);
          } else triangleEdges.set(key, opposite);
        }
      }
      const rest = this._particles.map(p => p.rest);
      this._lineTargets = this._particles.map((p, i) => {
        if (this._frameNeighbors[i].length) return null;
        const parent = cloth.parentIndices && cloth.parentIndices[i];
        if (Number.isInteger(parent) && parent >= 0 && parent !== i && this._particles[parent]) return parent;
        const link = this._links.find(link => link.a === i || link.b === i);
        return link ? (link.a === i ? link.b : link.a) : null;
      });
      this._restFrames = rest.map((p, i) => this._particleFrame(i, rest).invert());
      this._frames = rest.map(() => new THREE.Quaternion());
      this._proxyLocal = rest.map(p => p.clone());
      for (const mapping of cloth.renderMappings || cloth.mappings || []) {
        const mesh = meshesLookup(this.meshes, mapping.mesh);
        if (!mesh || !mesh.geometry || !mesh.geometry.attributes.position) continue;
        const position = mesh.geometry.attributes.position;
        if (mapping.indices.length !== position.count * 4 || mapping.weights.length !== position.count * 4) throw new Error('Charm render mapping does not match its mesh.');
        const matrix = mapping.toProxyMatrix ? new THREE.Matrix4().fromArray(mapping.toProxyMatrix) : new THREE.Matrix4();
        const restPositions = new Float32Array(position.array);
        const renderRest = [];
        for (let i = 0; i < position.count; i++) renderRest.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix));
        this._mappings.push({ mesh, position, restPositions, renderRest, indices: mapping.indices, weights: mapping.weights,
          fixed: new Set(mapping.fixed || []), inverse: matrix.clone().invert() });
        mesh.frustumCulled = false;
        position.setUsage(THREE.DynamicDrawUsage);
      }
      if (!this._mappings.length) throw new Error('Charm cloth has no usable render mapping.');
    }

    _particleFrame(index, positions) {
      const point = positions[index];
      const normal = new THREE.Vector3();
      let tangent = null;
      for (const [a, b] of this._frameNeighbors[index]) {
        const u = positions[a].clone().sub(point), v = positions[b].clone().sub(point);
        normal.add(new THREE.Vector3().crossVectors(u, v));
        if (!tangent && u.lengthSq() > EPSILON) tangent = u;
      }
      if (!tangent || normal.lengthSq() < EPSILON) return new THREE.Quaternion();
      normal.normalize();
      tangent.addScaledVector(normal, -tangent.dot(normal));
      if (tangent.lengthSq() < EPSILON) return new THREE.Quaternion();
      tangent.normalize();
      const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();
      return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(tangent, bitangent, normal));
    }

    _buildBones() {
      const fixed = new Set((this.physics.fixed || []).map(String));
      const selected = new Set();
      for (const id of this.physics.roots) {
        const bone = nodeLookup(this.nodes, id);
        if (bone) bone.traverse(child => { if (child.isBone) selected.add(child); });
      }
      const inverse = this._simulationMatrix.clone().invert();
      const byBone = new Map();
      const idByBone = new Map(Array.from(this.nodes.entries()).map(([id, bone]) => [bone, id]));
      for (const bone of selected) {
        const isFixed = !selected.has(bone.parent) || fixed.has(String(idByBone.get(bone)));
        const rest = bone.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverse);
        byBone.set(bone, this._particles.length);
        this._addParticle(rest, isFixed, { bone, restQuaternion: bone.quaternion.clone(), restPosition: bone.position.clone() });
      }
      for (const particle of this._particles) {
        if (byBone.has(particle.bone.parent)) {
          const a = byBone.get(particle.bone.parent), b = byBone.get(particle.bone);
          this._addLink(a, b, this._particles[a].rest.distanceTo(particle.rest));
        }
      }
      this._byBone = byBone;
    }

    _buildRigid() {
      this._space = this.root.parent || this.root;
      this._updateSpaceMatrix();
      this.root.updateWorldMatrix(true, true);
      const inverse = this.root.matrixWorld.clone().invert();
      const bounds = new THREE.Box3();
      this.root.traverse(mesh => {
        if (!mesh.isMesh || !mesh.geometry.attributes.position) return;
        const attribute = mesh.geometry.attributes.position;
        const local = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
        for (let i = 0; i < attribute.count; i++) bounds.expandByPoint(new THREE.Vector3().fromBufferAttribute(attribute, i).applyMatrix4(local));
      });
      if (bounds.isEmpty()) throw new Error('Charm has no geometry to simulate.');
      const center = bounds.getCenter(new THREE.Vector3());
      const scale = this.root.getWorldScale(new THREE.Vector3());
      const half = bounds.getSize(new THREE.Vector3()).multiply(scale).multiplyScalar(0.5);
      half.set(Math.max(Math.abs(half.x), 0.0005), Math.max(Math.abs(half.y), 0.0005), Math.max(Math.abs(half.z), 0.0005));
      const pivot = this.physics.attachment ? vector(this.physics.attachment) : new THREE.Vector3();
      this._rigidCenter = center;
      this._rigidPivot = pivot;
      this._rigidScale = scale;
      this._rigidBody = new CANNON.Body({ mass: 0.02 });
      this._rigidBody.addShape(new CANNON.Box(cannonVector(half)));
      this._rigidBody.collisionFilterMask = 0;
      this.world.addBody(this._rigidBody);
      this._rigidAnchor = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC });
      this._rigidAnchor.collisionFilterMask = 0;
      this.world.addBody(this._rigidAnchor);
      const constraint = new CANNON.PointToPointConstraint(this._rigidBody, cannonVector(pivot.clone().sub(center).multiply(scale)), this._rigidAnchor, new CANNON.Vec3(), 1e5);
      this.world.addConstraint(constraint);
      this._rigidConstraint = constraint;
    }

    _clearBody(body) {
      body.velocity.setZero();
      body.angularVelocity.setZero();
      body.force.setZero();
      body.torque.setZero();
      body.aabbNeedsUpdate = true;
      body.wakeUp();
    }

    reset() {
      if (this._disposed) return;
      this._accumulator = 0;
      this._resume = false;
      if (this.mode === 'rigid') {
        this.root.position.copy(this._restRootPosition);
        this.root.quaternion.copy(this._restRootQuaternion);
      }
      if (this.mode === 'bones') for (const p of this._particles) {
        p.bone.position.copy(p.restPosition);
        p.bone.quaternion.copy(p.restQuaternion);
      }
      this.root.updateWorldMatrix(true, true);
      this._updateSpaceMatrix();
      if (this._mc2) this._mc2.reset();
      this._syncPhoneBody();
      for (const particle of this._particles) {
        const target = particle.rest.clone().applyMatrix4(this._simulationMatrix);
        copyPosition(particle.body, target);
        particle.body.previousPosition.copy(particle.body.position);
        particle.body.interpolatedPosition.copy(particle.body.position);
        this._clearBody(particle.body);
      }
      if (this.mode === 'rigid') {
        copyPosition(this._rigidBody, this.root.localToWorld(this._rigidCenter.clone()));
        const q = this.root.getWorldQuaternion(new THREE.Quaternion());
        this._rigidBody.quaternion.set(q.x, q.y, q.z, q.w);
        copyPosition(this._rigidAnchor, this.root.localToWorld(this._rigidPivot.clone()));
        this._clearBody(this._rigidBody);
        this._clearBody(this._rigidAnchor);
      }
      this._applyVisuals();
    }

    _anchorStep(body, target, remaining) {
      const current = fromBody(body), next = current.clone().lerp(target, 1 / remaining);
      body.velocity.set((next.x - current.x) / STEP, (next.y - current.y) / STEP, (next.z - current.z) / STEP);
      return next;
    }

    update(delta) {
      if (this._disposed || !this._enabled) return;
      if (global.document && document.hidden) { this._resume = true; return; }
      if (this._resume || !Number.isFinite(delta) || delta > 0.25) { this.reset(); return; }
      this.root.updateWorldMatrix(true, true);
      this._accumulator = Math.min(this._accumulator + Math.max(0, delta), MAX_STEPS * STEP);
      const steps = Math.floor((this._accumulator + 1e-10) / STEP);
      if (!steps) return;
      this._updateSpaceMatrix();
      if (this._mc2) {
        const preset = this._mc2.preset, direction = new THREE.Vector3(preset.gravityDirection.x,
          preset.gravityDirection.y, -preset.gravityDirection.z).normalize().multiplyScalar(preset.gravity);
        this.world.gravity.set(direction.x, direction.y, direction.z);
        this._mc2.transport(steps * STEP);
        if (this._mc2.sleeping) { this._accumulator = 0; return; }
      } else this.world.gravity.set(0, -9.81 * bounded(this.gravityScale, 1, 0, 3), 0);
      const damping = bounded(this.damping, 0.65, 0, 0.99);
      const targets = this._particles.map(p => p.fixed ? p.rest.clone().applyMatrix4(this._simulationMatrix) : null);
      const phoneTarget = this._phoneBody ? this._phonePose() : null;
      const rigidTarget = this.mode === 'rigid' ? this._rigidPivot.clone().applyMatrix4(new THREE.Matrix4().compose(this._restRootPosition, this._restRootQuaternion, this.root.scale)).applyMatrix4(this._space.matrixWorld) : null;
      for (const link of this._links) link.constraint.distance = link.restLength * this._worldDirection(link.direction).length() / link.direction.length();
      for (let i = 0; i < steps; i++) {
        const remaining = steps - i;
        const phoneStep = phoneTarget ? this._phoneStep(phoneTarget,remaining) : null;
        const anchors = this._particles.map((p, index) => {
          p.body.linearDamping = this._mc2 ? bounded(MC2Preset.curve(this._mc2.preset.damping,
            this._mc2.depths[index]), 0, 0, .99) : damping;
          return p.fixed ? this._anchorStep(p.body, targets[index], remaining) : null;
        });
        let rigidAnchor;
        if (this.mode === 'rigid') {
          this._rigidBody.linearDamping = damping;
          this._rigidBody.angularDamping = damping;
          rigidAnchor = this._anchorStep(this._rigidAnchor, rigidTarget, remaining);
        }
        this.world.step(STEP);
        if (this._mc2) { this._mc2.dampRestMotion(); this._mc2.limitVelocities(); }
        anchors.forEach((target, index) => { if (target) copyPosition(this._particles[index].body, target); });
        if (rigidAnchor) copyPosition(this._rigidAnchor, rigidAnchor);
        if (phoneStep) {
          copyPosition(this._phoneBody,phoneStep.position);
          const q = phoneStep.quaternion;
          this._phoneBody.quaternion.set(q.x,q.y,q.z,q.w);
          this._phoneBody.aabbNeedsUpdate = true;
        }
        this._accumulator = Math.max(0, this._accumulator - STEP);
      }
      if (!this._validState()) { this.reset(); return; }
      if (this._mc2) this._mc2.settle(steps * STEP);
      this._applyVisuals();
    }

    _validState() {
      const bodies = this.mode === 'rigid' ? [this._rigidBody] : this._particles.map(p => p.body);
      return bodies.every(body => Number.isFinite(body.position.x) && Number.isFinite(body.position.y) &&
        Number.isFinite(body.position.z) && Number.isFinite(body.velocity.norm()) &&
        (body.type === CANNON.Body.KINEMATIC || body.velocity.norm() < 100));
    }

    _applyVisuals() {
      if (this.mode === 'mesh') {
        const inverse = this._simulationMatrix.clone().invert();
        this._particles.forEach((p, i) => this._proxyLocal[i].copy(fromBody(p.body)).applyMatrix4(inverse));
        this._frames.forEach((q, i) => {
          if (this._particles[i].fixed) { q.identity(); return; }
          const lineTarget = this._lineTargets[i];
          if (lineTarget !== null) {
            const original = this._particles[lineTarget].rest.clone().sub(this._particles[i].rest);
            const current = this._proxyLocal[lineTarget].clone().sub(this._proxyLocal[i]);
            if (original.lengthSq() > EPSILON && current.lengthSq() > EPSILON) q.setFromUnitVectors(original.normalize(), current.normalize());
            else q.identity();
          } else q.copy(this._particleFrame(i, this._proxyLocal)).multiply(this._restFrames[i]);
        });
        const output = new THREE.Vector3(), offset = new THREE.Vector3();
        for (const mapping of this._mappings) {
          for (let vertex = 0; vertex < mapping.position.count; vertex++) {
            // Fixed render vertices belong to the phone, not the cloth's blended deformation.
            if (mapping.fixed.has(vertex)) {
              const i = vertex * 3;
              mapping.position.setXYZ(vertex, mapping.restPositions[i], mapping.restPositions[i + 1], mapping.restPositions[i + 2]);
              continue;
            }
            output.set(0, 0, 0);
            let weightSum = 0;
            for (let slot = 0; slot < 4; slot++) {
              const index = mapping.indices[vertex * 4 + slot], weight = mapping.weights[vertex * 4 + slot];
              if (!(weight > 0) || !this._particles[index]) continue;
              offset.copy(mapping.renderRest[vertex]).sub(this._particles[index].rest).applyQuaternion(this._frames[index]).add(this._proxyLocal[index]);
              output.addScaledVector(offset, weight);
              weightSum += weight;
            }
            if (weightSum > EPSILON) output.multiplyScalar(1 / weightSum);
            else output.copy(mapping.renderRest[vertex]);
            output.applyMatrix4(mapping.inverse);
            mapping.position.setXYZ(vertex, output.x, output.y, output.z);
          }
          mapping.position.needsUpdate = true;
          mapping.mesh.geometry.computeVertexNormals();
          mapping.mesh.geometry.computeBoundingSphere();
        }
      } else if (this.mode === 'bones') {
        for (const particle of this._particles) {
          const bone = particle.bone;
          const children = bone.children.filter(child => this._byBone.has(child));
          if (!children.length) continue;
          bone.quaternion.copy(particle.restQuaternion);
          bone.updateWorldMatrix(true, false);
          const parentWorld = bone.parent.getWorldQuaternion(new THREE.Quaternion());
          const worldRest = parentWorld.clone().multiply(particle.restQuaternion);
          const restDirection = new THREE.Vector3(), targetDirection = new THREE.Vector3();
          for (const child of children) {
            const target = this._particles[this._byBone.get(child)];
            restDirection.add(child.position.clone().multiply(bone.getWorldScale(new THREE.Vector3())).applyQuaternion(worldRest));
            targetDirection.add(fromBody(target.body).sub(fromBody(particle.body)));
          }
          if (restDirection.lengthSq() > EPSILON && targetDirection.lengthSq() > EPSILON) {
            const swing = new THREE.Quaternion().setFromUnitVectors(restDirection.normalize(), targetDirection.normalize());
            bone.quaternion.copy(parentWorld.invert().multiply(swing.multiply(worldRest)));
            bone.updateWorldMatrix(false, true);
          }
        }
      } else {
        const body = this._rigidBody;
        const worldQ = new THREE.Quaternion(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
        const parentQ = this._space.getWorldQuaternion(new THREE.Quaternion());
        this.root.quaternion.copy(parentQ.invert().multiply(worldQ));
        const centerOffset = this._rigidCenter.clone().multiply(this._rigidScale).applyQuaternion(worldQ);
        const origin = fromBody(body).sub(centerOffset);
        this.root.position.copy(this._space.worldToLocal(origin));
        this.root.updateWorldMatrix(false, true);
      }
    }

    impulse(strength = 1) {
      if (!this._enabled || this._disposed) return;
      if (this._mc2) this._mc2.wake();
      const magnitude = bounded(strength, 1, 0, 5);
      const direction = new THREE.Vector3(0.75, 0.15, 0.4).normalize();
      if (this.mode === 'rigid') {
        this._rigidBody.applyImpulse(cannonVector(direction.multiplyScalar(0.006 * magnitude)), this._rigidBody.position);
      } else {
        const lengths = this._links.map(link => link.constraint.distance).sort((a, b) => a - b);
        const speed = (lengths[Math.floor(lengths.length / 2)] || 0.02) * 12 * magnitude;
        for (const p of this._particles) if (!p.fixed) p.body.applyImpulse(cannonVector(direction.clone().multiplyScalar(p.body.mass * speed)), p.body.position);
      }
    }

    dispose() {
      if (this._disposed) return;
      this.reset();
      if (global.document) document.removeEventListener('visibilitychange', this._onVisibility);
      for (const mapping of this._mappings) {
        mapping.position.array.set(mapping.restPositions);
        mapping.position.needsUpdate = true;
        mapping.mesh.geometry.computeVertexNormals();
        mapping.mesh.geometry.computeBoundingSphere();
      }
      this.world.constraints.slice().forEach(constraint => this.world.removeConstraint(constraint));
      this.world.bodies.slice().forEach(body => this.world.removeBody(body));
      this._phoneBody = null; this._collisionsEnabled = false;
      this._disposed = true;
    }
  }

  function meshesLookup(meshes, id) {
    return meshes instanceof Map ? meshes.get(id) : meshes[id];
  }

  function nodeLookup(nodes, id) {
    return nodes && nodes.get ? nodes.get(id) || nodes.get(String(id)) : null;
  }

  global.CharmPhysics = CharmPhysics;
})(typeof window === 'undefined' ? globalThis : window);

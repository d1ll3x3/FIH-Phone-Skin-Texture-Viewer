(function (global) {
  'use strict';
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  // Cannon's angular equations need a softer response than MC2's correction strengths.
  const ANGULAR_RESPONSE = {restoration: 0.08, limit: 0.1};
  const sections = ['inertiaConstraint', 'tetherConstraint', 'distanceConstraint',
    'triangleBendingConstraint', 'angleRestorationConstraint', 'angleLimitConstraint'];

  function validate(preset) {
    if (!preset || preset.clothType !== 0 || !sections.every(key => preset[key] && typeof preset[key] === 'object')) {
      throw new Error('Choose an MC2 MeshCloth preset.');
    }
    function finiteTree(value, depth = 0) {
      if (depth > 12) throw new Error('Invalid MC2 preset.');
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid MC2 number.');
      if (Array.isArray(value)) {
        if (value.length > 256) throw new Error('MC2 curve is too large.');
        value.forEach(v => finiteTree(v, depth + 1));
      } else if (value && typeof value === 'object') {
        Object.values(value).forEach(v => finiteTree(v, depth + 1));
      }
    }
    finiteTree(preset);
    if (!Number.isFinite(preset.gravity) || preset.gravity < 0 || preset.gravity > 100 ||
        !preset.gravityDirection || !['x', 'y', 'z'].every(k => Number.isFinite(preset.gravityDirection[k]))) {
      throw new Error('Invalid MC2 gravity.');
    }
    for (const parameter of [preset.damping, preset.distanceConstraint.stiffness,
      preset.angleRestorationConstraint.stiffness, preset.angleLimitConstraint.limitAngle]) {
      if (!parameter || !Number.isFinite(parameter.value) || typeof parameter.useCurve !== 'boolean') {
        throw new Error('Invalid MC2 curve parameter.');
      }
      if (parameter.useCurve) {
        const keys = parameter.curve && parameter.curve.m_Curve;
        if (!Array.isArray(keys) || !keys.length || !keys.every((key, i) =>
          ['time', 'value', 'inSlope', 'outSlope'].every(k => Number.isFinite(key[k])) &&
          (!i || key.time > keys[i - 1].time))) throw new Error('Invalid MC2 animation curve.');
        if (keys.some(k => k.weightedMode)) throw new Error('Weighted MC2 curves are not supported.');
      }
    }
    for (const [value, lo, hi] of [[preset.inertiaConstraint.worldInertia, 0, 1],
      [preset.inertiaConstraint.movementInertiaSmoothing, 0, 1],
      [preset.tetherConstraint.distanceCompression, 0, 1],
      [preset.triangleBendingConstraint.stiffness, 0, 1],
      [preset.angleRestorationConstraint.velocityAttenuation, 0, 1],
      [preset.angleLimitConstraint.stiffness, 0, 1]]) {
      if (!Number.isFinite(value) || value < lo || value > hi) throw new Error('Invalid MC2 constraint value.');
    }
    for (const key of ['movementSpeedLimit', 'rotationSpeedLimit', 'particleSpeedLimit']) {
      const limit = preset.inertiaConstraint[key];
      if (!limit || typeof limit.use !== 'boolean' || !Number.isFinite(limit.value) || limit.value < 0 || limit.value > 10000) {
        throw new Error('Invalid MC2 speed limit.');
      }
    }
    return JSON.parse(JSON.stringify(preset));
  }

  function curve(parameter, depth, curveScale = 1) {
    if (!parameter.useCurve) return parameter.value;
    const keys = parameter.curve.m_Curve, t = clamp(depth, 0, 1);
    if (t <= keys[0].time) return keys[0].value * curveScale;
    if (t >= keys[keys.length - 1].time) return keys[keys.length - 1].value * curveScale;
    let i = 1;
    while (keys[i].time < t) i++;
    const a = keys[i - 1], b = keys[i], duration = b.time - a.time, u = (t - a.time) / duration;
    const u2 = u * u, u3 = u2 * u;
    return ((2 * u3 - 3 * u2 + 1) * a.value + (u3 - 2 * u2 + u) * duration * a.outSlope +
      (-2 * u3 + 3 * u2) * b.value + (u3 - u2) * duration * b.inSlope) * curveScale;
  }

  // MC2's per-correction strengths are mapped to Cannon compliance, not pin-to-mesh springs.
  function stiffness(strength, inverseMass, step) {
    const alpha = 1 - Math.pow(1 - clamp(strength, 0, 1), step * 60);
    if (alpha >= 0.9999) return 1e7;
    return Math.max(1e-6, 4 / (step * step * Math.max(1e-8, inverseMass * (1 - alpha) / Math.max(alpha, 1e-8)) * 13));
  }

  class MC2Constraints {
    constructor(simulation, source, step) {
      this.simulation = simulation;
      this.preset = validate(source);
      this.step = step;
      this.constraints = [];
      const particles = simulation._particles, cloth = simulation.physics.cloth || simulation.physics;
      const parents = cloth.parentIndices || [];
      this.depths = cloth.depths || this._deriveDepths(parents, particles);
      this._previousMatrix = simulation._simulationMatrix.clone();
      this._filteredMotion = particles.map(() => new THREE.Vector3());
      this.sleeping = false; this._idleTime = 0; this._stableTime = 0; this._averagePose = null;
      const ordered = particles.map((p, i) => i).sort((a, b) => this.depths[a] - this.depths[b]);
      for (const i of ordered) {
        const parent = parents[i];
        if (particles[i].fixed || !Number.isInteger(parent) || parent < 0 || parent === i || !particles[parent]) continue;
        if (this.preset.angleRestorationConstraint.useAngleRestoration) this._addAngle(i, parent, parents[parent], false);
        if (this.preset.angleLimitConstraint.useAngleLimit) this._addAngle(i, parent, parents[parent], true);
        let root = cloth.rootIndices && cloth.rootIndices[i];
        if (!Number.isInteger(root) || root < 0 || root === i || !particles[root]) {
          root = parent;
          const visited = new Set([i]);
          while (parents[root] >= 0 && !particles[root].fixed && !visited.has(root)) {
            visited.add(root); root = parents[root];
          }
        }
        if (root !== i && particles[root]) this._addTether(i, root);
      }
      for (const link of simulation._links) {
        const depth = (this.depths[link.a] + this.depths[link.b]) / 2;
        const strength = link.bending ? this.preset.triangleBendingConstraint.stiffness :
          clamp(curve(this.preset.distanceConstraint.stiffness, depth), 0, 1);
        // Retain the existing distance/bending solver; the preset sets its strength.
        const base = link.baselineStiffness;
        link.constraint.equations.forEach(e => {
          e.setSpookParams(Math.max(1e-6, base * strength), link.secondary ? 6 : 3, step);
          e.enabled = strength > 0;
        });
      }
      simulation.stats.preset = 'MC2';
      simulation.stats.angleCount = this.constraints.filter(c => c.kind === 'angle').length;
      simulation.stats.tetherCount = this.constraints.filter(c => c.kind === 'tether').length;
    }

    _deriveDepths(parents, particles) {
      const lengths = particles.map(() => 0), done = new Set();
      function length(i, visited = new Set()) {
        if (done.has(i)) return lengths[i];
        if (visited.has(i)) return 0;
        visited.add(i);
        const p = parents[i];
        if (p >= 0 && particles[p] && !particles[i].fixed) {
          lengths[i] = length(p, visited) + particles[i].rest.distanceTo(particles[p].rest);
        }
        done.add(i); return lengths[i];
      }
      particles.forEach((p, i) => length(i));
      const max = Math.max(...lengths, 1e-8);
      return lengths.map(n => n / max);
    }

    _addAngle(index, parent, grandparent, limit) {
      const s = this.simulation, particles = s._particles, child = particles[index], p = particles[parent];
      const rest = child.rest.clone().sub(p.rest);
      if (rest.lengthSq() < 1e-12) return;
      const constraint = new CANNON.Constraint(p.body, child.body);
      constraint.kind = 'angle';
      const equation = new CANNON.Equation(p.body, child.body, -1e5, 1e5);
      const settings = limit ? this.preset.angleLimitConstraint : this.preset.angleRestorationConstraint;
      const strength = limit ? settings.stiffness * ANGULAR_RESPONSE.limit :
        curve(settings.stiffness, this.depths[index]) * ANGULAR_RESPONSE.restoration;
      const relaxation = limit ? 3 : 3 + settings.velocityAttenuation * 6;
      const inverseMass = child.body.invMass + p.body.invMass;
      const elastic = stiffness(strength, inverseMass, this.step) * 13 / (1 + 4 * relaxation);
      equation.setSpookParams(elastic, relaxation, this.step);
      const edge = new THREE.Vector3(), expected = new THREE.Vector3(), axis = new THREE.Vector3();
      const normal = new THREE.Vector3(), rotation = new THREE.Quaternion();
      const base = particles[grandparent] && !p.fixed ? p.rest.clone().sub(particles[grandparent].rest) : null;
      const maxAngle = limit ? clamp(curve(settings.limitAngle, this.depths[index], 180), 0, 180) * Math.PI / 180 : 0;
      Object.assign(constraint, {index, parent, depth: this.depths[index], strength, maxAngle, limit});
      equation.computeB = h => {
        expected.copy(s._worldDirection(rest));
        if (base && base.lengthSq() > 1e-12) {
          const currentBase = new THREE.Vector3(p.body.position.x, p.body.position.y, p.body.position.z)
            .sub(new THREE.Vector3().copy(particles[grandparent].body.position));
          if (currentBase.lengthSq() > 1e-12) {
            rotation.setFromUnitVectors(s._worldDirection(base).normalize(), currentBase.normalize());
            expected.applyQuaternion(rotation);
          }
        }
        const length = expected.length(); expected.normalize();
        edge.copy(child.body.position).sub(new THREE.Vector3().copy(p.body.position)).normalize();
        const angle = Math.acos(clamp(edge.dot(expected), -1, 1));
        const error = Math.max(0, angle - maxAngle);
        if (limit && !error) {
          equation.jacobianElementA.spatial.setZero(); equation.jacobianElementB.spatial.setZero();
          return 0;
        }
        axis.crossVectors(edge, expected);
        if (axis.lengthSq() < 1e-12) {
          axis.crossVectors(edge, Math.abs(edge.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0));
        }
        normal.crossVectors(axis.normalize(), edge).normalize();
        equation.jacobianElementA.spatial.set(-normal.x, -normal.y, -normal.z);
        equation.jacobianElementB.spatial.set(normal.x, normal.y, normal.z);
        if (!error || strength <= 0) return -equation.computeGW() * equation.b;
        return error * length * equation.a - equation.computeGW() * equation.b - h * equation.computeGiMf();
      };
      constraint.equations.push(equation);
      constraint.update = () => { equation.enabled = strength > 0; };
      s.world.addConstraint(constraint); this.constraints.push(constraint);
    }

    _addTether(index, rootIndex) {
      const s = this.simulation, a = s._particles[rootIndex], b = s._particles[index];
      const rest = b.rest.clone().sub(a.rest);
      if (rest.lengthSq() < 1e-12) return;
      const compression = this.preset.tetherConstraint.distanceCompression;
      const constraint = new CANNON.Constraint(a.body, b.body);
      constraint.kind = 'tether';
      const equation = new CANNON.Equation(a.body, b.body, 0, 1e5);
      equation.setSpookParams(1e7, 3, this.step);
      const normal = new CANNON.Vec3();
      equation.computeB = h => {
        b.body.position.vsub(a.body.position, normal);
        const length = normal.length();
        const minimum = s._worldDirection(rest).length() * (1 - compression);
        normal.normalize();
        equation.jacobianElementA.spatial.copy(normal); equation.jacobianElementA.spatial.negate(equation.jacobianElementA.spatial);
        equation.jacobianElementB.spatial.copy(normal);
        return -(length - minimum) * equation.a - equation.computeGW() * equation.b - h * equation.computeGiMf();
      };
      constraint.equations.push(equation);
      constraint.update = () => { equation.enabled = compression < 1 && a.body.position.distanceTo(b.body.position) < s._worldDirection(rest).length() * (1 - compression); };
      s.world.addConstraint(constraint); this.constraints.push(constraint);
    }

    transport(delta) {
      const s = this.simulation, inertia = this.preset.inertiaConstraint;
      const moved = s._simulationMatrix.elements.some((v, i) => Math.abs(v - this._previousMatrix.elements[i]) > 1e-7);
      if (moved) this.wake();
      else this._idleTime += delta;
      if (this.sleeping) return;
      const transform = s._simulationMatrix.clone().multiply(this._previousMatrix.clone().invert());
      const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
      const previousPosition = new THREE.Vector3(), previousRotation = new THREE.Quaternion();
      s._simulationMatrix.decompose(position, rotation, scale);
      this._previousMatrix.decompose(previousPosition, previousRotation, scale);
      const move = position.distanceTo(previousPosition), angle = rotation.angleTo(previousRotation);
      let fraction = inertia.worldInertia;
      if (inertia.movementSpeedLimit.use && move > 1e-8) fraction *= Math.min(1, inertia.movementSpeedLimit.value * delta / move);
      if (inertia.rotationSpeedLimit.use && angle > 1e-8) fraction *= Math.min(1, inertia.rotationSpeedLimit.value * Math.PI / 180 * delta / angle);
      const smooth = inertia.movementInertiaSmoothing;
      const alpha = smooth > 0 ? 1 - Math.pow(Math.min(smooth, 0.9999), delta * 60) : 1;
      s._particles.forEach((particle, i) => {
        if (particle.fixed) return;
        const current = new THREE.Vector3().copy(particle.body.position);
        const motion = current.clone().applyMatrix4(transform).sub(current);
        this._filteredMotion[i].lerp(motion.clone().multiplyScalar(fraction), alpha);
        current.add(motion).sub(this._filteredMotion[i]);
        particle.body.position.set(current.x, current.y, current.z);
      });
      this._previousMatrix.copy(s._simulationMatrix);
    }

    limitVelocities() {
      const limit = this.preset.inertiaConstraint.particleSpeedLimit;
      if (!limit.use) return;
      for (const p of this.simulation._particles) {
        if (p.fixed) continue;
        const speed = p.body.velocity.norm();
        if (speed > limit.value) p.body.velocity.scale(limit.value / speed, p.body.velocity);
      }
    }

    dampRestMotion() {
      if (this._idleTime < .5) return;
      const decay = Math.exp(-1.2 * this.step);
      for (const p of this.simulation._particles) {
        if (!p.fixed) p.body.velocity.scale(decay, p.body.velocity);
      }
    }

    settle(delta) {
      const particles = this.simulation._particles;
      if (!this._averagePose) this._averagePose = particles.map(p => new THREE.Vector3().copy(p.body.position));
      const alpha = 1 - Math.exp(-delta / .25);
      particles.forEach((p, i) => {
        if (p.fixed) return;
        const position = new THREE.Vector3().copy(p.body.position);
        this._averagePose[i].lerp(position, alpha);
      });
      this._sampleTime += delta;
      if (this._sampleTime < .5) return;
      const center = poses => {
        const sum = new THREE.Vector3(); let count = 0;
        poses.forEach((p, i) => { if (!particles[i].fixed) { sum.add(p); count++; } });
        return sum.multiplyScalar(1 / Math.max(1, count));
      };
      const speed = this._samplePose ? center(this._averagePose).distanceTo(center(this._samplePose)) / this._sampleTime : Infinity;
      this.restSpeed = speed;
      this._samplePose = this._averagePose.map(p => p.clone());
      // Sleep the settled assembly, rather than letting high-frequency solver noise look like wind.
      const moving = particles.filter(p => !p.fixed);
      const threshold = Math.min(...moving.map(p => p.body.sleepSpeedLimit));
      this._stableTime = this._idleTime > 1 && speed < threshold ? this._stableTime + this._sampleTime : 0;
      this._sampleTime = 0;
      if (this._stableTime >= Math.max(...moving.map(p => p.body.sleepTimeLimit))) {
        particles.forEach(p => { if (!p.fixed) p.body.sleep(); });
        this.sleeping = true;
      }
    }

    wake() {
      this.sleeping = false; this._idleTime = 0; this._stableTime = 0; this._averagePose = null;
      this._samplePose = null; this._sampleTime = 0;
      this.simulation._particles.forEach(p => { if (!p.fixed) p.body.wakeUp(); });
    }

    reset() {
      this.wake();
      this._previousMatrix.copy(this.simulation._simulationMatrix);
      this._filteredMotion.forEach(v => v.set(0, 0, 0));
    }

    dispose() { this.constraints.forEach(c => this.simulation.world.removeConstraint(c)); }
  }
  global.MC2Preset = {validate, curve, Constraints: MC2Constraints};
})(typeof window === 'undefined' ? globalThis : window);

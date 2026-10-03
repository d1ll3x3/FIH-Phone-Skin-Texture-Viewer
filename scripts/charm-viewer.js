(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const vector = (a, n, label) => {
    if (!Array.isArray(a) || a.length !== n || !a.every(Number.isFinite)) {
      throw new Error('Invalid ' + label + '.');
    }
    return a;
  };
  function matrixArray(a, label) {
    vector(a, 16, label);
    if (Math.abs(new THREE.Matrix4().fromArray(a).determinant()) < 1e-12) throw new Error('Invalid ' + label + '.');
  }
  function validate(data) {
    if (!data || data.format !== 'fih-charm' || data.version !== 1) {
      throw new Error('Choose a converted FIH charm JSON or a Unity bundle.');
    }
    if (!Array.isArray(data.nodes) || !data.nodes.length || data.nodes.length > 4096 ||
        !Array.isArray(data.meshes) || !data.meshes.length || data.meshes.length > 256 ||
        !Array.isArray(data.materials) || data.materials.length > 256) {
      throw new Error('Invalid charm structure.');
    }
    const nodes = new Map();
    for (const n of data.nodes) {
      if (nodes.has(String(n.id))) throw new Error('Duplicate charm node.');
      nodes.set(String(n.id), n);
      vector(n.position, 3, 'node position');
      vector(n.rotation, 4, 'node rotation');
      vector(n.scale, 3, 'node scale');
      if (n.scale.some(v => Math.abs(v) < 1e-8)) throw new Error('Zero node scale.');
    }
    for (const n of data.nodes) {
      const seen = new Set([String(n.id)]);
      let p = n.parent;
      while (p != null) {
        if (seen.has(String(p)) || !nodes.has(String(p))) throw new Error('Invalid node hierarchy.');
        seen.add(String(p)); p = nodes.get(String(p)).parent;
      }
    }
    let vertices = 0;
    for (const m of data.meshes) {
      if (!nodes.has(String(m.node)) || !Array.isArray(m.positions) || !m.positions.length ||
          m.positions.length % 3 || !m.positions.every(Number.isFinite)) throw new Error('Invalid mesh positions.');
      const count = m.positions.length / 3; vertices += count;
      if (vertices > 500000) throw new Error('Charm is too large.');
      if (!Array.isArray(m.indices) || m.indices.length % 3 || m.indices.length > 3000000 ||
          !m.indices.every(i => Number.isInteger(i) && i >= 0 && i < count)) throw new Error('Invalid mesh triangles.');
      if (m.normals && m.normals.length) vector(m.normals, count * 3, 'mesh normals');
      if (m.uvs && m.uvs.length) vector(m.uvs, count * 2, 'mesh UVs');
      const materials = m.materials || [0];
      if (!materials.every(i => Number.isInteger(i) && data.materials[i])) throw new Error('Invalid mesh material.');
      if (m.groups && !m.groups.every(g => Number.isInteger(g.start) && Number.isInteger(g.count) &&
          g.start >= 0 && g.count >= 0 && g.start + g.count <= m.indices.length &&
          Number.isInteger(g.materialIndex) && g.materialIndex >= 0 && g.materialIndex < materials.length)) {
        throw new Error('Invalid mesh material groups.');
      }
      if (m.bones && m.bones.length) {
        if (!m.bones.every(id => nodes.has(String(id)))) throw new Error('Invalid mesh bones.');
        vector(m.skinIndices, count * 4, 'skin indices'); vector(m.skinWeights, count * 4, 'skin weights');
        if (!m.skinIndices.every(i => Number.isInteger(i) && i >= 0 && i < m.bones.length) ||
            !m.skinWeights.every(w => w >= 0)) throw new Error('Invalid skinning.');
        if (m.bindPoses && m.bindPoses.length) {
          if (m.bindPoses.length !== m.bones.length) throw new Error('Invalid bind pose count.');
          m.bindPoses.forEach(a => matrixArray(a, 'bind pose'));
        }
      }
    }
    for (const m of data.materials) {
      if (m.map && (typeof m.map !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(m.map))) {
        throw new Error('Charm textures must be embedded PNG, JPG or WebP images.');
      }
      if (m.color) vector(m.color, m.color.length === 4 ? 4 : 3, 'material color');
      if (m.mapRepeat) vector(m.mapRepeat, 2, 'texture repeat');
      if (m.mapOffset) vector(m.mapOffset, 2, 'texture offset');
    }
    const p = data.physics;
    if (p && p.type === 'mesh') {
      if (!nodes.has(String(p.node)) || !Array.isArray(p.positions) || !p.positions.length ||
          p.positions.length % 3 || p.positions.length > 1536 || !p.positions.every(Number.isFinite)) {
        throw new Error('Unsupported or invalid cloth proxy.');
      }
      const count = p.positions.length / 3;
      const proxyIndex = i => Number.isInteger(i) && i >= 0 && i < count;
      if (p.depths) {
        vector(p.depths, count, 'cloth depths');
        if (!p.depths.every(d => d >= 0 && d <= 1.00001)) throw new Error('Invalid cloth depths.');
      }
      for (const key of ['parentIndices', 'rootIndices']) {
        if (p[key] && (!Array.isArray(p[key]) || p[key].length !== count ||
            !p[key].every((n, i) => n === -1 || (proxyIndex(n) && n !== i)))) throw new Error('Invalid cloth hierarchy.');
      }
      if (p.parentIndices) for (let i = 0; i < count; i++) {
        const seen = new Set([i]); let parent = p.parentIndices[i];
        while (parent >= 0) {
          if (seen.has(parent)) throw new Error('Invalid cloth hierarchy.');
          seen.add(parent); parent = p.parentIndices[parent];
        }
      }
      if (p.parameters && p.parameters.mc2) MC2Preset.validate(p.parameters.mc2);
      if (p.triangles && (!Array.isArray(p.triangles) || p.triangles.length % 3 ||
          p.triangles.length > 12000 || !p.triangles.every(proxyIndex))) throw new Error('Invalid cloth triangles.');
      if (p.lines && (!Array.isArray(p.lines) || p.lines.length % 2 ||
          p.lines.length > 12000 || !p.lines.every(proxyIndex))) throw new Error('Invalid cloth lines.');
      if (p.bending && p.bending.pairs && (!Array.isArray(p.bending.pairs) || p.bending.pairs.length > 12000 ||
          !p.bending.pairs.every(pair => Array.isArray(pair) && pair.length === 4 && pair.every(proxyIndex)))) {
        throw new Error('Invalid cloth bending.');
      }
      if (!Array.isArray(p.fixed) || !p.fixed.length || !p.fixed.every(i => Number.isInteger(i) && i >= 0 && i < count) ||
          !Array.isArray(p.links) || p.links.length > 12000 || !p.links.every(l => l.length >= 3 &&
            Number.isInteger(l[0]) && Number.isInteger(l[1]) && l[0] >= 0 && l[0] < count && l[1] >= 0 && l[1] < count &&
            Number.isFinite(l[2]) && l[2] > 0)) throw new Error('Invalid cloth constraints.');
      if (!Array.isArray(p.renderMappings) || !p.renderMappings.length) throw new Error('Missing cloth mapping.');
      for (const map of p.renderMappings) {
        const m = data.meshes[map.mesh];
        if (!m) throw new Error('Invalid mapped mesh.');
        const n = m.positions.length / 3 * 4;
        if (map.fixed !== undefined && (!Array.isArray(map.fixed) || map.fixed.length > n / 4 ||
            !map.fixed.every(i => Number.isInteger(i) && i >= 0 && i < n / 4))) {
          throw new Error('Invalid fixed render vertices.');
        }
        vector(map.indices, n, 'cloth indices'); vector(map.weights, n, 'cloth weights');
        if (!map.indices.every(i => Number.isInteger(i) && i >= 0 && i < count) || !map.weights.every(w => w >= 0)) {
          throw new Error('Invalid cloth weights.');
        }
        for (let i = 0; i < n; i += 4) {
          if (map.weights.slice(i,i+4).reduce((sum,w)=>sum+w,0) < 1e-8) throw new Error('Missing cloth weights.');
        }
        if (map.toProxyMatrix) matrixArray(map.toProxyMatrix, 'proxy matrix');
      }
      if (p.attachment) vector(p.attachment, 3, 'attachment');
      if (p.proxyToNodeMatrix) matrixArray(p.proxyToNodeMatrix, 'proxy transform');
    }
    return data;
  }
  function disposeObject(root) {
    const textures = new Set(), materials = new Set();
    root.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      for (const m of o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []) {
        materials.add(m); if (m.map) textures.add(m.map);
      }
    });
    textures.forEach(t => t.dispose()); materials.forEach(m => m.dispose());
    root.removeFromParent();
  }
  async function build(data, renderer) {
    const root = new THREE.Group(), nodes = new Map(), meshes = [], materials = [];
    try {
      for (const m of data.materials) {
        const material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(...(m.color || [1, 1, 1]).slice(0, 3)),
          roughness: m.roughness == null ? .65 : m.roughness,
          metalness: m.metalness == null ? 0 : m.metalness,
          side: m.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
          opacity: m.color && m.color.length === 4 ? m.color[3] : 1,
          transparent: Boolean(m.color && m.color.length === 4 && m.color[3] < 1)
        });
        material.name = m.name || 'Charm'; materials.push(material);
        if (m.map) {
          material.map = await new THREE.TextureLoader().loadAsync(m.map);
          material.map.encoding = THREE.sRGBEncoding;
          material.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
          if (m.mapRepeat) material.map.repeat.fromArray(m.mapRepeat);
          if (m.mapOffset) material.map.offset.fromArray(m.mapOffset);
          material.map.wrapS = material.map.wrapT = THREE.RepeatWrapping;
        }
      }
      for (const n of data.nodes) {
        const node = new THREE.Bone();
        node.name = n.name || 'Charm'; node.position.fromArray(n.position);
        node.quaternion.fromArray(n.rotation).normalize(); node.scale.fromArray(n.scale);
        nodes.set(String(n.id), node);
      }
      for (const n of data.nodes) (n.parent == null ? root : nodes.get(String(n.parent))).add(nodes.get(String(n.id)));
      for (const m of data.meshes) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
        if (m.normals && m.normals.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3));
        else g.computeVertexNormals();
        if (m.uvs && m.uvs.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(m.uvs, 2));
        g.setIndex(m.indices);
        if (!m.normals || !m.normals.length) g.computeVertexNormals();
        const mats = (m.materials || [0]).map(i => materials[i]);
        (m.groups || [{start: 0, count: m.indices.length, materialIndex: 0}]).forEach(group => g.addGroup(group.start, group.count, group.materialIndex));
        const mesh = m.bones && m.bones.length ? new THREE.SkinnedMesh(g, mats) : new THREE.Mesh(g, mats);
        mesh.name = m.name || 'Charm mesh'; mesh.frustumCulled = false;
        nodes.get(String(m.node)).add(mesh); meshes.push(mesh);
        if (mesh.isSkinnedMesh) {
          g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(m.skinIndices, 4));
          g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(m.skinWeights, 4));
          root.updateMatrixWorld(true);
          const inverses = m.bindPoses && m.bindPoses.length ? m.bindPoses.map(a => new THREE.Matrix4().fromArray(a)) : undefined;
          const skeleton = new THREE.Skeleton(m.bones.map(id => nodes.get(String(id))), inverses);
          if (inverses) mesh.bind(skeleton, new THREE.Matrix4());
          else mesh.bind(skeleton);
          mesh.normalizeSkinWeights();
        }
      }
      return {root, nodes, meshes};
    } catch (error) {
      disposeObject(root);
      materials.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
      throw error;
    }
  }
  class CharmViewer {
    constructor({phone, phoneModel, phoneBox, renderer}) {
      this.phone = phone; this.phoneModel = phoneModel; this.phoneBox = phoneBox; this.renderer = renderer;
      this.collisionsEnabled = $('charmCollisions').checked;
      this.setPhoneHidden($('hidePhone').checked);
      $('hidePhone').disabled = false;
      this.height = phoneBox.getSize(new THREE.Vector3()).y;
      this.mount = new THREE.Group(); phone.add(this.mount);
      this.preset = window.FIH_HAT_PRESET ? MC2Preset.validate(window.FIH_HAT_PRESET) : null;
      this.generation = 0; this.importCount = 0;
      this.currentKey = 'none'; this.assembly = null; this.simulation = null; this.data = null;
      this.buttons(false);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.simulation) this.simulation.reset();
      });
    }
    status(message, error = false) { $('charmStatus').textContent = message; $('charmStatus').classList.toggle('error', error); }
    buttons(active) {
      for (const id of ['removeCharm','charmCollisions']) $(id).disabled = !active;
    }
    setPhoneHidden(hidden) {
      this.phoneHidden = Boolean(hidden);
      this.phoneModel.visible = !this.phoneHidden;
    }
    setCollisions(enabled) {
      this.collisionsEnabled = Boolean(enabled);
      if (this.simulation) this.simulation.collisionsEnabled = this.collisionsEnabled;
    }
    clear() {
      this.generation++;
      if (this.simulation) this.simulation.dispose(); this.simulation = null;
      if (this.assembly) disposeObject(this.assembly.root);
      this.assembly = this.data = null; this.currentKey = 'none'; this.buttons(false);
      this.status('No charm');
    }
    async loadSample() {
      try {
        if (!window.FIH_HAT_CHARM) throw new Error('Sample charm could not be loaded.');
        await this.load(window.FIH_HAT_CHARM, 'hat');
      } catch (e) { this.status(e.message, true); }
    }
    async load(data, key) {
      validate(data);
      const generation = ++this.generation;
      this.status('Loading charm...');
      const assembly = await build(data, this.renderer);
      if (generation !== this.generation) { disposeObject(assembly.root); return; }
      const previous = {assembly:this.assembly,simulation:this.simulation,data:this.data,currentKey:this.currentKey,
        attachment:this.attachment};
      this.assembly = assembly; this.simulation = null; this.data = data;
      try {
        this.mount.add(assembly.root);
        assembly.root.rotation.x = -Math.PI / 2;
        assembly.root.updateWorldMatrix(true,true);
        const attachment = new THREE.Vector3().fromArray(data.physics && data.physics.attachment || [0,0,0]);
        if (data.physics && data.physics.proxyToNodeMatrix) attachment.applyMatrix4(new THREE.Matrix4().fromArray(data.physics.proxyToNodeMatrix));
        if (data.physics && data.physics.node != null) assembly.nodes.get(String(data.physics.node)).localToWorld(attachment);
        else assembly.root.localToWorld(attachment);
        this.attachment = assembly.root.worldToLocal(attachment);
        this.place();
      } catch (error) {
        if (this.simulation) this.simulation.dispose();
        disposeObject(assembly.root); Object.assign(this,previous); throw error;
      }
      if (previous.simulation) previous.simulation.dispose();
      if (previous.assembly) disposeObject(previous.assembly.root);
      this.currentKey = key; this.buttons(true);
      this.status(key === 'hat' ? 'Hat' : data.name || 'Charm');
    }
    place() {
      if (!this.assembly) return;
      if (this.simulation) this.simulation.dispose();
      const box = this.phoneBox, h = this.height;
      // Raise the attachment above the case without changing its lateral/depth offsets.
      this.mount.position.set(box.max.x + (.035 - .25) * h,
        box.max.y + .02 * h, box.max.z + (.035 - .15) * h);
      const root = this.assembly.root;
      root.scale.setScalar(1); root.quaternion.setFromAxisAngle(new THREE.Vector3(1,0,0), -Math.PI/2);
      root.position.copy(this.attachment).negate().applyQuaternion(root.quaternion);
      this.phone.updateMatrixWorld(true);
      this.simulation = new CharmPhysics({root, nodes:this.assembly.nodes, meshes:this.assembly.meshes,
        phoneBounds: {object:this.phone,box:this.phoneBox},
        physics:this.data.physics || {}, preset: this.data.physics && this.data.physics.type === 'mesh' ?
          (this.data.physics.parameters && this.data.physics.parameters.mc2 || this.preset) : null});
      this.settings();
    }
    settings() {
      if (!this.simulation) return;
      this.simulation.damping = .65;
      this.simulation.gravityScale = 1;
      this.simulation.collisionsEnabled = this.collisionsEnabled;
    }
    async import(file) {
      let generation = ++this.generation;
      this.status('Importing ' + file.name + '...');
      try {
        if (file.size > 64 * 1024 * 1024) throw new Error('Charm exceeds the 64 MB limit.');
        const bytes = await file.arrayBuffer();
        const header = new TextDecoder().decode(bytes.slice(0, 32)).trimStart();
        let data;
        if (header.startsWith('{')) data = JSON.parse(new TextDecoder().decode(bytes));
        else {
          if (location.protocol === 'file:' || !['localhost','127.0.0.1','[::1]'].includes(location.hostname)) {
            throw new Error('Unity bundles require the local viewer server. Import converted JSON on this site.');
          }
          let response;
          try { response = await fetch('/api/convert-charm', {method:'POST',headers:{'Content-Type':'application/octet-stream','X-Filename':encodeURIComponent(file.name)},body:bytes}); }
          catch (_) { throw new Error('Start the local viewer server to import Unity bundles.'); }
          if (response.status === 404 || response.status === 501) throw new Error('Start the local viewer server to import Unity bundles.');
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Bundle conversion failed.');
          data = result;
        }
        if (generation !== this.generation) return;
        if (data && data.format !== 'fih-charm' && data.clothType === 0) {
          const preset = MC2Preset.validate(data);
          if (!this.simulation) throw new Error('Load a charm before its MC2 preset.');
          this.simulation.setPreset(preset); this.preset = preset;
          this.status((this.data.name || 'Charm') + ' (MC2: ' + file.name + ')');
          return;
        }
        validate(data);
        const loading = this.load(data, 'import-' + (++this.importCount));
        generation = this.generation;
        await loading;
      } catch (error) {
        if (generation === this.generation) {
          this.status(error instanceof SyntaxError ? 'Invalid charm JSON.' : error.message, true);
        }
      }
    }
    update(delta) {
      if (document.hidden) return;
      this.phone.updateMatrixWorld(true);
      if (this.simulation) this.simulation.update(delta);
    }
  }
  window.CharmViewer = CharmViewer;
  window.validateCharm = validate;
})();

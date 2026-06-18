/**
 * Photograph.js — in-scene media (image / document) presenter.
 *
 * A tourpoint may attach files (`tourpoint.files`); when present the engine
 * flies a framed photograph/media plane into view. The default demo ships no
 * attached files, so this is only constructed on demand. It exposes the small
 * interface the engine calls: update() each frame and slideOut() on navigate.
 */
import * as THREE from 'three';

import Store from '../Store';
import { makeImageSrc } from '../lib/util';

export default class Photograph {
  constructor(file) {
    this.file = file || null;
    this.mesh = null;
    this._t = 0;
    this._visible = false;

    const { scene } = Store.getState();
    this.scene = scene;

    if (this.file) {
      this._build();
    }
  }

  _build() {
    let url = '';
    try {
      url = makeImageSrc({ files: [this.file] }) || this.file.url || '';
    } catch (e) {
      url = this.file.url || '';
    }

    const geometry = new THREE.PlaneGeometry(1.6, 1.0);
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    });

    if (url) {
      new THREE.TextureLoader().load(url, (texture) => {
        material.map = texture;
        material.needsUpdate = true;
      });
    }

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.renderOrder = 999;
    this.scene && this.scene.add(this.mesh);
    this.slideIn();
  }

  slideIn() {
    this._visible = true;
  }

  slideOut() {
    this._visible = false;
    // fade then remove
    setTimeout(() => this.destroy(), 600);
  }

  update() {
    if (!this.mesh) return;
    // simple fade toward target opacity
    const target = this._visible ? 1 : 0;
    const mat = this.mesh.material;
    mat.opacity += (target - mat.opacity) * 0.08;

    // keep the photograph facing the camera
    const { camera } = Store.getState();
    if (camera) this.mesh.quaternion.copy(camera.quaternion);
  }

  destroy() {
    if (!this.mesh) return;
    this.scene && this.scene.remove(this.mesh);
    this.mesh.geometry && this.mesh.geometry.dispose();
    if (this.mesh.material) {
      this.mesh.material.map && this.mesh.material.map.dispose();
      this.mesh.material.dispose();
    }
    this.mesh = null;
  }
}

import * as THREE from 'three';


import Store from '../Store';



export default class Cursor {
  constructor() {
    const { scene, cursorOpacity, } = Store.getState();

    this.innerRadius = 0.15;
    this.outerRadius = 0.19;
    this.thetaSegments = 64;

    // Create mesh with initial geometry and material
    const geometry = new THREE.RingGeometry(this.innerRadius, this.outerRadius, this.thetaSegments);

    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      opacity: cursorOpacity
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.renderOrder = 10;
    

    // Add mesh to scene
    scene.add(this.mesh);

    // initial update
    this.updateParameters();
    this.raycaster = new THREE.Raycaster();
  } 

  // This method will be called in the animation loop to position the cursor
  update() {
    const { cursor } = Store.getState();
    this.mesh.position.copy(cursor.position);
    this.mesh.rotation.setFromQuaternion(cursor.rotation);
    this.updateParameters();

  }

  updateParameters() {
    const { cursor, cursorOpacity } = Store.getState();

    if (
        cursor.position.x === 0 &&
        cursor.position.y === 0 &&
        cursor.position.z === 0
    ) {
      this.mesh.visible = false;
    } else {
      this.mesh.visible = true;
    }

    this.mesh.material.opacity = cursorOpacity;
  }
}

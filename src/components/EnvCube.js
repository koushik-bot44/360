import * as THREE from 'three';

import AnnotationGraph from './AnnotationGraph';

import { useCachedTexture, } from '../lib/util';
import Store from '../Store';


class EnvCube {
  constructor(node, options={ isOutgoing: false }) {
    const { scene, camera, cubeScene, isMobile } = Store.getState();

    this.node = node;
    this.options = options;
    this.raycaster = new THREE.Raycaster();
    this.group = new THREE.Group();
    this.materials = [];
    this.meshes = [];
    this.fullResolutionFaces = new Set(); 

    // build the face planes
    this.createFaces();

    // position /rotate the cube
    this.group.position.copy(camera.position);

    this.setRotation(node);

    scene.add(this.group);

    if (!isMobile) {
      if (options.isOutgoing) {
        this.cubeClone = this.group.clone();
        this.cubeClone.children.forEach((child, index) => {
          child.material = child.material.clone();
        });
        cubeScene.add(this.cubeClone);
      }
    }
  }

  getRotation(faceI) {
    switch (faceI) {
      case 2: return [0, Math.PI / 2, 0];
      case 4: return [0, -Math.PI / 2, 0];
      case 0: return [Math.PI / 2, 0, Math.PI];
      case 5: return [-Math.PI / 2, 0, Math.PI];
      case 1: return [0, Math.PI, 0];
      case 3: return [0, 0, 0];
      default: return [0, 0, 0];
    }
  }

  setRotation(node) {
    const { space } = Store.getState();
    const nodeGroupSettings = space.space_data.sceneSettings.nodes;

    // Node rotation directly from quaternion
    const nodeQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      node.rotation.x,
      -node.rotation.y,
      node.rotation.z,
    ));

    // Node group rotation as quaternion
    const nodeGroupQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(0),
      THREE.MathUtils.degToRad(0),
      THREE.MathUtils.degToRad(180),
      'XYZ'
    ));

    // Combine the quaternions (order matters)
    nodeQuaternion.multiply(nodeGroupQuaternion);

    // Apply the combined rotation to the group
    this.group.quaternion.copy(nodeQuaternion);


    if (this.cubeClone) {
      this.cubeClone.quaternion.copy(nodeQuaternion);
    }
  }

  getPosition(faceI) {
    // faceI = 2 -> Left
    // faceI = 4 -> Right
    // faceI = 0 -> Top
    // faceI = 5 -> Bottom
    // faceI = 1 -> Front
    // faceI = 3 -> Back
    switch (faceI) {
      case 2: return [-100, 0, 0];
      case 4: return [100, 0, 0];
      case 0: return [0, 100, 0];
      case 5: return [0, -100, 0];
      case 1: return [0, 0, 100];
      case 3: return [0, 0, -100];
      default: return [0, 0, 0];
    }
  }

  createFaces() {
    const { space, isMobile, materialCache } = Store.getState();
    const size = 200;

    Array.from({ length: 6 }).forEach((_, faceI) => {

      let texture = null;
      let opacity = this.options.isOutgoing ? 0 : 1;
      if (this.node.uuid.startsWith("map")) {
        opacity = 0; 
      }

      // get 1024 tex
      let resolution = "1024";

      texture = useCachedTexture(this.node.uuid, faceI, resolution, space.version);

      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity, 
        depthWrite: false,
        depthTest: false,
      });

      this.materials.push(material);
    });

    // Create the faces with the materials
    this.materials.forEach((material, faceI) => {
      this.createFace(size, this.getRotation(faceI), this.getPosition(faceI), faceI);
      materialCache[this.node.uuid] = materialCache[this.node.uuid] || {};
      materialCache[this.node.uuid][faceI] = materialCache[this.node.uuid][faceI] || {};
      materialCache[this.node.uuid][faceI]["1024"] = material;
    });

    Store.setState({
      materialCache: { 
        [this.node.uuid]: materialCache[this.node.uuid], 
        ...Store.getState().materialCache,
      },
    });
  }

  createFace(size, rotation, position, materialIndex) {
    const geometry = new THREE.PlaneGeometry(size, size);
    const mesh = new THREE.Mesh(geometry, this.materials[materialIndex]);
    mesh.rotation.set(...rotation);
    mesh.position.set(...position);
    this.meshes.push(mesh);
    this.group.add(mesh);
  }

  createShaderMaterial({ map, opacity, faceI }) {

    const vertexShader = `
        uniform vec3 movementDirection;
        uniform float movementIntensity;
        varying vec2 vUv;
        varying vec3 vColor;

        void main() {
            vUv = uv;
            vec3 pos = position.xyz;

            // Modify the UV coordinates to create the stretching effect
            vUv += movementDirection.xy * movementIntensity * 0.5; 

            // Visualize the warping effect by coloring the vertices based on the warp factor
            // vColor = vec3(movementIntensity, 0.5, 0.5);

            gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        }
    `;

    const fragmentShader = `
        uniform sampler2D map;
        varying vec2 vUv;
        varying vec3 vColor;
        uniform float opacity;

        void main() {
          // Sample the texture
          vec4 textureColor = texture2D(map, vUv); 
          // gl_FragColor = vec4(textureColor.rgb * vColor, textureColor.a * opacity);
          gl_FragColor = vec4(textureColor.rgb, textureColor.a * opacity);

        }
    `;

    const uniforms = {
        movementDirection: { value: new THREE.Vector3() },
        movementIntensity: { value: 0.0 },
        opacity: { value: opacity },
        faceI: { value: faceI },
        map: { value: map },
    };

    return new THREE.ShaderMaterial({
        uniforms,
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        depthTest: false,
    });
  }

  show() {
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }

  getTextures() {
    return this.materials.map(material => material.map);
  }

  updateFaces() {
    const { space, camera, isMobile } = Store.getState();
    if (this.node.uuid.startsWith("map")) return;

    for (let i = 0; i<this.materials.length; i++) {
      let resolution = "1024";

      const texture = useCachedTexture(this.node.uuid, i, resolution, space.version);
      // this.materials[i].uniforms.map = texture; 
      this.materials[i].map = texture; 
      this.materials[i].needsUpdate = true;

      // Update the cubeClone's materials if it exists
      if (this.cubeClone) {
        this.cubeClone.children[i].material.map = texture;
        this.cubeClone.children[i].material.needsUpdate = true;
      }
    }

    this.fullResolutionFaces = new Set();

    // Update the group's position to match the camera's position
    this.group.position.copy(camera.position);

    // rotate the cube
    this.setRotation(this.node);

    // Update the cubeClone's position and rotation if it exists
    if (this.cubeClone) {
      this.cubeClone.position.copy(camera.position);
      this.cubeClone.quaternion.copy(this.group.quaternion);
    }
  }

  getVisibleFaces() {
    const { camera } = Store.getState();
    const visibleFaces = [];

    this.group.children.forEach((child, i) => {
      if (this.fullResolutionFaces.has(i)) return;

      this.raycaster.setFromCamera(camera.position, camera);
      const intersects = this.raycaster.intersectObject(child);

      if (intersects.length > 0) {
        visibleFaces.push(i);
      }
    });

    return visibleFaces;
  }


  updateFacesFullRes(visibleFaces) {
    const { space, isNavigating } = Store.getState();

    // reinforce don't update faces during navigation
    if (isNavigating) { return; }

    visibleFaces.forEach(i => {
      // Skip if already at full resolution
      if (this.fullResolutionFaces.has(i)) return;

      // don't try to load face images for map points
      if (this.node.uuid.startsWith("map")) return;

      // Load the full-resolution 4k texture
      const texture = useCachedTexture(this.node.uuid, i, "4096", space.version, this._updateFullResFaceCallback.bind(this));
    });
  }

  _updateFullResFaceCallback(uuid, i, texture) {
    const { isNavigating } = Store.getState();

    // reinforce don't update faces during navigation
    if (isNavigating) { return; }

    if (uuid !== this.node.uuid) {
      // This texture is no longer relevant, so do not update the material
      return;
    }

    this.materials[i].map = texture;
    this.materials[i].needsUpdate = true;
    this.fullResolutionFaces.add(i); // Mark this face as loaded at full resolution
  }

  updateVisibleFaces() {
    const { isMobile, isNavigating } = Store.getState();

    if (!isMobile && !isNavigating) {
      const visibleFaces = this.getVisibleFaces();
      this.updateFacesFullRes(visibleFaces);  
    }
  }
}

export default class EnvCubeManager {
  constructor() {
    const { currentNode, outgoingNode, tourGuidedMode }  = Store.getState();

    this.envCube = new EnvCube(currentNode);
    this.envCubeOutgoing = new EnvCube(outgoingNode, { isOutgoing: true });

    if (tourGuidedMode) {
      this.annotationGraph = new AnnotationGraph(); 
    }

    // set the cube render order based on app state
    this.setCubeRenderOrder();
  }

  setMoveIntensity(newIntensity) {    
    this.envCubeOutgoing.materials.forEach(material => {
      material.uniforms.movementIntensity.value = newIntensity;
    });
  }

  setMoveDirection(cameraLerpTarget) {
    const { cameraPosition } = Store.getState();

    // Calculate the movement direction in world space
    const movementDirectionWorld = cameraLerpTarget.clone().sub(cameraPosition).normalize();

    this.envCubeOutgoing.materials.forEach(material => {

      // Get the face normal direction in world space
      const faceNormal = new THREE.Vector3();
      switch (faceI) {
        case 2: // Left
          faceNormal.set(-1, 0, 0);
          break;
        case 4: // Right
          faceNormal.set(1, 0, 0);
          break;
        case 0: // Top
          faceNormal.set(0, 1, 0);
          break;
        case 5: // Bottom
          faceNormal.set(0, -1, 0);
          break;
        case 1: // Front
          faceNormal.set(0, 0, 1);
          break;
        case 3: // Back
          faceNormal.set(0, 0, -1);
          break;
      }

      // Transform the face normal from local space to world space
      const faceNormalMatrix = new THREE.Matrix3().getNormalMatrix(this.envCubeOutgoing.group.matrixWorld);
      faceNormal.applyMatrix3(faceNormalMatrix).normalize();

      // Calculate the dot product between the movement direction and the face normal
      const dotProduct = movementDirectionWorld.dot(faceNormal);

      // Calculate the projection of the movement direction onto the face plane
      const projectedMovement = movementDirectionWorld.clone().sub(faceNormal.clone().multiplyScalar(dotProduct));

      // Calculate the stretching direction based on the projected movement
      const stretchDirection = new THREE.Vector3();
      if (Math.abs(projectedMovement.x) > Math.abs(projectedMovement.y)) {
        stretchDirection.set(Math.sign(projectedMovement.x), 0, 0);
      } else {
        stretchDirection.set(0, Math.sign(projectedMovement.y), 0);
      }

    });
  }

  crossfade() {
    const { 
      app, currentNode, outgoingNode, movementDirection, movementIntensity, debugMode,
      isMobile, 
    } = Store.getState();

    // ensure render order set 
    this.setCubeRenderOrder();

    // set navigating semaphore
    Store.setState({ isNavigating: true });

    // update faces on outgoing cube 
    this.envCubeOutgoing.node = outgoingNode; 
    this.envCubeOutgoing.updateFaces();


    // make outgoing cube's cubeClone faces visible
    this.envCubeOutgoing.materials.forEach((material) => (material.opacity = 1));
    if (!isMobile) {
      this.envCubeOutgoing.cubeClone.children.forEach((child) => (child.material.opacity = 1));
    }

    // update faces on main cube
    this.envCube.node = currentNode;
    this.envCube.updateFaces();

    if (!isMobile) {
      // show the dollhouse for nav movement fx  
      app.dollhouse.showForNavigation();
    }

    // fade out outgoing cube
    let progress = 0;
    let duration = 900;

    if (debugMode) {
      console.log("EnvCube: start crossfade");
    }

    const interval = setInterval(() => { 
      progress += 20;
      const factor = progress / duration;


      this.envCubeOutgoing.materials.forEach((material) => (material.opacity = 1 - factor));

      if (!isMobile) {
        this.envCubeOutgoing.cubeClone.children.forEach((child) => (child.material.opacity = 1 - factor));
      }

      if (progress >= duration) {
        Store.setState({ isNavigating: false });

        if (debugMode) {
          console.log("EnvCube: end crossfade");
        }

        clearInterval(interval);
      }

    }, 20);
  }

  fadeOut(callback=null) {
    const store = Store.getState();

    // fade out outgoing cube
    let progress = 0;
    let duration = 200;
    const interval = setInterval(() => {
      progress += 20;
      const factor = progress / duration;

      this.envCube.materials.forEach((material) => (material.opacity = 1 - factor));

      if (progress >= duration) {
        clearInterval(interval);
        this.envCube.materials.forEach((material) => (material.visible = false));
        if (callback) {
          callback();
        }
      }
    }, 20);
  }

  remove() {
    const store = Store.getState();
    store.scene.remove(this.envCube.group);
    store.scene.remove(this.envCubeOutgoing.group);
  }

  create(currentNode, outgoingNode) {
    const { tourGuidedMode }  = Store.getState();

    this.envCube = new EnvCube(currentNode);
    this.envCubeOutgoing = new EnvCube(outgoingNode, { isOutgoing: true });

    if (tourGuidedMode) {
      this.annotationGraph = new AnnotationGraph(); 
    }

    // set the cube render order based on app state
    this.setCubeRenderOrder();
  }

  dimScene(opacity) {
    this.envCube.materials.forEach((material) => (material.opacity = opacity));
  }

  fadeIn(callback=null) {
    const store = Store.getState();
    this.envCube.materials.forEach((material) => (material.opacity = 0));
    this.envCube.materials.forEach((material) => (material.visible = true));
    
    // fade out outgoing cube
    let progress = 0;
    let duration = 200;
    const interval = setInterval(() => {
      progress += 20;
      const factor = progress / duration;

      this.envCube.materials.forEach((material) => (material.opacity = factor));

      if (progress >= duration) {
        clearInterval(interval);
        if (callback) {
          callback();
        }
      }
    }, 20);
  }

  handleToggleDebugMode() {
    this.setCubeRenderOrder();
  }

  handleToggleViewMode() {
    const { debugMode, viewMode } = Store.getState();
    this.setCubeRenderOrder();

    if (viewMode === "FPV") {
      this.fadeIn();
    } else {
      this.fadeOut();
    }
  }

  setCubeRenderOrder() {
    const { debugMode, viewMode } = Store.getState();
    
    // Calculate the EnvCube's render order based on the current viewMode and debugMode
    const cubeRenderOrder = (viewMode === "FPV" && !debugMode) ? 1 : 0;

    // Apply the render order to each mesh in the EnvCube
    this.envCube.group.children.forEach(child => {
      child.renderOrder = cubeRenderOrder;
    });
    if (this.envCube.cubeClone) {
      this.envCube.cubeClone.children.forEach(child => {
        child.renderOrder = cubeRenderOrder;
      });
    }

    // Apply the render order to each mesh in the envCubeOutgoing
    this.envCubeOutgoing.group.children.forEach(child => {
      child.renderOrder = cubeRenderOrder + 1;
    });
    if (this.envCubeOutgoing.cubeClone) {
      this.envCubeOutgoing.cubeClone.children.forEach(child => {
        child.renderOrder = cubeRenderOrder + 1;
      });
    }
  }

  toggleMaterialType(makeUnlit=true) {
    // Iterate through the materials of the envCube
    this.envCube.materials.forEach((material, index) => {
      // Create a new material instance based on the opposite type
      let newMaterial;
      if (makeUnlit) {
        newMaterial = new THREE.MeshBasicMaterial({
          map: material.map,
          transparent: material.transparent,
          opacity: material.opacity
        });
      } else {
        newMaterial = new THREE.MeshPhongMaterial({
          map: material.map,
          transparent: material.transparent,
          opacity: material.opacity
        });
      }
      // Replace the old material with the new one
      this.envCube.materials[index] = newMaterial;
      // Update the mesh to use the new material
      this.envCube.group.children[index].material = newMaterial;
    });

    // Do the same for envCubeOutgoing
    this.envCubeOutgoing.materials.forEach((material, index) => {
      let newMaterial;
      if (makeUnlit) {
        newMaterial = new THREE.MeshBasicMaterial({
          map: material.map,
          transparent: material.transparent,
          opacity: material.opacity
        });
      } else {
        newMaterial = new THREE.MeshPhongMaterial({
          map: material.map,
          transparent: material.transparent,
          opacity: material.opacity
        });
      }
      this.envCubeOutgoing.materials[index] = newMaterial;
      this.envCubeOutgoing.group.children[index].material = newMaterial;
    });
  }

  setPosition(position) {
    this.envCube.group.position.copy(position);
    this.envCubeOutgoing.group.position.copy(position);
  }

  setDepthPropertiesForMaterials(enableDepth) {
    // Assuming enableDepth is a boolean (true or false)

    // Update envCube materials
    this.envCube.materials.forEach((material) => {
        material.depthWrite = enableDepth;
        material.depthTest = enableDepth;
        material.needsUpdate = true; // Important to apply changes
    });

    // Update envCubeOutgoing materials
    this.envCubeOutgoing.materials.forEach((material) => {
        material.depthWrite = enableDepth;
        material.depthTest = enableDepth;
        material.needsUpdate = true; // Important to apply changes
    });
  }


  update() {
    const { isNavigating, cubeCamera, camera, app, renderer, cubeScene } = Store.getState();

    // figure out a better way to update to 4k faces 
    if (!isNavigating) {
      this.envCube.updateVisibleFaces();
    }

    if (isNavigating && cubeCamera) {
      cubeCamera.position.copy(camera.position);
      cubeCamera.update(renderer, cubeScene);
    }
  }
}


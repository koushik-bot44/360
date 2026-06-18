import * as THREE from 'three';

// global state
import Store from '../Store';

// components
import Rig from './Rig';
import EnvCube from './EnvCube';
import Nodes from './Nodes';
import Dollhouse from './Dollhouse';
import Cursor from './Cursor';
import DebugInfo from './DebugInfo';
import Postprocessing from './Postprocessing'
import TransitionManager from './TransitionManager';

// optional components for tour / game mode
import TourUI from './tour/TourUI';
import SceneGraph from './SceneGraph';
import AudioManager from './AudioManager';
import setupSpaceCustom from './spaceCustom';

// event handlers
import PointerHandlers from '../PointerHandlers';
import CameraHandlers from '../CameraHandlers';

// lib
import { useCachedTexture, calculateDistance, getInitialOrbitTarget } from '../lib/util';


function hasPass(composer, passType) {
  for (let i = 0; i < composer.passes.length; i++) {
    if (composer.passes[i] instanceof passType) {
      return true;
    }
  }
  return false;
}


export default class App {
  constructor() {
    const { space, tour, tourGuidedMode, tourGuidedAutoplay } = Store.getState();
    this.transitionManager = new TransitionManager();
    this.threejsEnvInited = false;

    this.transitionManager.initializeSpace(space);

    if (space.type !== "matterport") {
      // Initialize other components like rig, envCube, nodes, etc. if needed
      this.initSpaceComponents();
    }

    if (tourGuidedMode) {
      // audio manager must be before tour ui
      this.audioManager = new AudioManager();

      this.tourUI = new TourUI(this);

      if (tourGuidedAutoplay) {
        this.startAutoplay();
      }

    }
  }

  initSpaceComponents() {
    const { scene, isMobile, tourGuidedMode } = Store.getState();

    // Camera
    this.rig = new Rig();

    // Create ambient light
    const ambientLight = new THREE.AmbientLight(0xeee6d7, 4.0);
    scene.add(ambientLight);

    this.ambientLight = ambientLight;
    this.targetIntensity = 4.0;
    this.currentIntensity = 4.0;
    this.lerpAlpha = 0;

    // The Cube with the Environment texture 
    this.envCube = new EnvCube();

    // Scene objects
    this.dollhouse = new Dollhouse();

    // The Cube with the Environment texture 
    this.nodes = new Nodes();

    // The cursor 
    this.cursor = new Cursor();

    // Handle Camera and Pointer
    this.cameraHandlers = new CameraHandlers();
    this.pointerHandlers = new PointerHandlers();

    // guided tour and creative mode stuff
    if (tourGuidedMode) {

      this.sceneGraph = new SceneGraph();
      this.spaceCustom = setupSpaceCustom();
      // this.earthTiles = new EarthTiles();

      this.setInitialTourCameraRotation();
    }

    // debugging
    this.debugInfo = new DebugInfo();

    // post
    // must be after lights are added
    this.post = new Postprocessing();

    // editing space and tour if relevant
    // this does not add overhead for public users
    this.setupEditing();

    this.threejsEnvInited = true;
  } 
  
  startAutoplay() {
    Store.setState({ tourGuidedAutoplay: true });

    this.autoplayInterval = setInterval(() => {
      const { tour, tourSpaceActiveIdx, tourPointActiveIdx, tourGuidedAutoplay } = Store.getState();
      if (tourGuidedAutoplay) {
        if (tour.tour_data.spaces.length &&
            tour.tour_data.spaces[tourSpaceActiveIdx].tourpoints.length &&
            !(tourSpaceActiveIdx === tour.tour_data.spaces.length - 1 &&
              tourPointActiveIdx === tour.tour_data.spaces[tourSpaceActiveIdx].tourpoints.length - 1)) {
          this.tourUI.tourNavButtons.handleClickNext();
        }
      }
    }, 9000);
  }

  stopAutoplay() {
    Store.setState({ tourGuidedAutoplay: false });
    if (this.autoplayInterval) {
      clearInterval(this.autoplayInterval);
      this.autoplayInterval = null;
    }
  }

  handleToggleAutoplay() {
    const { tourGuidedAutoplay } = Store.getState();

    if (tourGuidedAutoplay) {
      this.stopAutoplay();
    } else {
      this.startAutoplay();
    }
  }


  preload() {
    // Preload initial texture and then initialize rest of the App
    // store
    const { currentNode } = Store.getState();

    this.loadNode(currentNode);
  }

  preloadNearestNodes(targetNode) {
    const { space, debugMode, isMobile } = Store.getState();
    const nodes = space.space_data.nodes;  

    if (debugMode) {
      console.log("Preloading nearest nodes for targetNode", targetNode)
    }

    // Exclude the current node and nodes starting with "map"
    const otherNodes = nodes.filter(node => node.uuid !== targetNode.uuid && !node.uuid.startsWith("map"));

    // Calculate distances and sort nodes by distance to the current node
    const sortedNodes = otherNodes
      .map(node => {
        const distance = calculateDistance(targetNode.position, node.position);
        if (debugMode) {
          console.log(`Distance from targetNode to node ${node.uuid}: ${distance}`);
        }
        return { node, distance };
      })
      .sort((a, b) => a.distance - b.distance)
      .map(item => item.node);


    // Preload the nearest 8 nodes
    let numberOfNodesToPreload = 14;
    if (isMobile) {
      numberOfNodesToPreload = 8;
    }
    const nearestNodes = sortedNodes.slice(0, numberOfNodesToPreload);
    nearestNodes.forEach(node => {
      this.loadNode(node);
    });
  }

  loadNode(node, callback=() => {}) {
    const { materialCache, loadingManager, space } = Store.getState();

    materialCache[node.uuid] = {};

    let loadedTexturesCount = 0;
    const totalTexturesToLoad = 6; // Assuming 6 faces

    // hack for bug with load node not working sometimes
    const timeoutBackup = setTimeout(() => {
      callback();
    }, 10000);

    // Function to check if all textures are loaded
    const checkAllTexturesLoaded = () => {
      if (loadedTexturesCount === totalTexturesToLoad) {
        timeoutBackup && clearTimeout(timeoutBackup);
        callback();
      }
    };

    Array.from({ length: 6 }).forEach((_, faceI) => {
      materialCache[node.uuid][faceI] = {};

      // load the 1024 version
      const texture = useCachedTexture(node.uuid, faceI, "1024", space.version, () => {
        loadedTexturesCount++;
        checkAllTexturesLoaded();
      });

      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
      });

      materialCache[node.uuid][faceI]["1024"] = material;
    });

    Store.setState({materialCache: { [node.uuid]: materialCache[node.uuid], ...materialCache} });

    // If there are no textures to load, call the callback immediately
    if (totalTexturesToLoad === 0) {
      timeoutBackup && clearTimeout(timeoutBackup);
      callback();
    }

  }

  areAllFacesLoaded(node) {
    const { materialCache } = Store.getState();
    if (!node || !materialCache[node.uuid]) return false;

    for (let i = 0; i < 6; i++) { // Assuming there are 6 faces
      if (!materialCache[node.uuid][i] || !materialCache[node.uuid][i]["1024"]) {
        return false;
      }
    }
    return true;
  }

  ensureFacesLoadedThenNavigate(node, callback) {
    if (this.areAllFacesLoaded(node)) {

      this.cameraHandlers.handleNavigation(node, {
        viewMode: "FPV",
      });

    } else {
      const nodeLoadingScreen = document.getElementById("node-loading-screen");
      nodeLoadingScreen.classList.remove("hidden"); 

      this.loadNode(node, () => {
        // callback after loading:
        // hide loading screen
        nodeLoadingScreen.classList.add("hidden"); 

        if (this.areAllFacesLoaded(node)) {
          // perform navigation
          this.cameraHandlers.handleNavigation(node, {
            viewMode: "FPV",
          });

        } else {
          console.error("Loading had error:", node);

          // Handle the scenario where faces couldn't be loaded (e.g., show an error message)
          nodeLoadingScreen.classList.add("hidden"); 
        }
      });
    }

    // preload textures of nearest nodes
    this.preloadNearestNodes(node);
  }

  setLightIntensity(intensity) {
    this.targetIntensity = intensity;
    this.lerpAlpha = 0;   
  }

  // Call this function in your animation loop or in a setInterval
  updateLights() {
    if (this.lerpAlpha < 1) {
      this.lerpAlpha += 0.01; // Control the speed by changing this value
    }

    // Linearly interpolate between the current and target intensity
    this.currentIntensity = THREE.MathUtils.lerp(this.currentIntensity, this.targetIntensity, this.lerpAlpha);

    // Update the intensity of the ambient light
    this.ambientLight.intensity = this.currentIntensity;
  }

  setupEditing() {
    this.setupSpaceEdit();
    this.setupTourEdit();
  }

  setupSpaceEdit() {

      window.spaceshare = window.spaceshare || {};
      window.spaceshare.submitForm = () => {
        const { space, debugMode } = Store.getState();
        const nodes = space.space_data.nodes;  

        nodes.forEach(n => {
          // Find the node in this.nodes with the same uuid
          const thisNode = this.nodes.nodes.find(node => node.uuid === n.uuid);

          // If a node with a matching uuid is found, set n's floorPosition to thisNode's floorPosition
          if (thisNode) {
            n.floorPosition = thisNode.floormarker.group.position;
          }
        });

        // Set the value of the hidden input field
        document.getElementById('space_data_nodes').value = JSON.stringify({ nodes });
        
        // Submit the form
        document.getElementById('space_edit_form').submit();
      };
  }

  setupTourEdit() {

      window.spaceshare = window.spaceshare || {};
      window.spaceshare.submitFormTour = () => {
        const { space, tour } = Store.getState();

        const annotationGraph = tour.tour_data.annotationGraph;
        Object.keys(this.envCube.annotationGraph.annotationLookup).forEach(id => {
          const annotation = this.envCube.annotationGraph.annotationLookup[id];
          annotationGraph.forEach(a => {
            if (a.id === annotation.id) {
              a.position = annotation.overlay.position;
              a.rotation = {
                x: annotation.overlay.rotation.x,
                y: annotation.overlay.rotation.y,
                z: annotation.overlay.rotation.z,
              };
              a.scale = annotation.overlay.scale;
            }
          });
        })

        const sceneGraph = [];

        // Set the value of the hidden input field
        document.getElementById('tour_data_input').value = JSON.stringify({ annotationGraph, sceneGraph });
        
        // Submit the form
        document.getElementById('tour_edit_form').submit();
      };
  }

  setInitialTourCameraRotation() {
    const { space, tour } = Store.getState();

    const initialNode = space.space_data.nodes.find(node => node.uuid === tour.tour_data.spaces[0].tourpoints[0].nodeUUID);
    const initialOrbitTarget = getInitialOrbitTarget(
            space.space_data, 
            initialNode,
        );
    this.rig.setLerpTarget(initialOrbitTarget, tour.tour_data.spaces[0].tourpoints[0].rotation); 
  }


  update() {
    const { space } = Store.getState();

    if (space.type === "matterport") {
      return null;
    }

    if (!this.threejsEnvInited) {
      return null;
    }

    // manage fading in and out the light
    this.updateLights();

    this.rig.update();
    this.envCube.update();
    this.cursor.update();
    this.nodes.update();

    this.debugInfo.update();


    if (this.dollhouse) {
      this.dollhouse.update();
    }

    if (this.sceneGraph) {
      this.sceneGraph.update();
    }

    if (this.photograph) {
      this.photograph.update();
    }

    if (this.spaceCustom) {
      this.spaceCustom.update();
    }

    if (this.loadingScreen) {
      this.loadingScreen.render();
    }

    if (this.earthTiles) {
      this.earthTiles.update();
    }

    if (this.transitionManager) {
      this.transitionManager.update();
    }
  }
}

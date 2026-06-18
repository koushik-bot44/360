import './main.css'
import * as THREE from 'three'
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js'

import Store from './Store';
import EventManager from './EventManager';
import App from './components/App'



// log version
console.log("🌐🏛️ 360 Virtual Tour v1.0.0");

// Store
// Create App
Store.setState({ app: new App() });

// events
const eventManager = new EventManager();

// get store state for functions
const store = Store.getState();
const { app, camera, renderer, bloomLayer, sizes, scene, canvas, space, } = store;


// temp hack for allowing ui to modify store with less complication
window.__mused__ = window.__mused__ || {};
window.__mused__.store = store;
window.__mused__.app = app;


// resize
window.addEventListener('resize', () => {
  const { 
    space,
  } = Store.getState();

  // Update sizes
  sizes.width = window.innerWidth
  sizes.height = window.innerHeight

  if (space.type === "matterport") {
    return;
  }

  // Update camera
  camera.aspect = sizes.width / sizes.height // Using the camera from the App class
  camera.updateProjectionMatrix()

  // Update renderer
  renderer.setSize(sizes.width, sizes.height)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

  // post stack
  if (app.post.bloomComposer) {
    app.post.bloomComposer.setSize(sizes.width, sizes.height);
  }
  app.post.composer.setSize(sizes.width, sizes.height); 
})


renderer.setSize(sizes.width, sizes.height)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

const render = () => {
  const { 
    app, camera, renderer, scene, isNavigating, cubeRenderTarget, cubeCamera,
    cubeScene, space,
  } = Store.getState();

  if (space.type === "matterport") {
    return;
  }

  if (!app.threejsEnvInited) {
    return;
  }

  // base update for child components of app that have .update
  app.update(); 

  // post stack
  app.post.composer.render();

  // if tour has space custom and has post fx, render them
  if (app.spaceCustom) {
    app.spaceCustom.render();
  }
};

// Set up the onLoad event
store.loadingManager.onLoad = () => {
  const { inited } = Store.getState();
  
  if (!inited) {
    console.log("Initializing space");
    eventManager.startApp();
  }
};

// Set up other event handlers if needed
store.loadingManager.onProgress = (url, loaded, total) => {
  const { debugMode } = Store.getState();
  if (debugMode) {
    console.log('Loading file: ' + url + ' (' + loaded + '/' + total + ')');
  }

    // Calculate the percentage loaded
  const percentComplete = Math.floor((loaded / total) * 100);

  const loadingText = document.getElementById("loading-text-notification-percent")

  // Update the text content with the loading percentage
  loadingText.textContent =  percentComplete + '%';
};

if (space.type === "matterport") {
  console.log("Initializing Matterport space");
  const loadingText = document.getElementById("loading-text-notification-percent");

  let start = null;

  const animateLoading = (timestamp) => {
    if (!start) start = timestamp;
    const progress = timestamp - start;
    const percentComplete = Math.min(100, Math.floor((progress / 600) * 100));

    loadingText.textContent = percentComplete + '%';

    if (percentComplete < 100) {
      requestAnimationFrame(animateLoading);
    } else {
      eventManager.startApp();
    }
  };

  requestAnimationFrame(animateLoading);
}

// instead for future VR support, use this?
renderer.setAnimationLoop(render);


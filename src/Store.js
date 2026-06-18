import * as THREE from 'three'
import Space from './Space';

import {
    calculateCameraPosition,
    makeTextureTemplateUrls,
    getInitialCameraPosition,
    getInitialOrbitTarget
} from './lib/util';


// parse the data from the HTML first as a Space
const spaceConfig = new Space();
let space = spaceConfig.space;
const tour = spaceConfig.tour;


const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

const DEBUG_MODE = false; 
const SET_FLOORMARKER_HEIGHTS = DEBUG_MODE;
const VIEW_MODE = "FPV";

let initialNode = null;
let initialOrbitTarget = null;
let initialCameraPosition = new THREE.Vector3();
let initialFov = 90;
let initialZoom = 20;
let tourGuidedAutoplay = false;
let defaultShowText = true;

if (space.type === "spaces") {
    initialNode = space.space_data.nodes.find(node => node.uuid === space.space_data.initialNode);
    initialOrbitTarget = getInitialOrbitTarget(space.space_data);
    initialCameraPosition = getInitialCameraPosition(space.space_data);

    if (tour) {
        initialNode = space.space_data.nodes.find(node => node.uuid === tour.tour_data.spaces[0].tourpoints[0].nodeUUID);
        initialOrbitTarget = getInitialOrbitTarget(space.space_data, initialNode);
        initialCameraPosition = getInitialCameraPosition(space.space_data, initialNode, tour.tour_data.spaces[0].tourpoints[0].rotation);
        initialZoom = tour.tour_data.spaces[0].tourpoints[0].zoom;
        initialFov = 110 - tour.tour_data.spaces[0].tourpoints[0].zoom;
        tourGuidedAutoplay = tour.tour_data.autoplay;
        defaultShowText = tour.tour_data.defaultShowText;
    }
}

if (!tourGuidedAutoplay) {
    const autoplayCheck = document.getElementById("autoplay");
    if (autoplayCheck) {
        autoplayCheck.checked = false; 
    }

    const tourUiButtons = document.getElementById("tour-ui-buttons");
    tourUiButtons.style.transition = "opacity 0.5s";
    tourUiButtons.style.opacity = 1;
}

if (!defaultShowText) {
    const wordsCheckbox = document.getElementById("words");
    const tourUiNavpoint = document.getElementById("tour-ui-navpoint");
    wordsCheckbox.checked = false; 
    tourUiNavpoint.style.transition = "opacity 0.5s";
    tourUiNavpoint.style.opacity = 0;
}

// Canvas
const canvas = document.querySelector('canvas.webgl');

// camera
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.02, 10000);
camera.position.copy(initialCameraPosition);
camera.fov = initialFov;
camera.updateProjectionMatrix();

// scene
const scene = new THREE.Scene();

let cubeRenderTarget, cubeCamera, cubeScene;

if (!isMobile) {
    // Create a render target for the plane
    cubeRenderTarget = new THREE.WebGLCubeRenderTarget(4096, { 
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.NearestFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,     
        mapping: THREE.CubeRefractionMapping, 
    });
    cubeCamera = new THREE.CubeCamera(0.1, 1000, cubeRenderTarget);
    cubeScene = new THREE.Scene();
}

/**
 * Sizes
 */
const sizes = {
    width: window.innerWidth,
    height: window.innerHeight
}

/**
 * Renderer
 */
const renderer = new THREE.WebGLRenderer({
  canvas: canvas,
  antialias: true,
  powerPreference: "high-performance",
  // stencil: false,
})
renderer.gammaFactor = 2.2;
// renderer.outputEncoding = THREE.sRGBEncoding;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Using 2 as the max value for DPR
renderer.toneMapping = THREE.LinearToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.setSize(sizes.width, sizes.height);


// time
const clock = new THREE.Clock();

// integration with Google Map earth tiles
// lat/lon of the initial camera position
const INITIAL_LAT = null; 
const INITIAL_LON = null; 


const initialStore = {
    space,
    app: null,
    camera,
    scene,
    canvas,
    sizes,
    renderer,
    clock,
    cubeRenderTarget,
    cubeCamera,
    cubeScene,
    viewMode: VIEW_MODE, 
    styleMode: "",
    cursor: { position: new THREE.Vector3(), rotation: new THREE.Quaternion() },
    cursorOpacity: 0,
    cameraPosition: initialCameraPosition,
    lastMouseMove: Date.now(),
    zoomLvl: initialZoom,
    fullScreenMode: false,
    debugMode: DEBUG_MODE,
    setFloormarkerHeights: SET_FLOORMARKER_HEIGHTS,
    appLoaded: false,
    sceneInited: false,
    fov: initialFov,
    currentNode: initialNode,
    outgoingNode: initialNode,
    isNavigating: false,
    savedRotation: null,
    lerping: false,
    lerpValue: 0,
    minimapCamera: null,
    minimapRenderer: null,
    orbitControlsTarget: initialOrbitTarget,
    sceneGraph: null,
    textures: {},
    materialCache: {},
    tour,
    tourGuidedMode: tour && 'spaces' in tour && tour.spaces.length > 0,
    tourGuidedAutoplay,
    tourSpaceActiveIdx: 0,
    tourPointActiveIdx: 0,
    tourLightMode: false,
    floorMarkers: [],
    annotations: [],
    loadingManager: new THREE.LoadingManager(),
    isMobile,
    spaceConfig,
    initialLat: INITIAL_LAT,
    initialLon: INITIAL_LON,
};


// Store.js
class Store {
    constructor() {
        this.store = initialStore;
        this.listeners = [];
    }

    getState() {
        return this.store;
    }

    setState(newStore) {
        this.store = { ...this.store, ...newStore };
        this.notifyAll();
    }

    listen(listener) {
        this.listeners.push(listener);
    }

    notifyAll() {
        this.listeners.forEach(listener => listener(this.store));
    }
}

const store = new Store();

export default store;
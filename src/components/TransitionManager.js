// TransitionManager.js
import * as THREE from 'three'
import { setupSdk } from '@matterport/sdk';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import {
    calculateCameraPosition,
    makeTextureTemplateUrls,
    getInitialCameraPosition,
    getInitialOrbitTarget
} from '../lib/util';
import Store from '../Store';


class TransitionManager {
    constructor() {
        const { space, tour, tourGuidedMode } = Store.getState();
    }

    initializeSpace(spaceData) {
        if (spaceData.type === 'matterport') {
            this.switchToMatterport();
        } else {
            this.switchToCustomSpace();
        }
    }

    async switchToMatterport() {
        const { space, tour, tourSpaceActiveIdx } = Store.getState();


        // Hide buttons by adding the 'hidden' class
        const viewModeButton = document.getElementById('view-mode-button');
        const fullScreenButton = document.getElementById('full-screen-button');

        if (viewModeButton) {
            viewModeButton.classList.add('hidden');
        }

        if (fullScreenButton) {
            fullScreenButton.classList.add('hidden');
        }

        // Extract the space ID from the src URL
        let spaceId;
        if (tour) {
            spaceId = tour.tour_data.spaces[tourSpaceActiveIdx].mpid;
        } else {

            const url = new URL(space.src);
            spaceId = url.searchParams.get('m');
        }

        if (!spaceId) {
            console.error("Space ID not found in the src URL");
            return;
        }

        // Hide Three.js canvas
        document.querySelector('canvas.webgl').style.display = 'none';

        let showMattertags = 1;
        if (tour) {
            showMattertags = 0;
        }

        const options = {
            space: spaceId, // Use the spaceId from spaceData
            iframeAttributes: {},
            connectOptions: [], // Add any specific connect options if needed
            domain: 'my.matterport.com', // Default domain
            iframeAttributes: {
                width: '100%',
                height: '100%',
                allow: 'vr; xr; fullscreen',
            },
            iframeQueryParams: { mt: showMattertags, title: 0, search: 0, }, // Add any specific query parameters if needed
        };

        const iframe = document.getElementById('mp-showcase');
        if (iframe) {
            iframe.style.display = 'block';
        }

        await this.connectToMatterportSDK('y1bwseat2gwueyxz59987z4ud', options);

        if (tour.tour_data.sceneGraph && tour.tour_data.sceneGraph.length) {

            this.sceneGraph = [];
            this.loader = new GLTFLoader();
            const dracoLoader = new DRACOLoader();
            dracoLoader.setDecoderPath('https://static.mused.org/spaceshare/draco1.5.6/'); // Adjust this path to where your Draco scripts are located

            // Attach DracoLoader instance to GLTFLoader
            this.loader.setDRACOLoader(dracoLoader);

            this.initThreeJsCanvas();
       }
    }

    async connectToMatterportSDK(sdkKey, options) {
        try {
            const mpSdk = await setupSdk(sdkKey, options);
            Store.setState({ mpSdk });

            // Add event listener for sweep change
            mpSdk.Sweep.current.subscribe(sweep => {
                const { debugMode } = Store.getState();
                console.log(`Current sweep ID: ${sweep.sid}`);
            });

            // Add event listener for camera pose updates
            mpSdk.Camera.pose.subscribe(pose => {
                const { debugMode } = Store.getState();
                console.log(`Camera rotation:`, pose);
            });
        } catch (error) {
            console.error('Error connecting to Matterport SDK:', error);
        }
    }

    switchToCustomSpace() {
        const { app, space, tour, tourSpaceActiveIdx } = Store.getState();

        // fade between the canvas and matterport instead

        // Hide Matterport iframe`
        const mpShowcaseIframe = document.getElementById('mp-showcase');
        if (mpShowcaseIframe) {
            mpShowcaseIframe.style.display = 'none';
        }

        // Show buttons by removing the 'hidden' class
        const viewModeButton = document.getElementById('view-mode-button');
        const fullScreenButton = document.getElementById('full-screen-button');

        if (viewModeButton) {
            viewModeButton.classList.remove('hidden');
        }

        if (fullScreenButton) {
            fullScreenButton.classList.remove('hidden');
        }


        // Show Three.js canvas
        document.querySelector('canvas.webgl').style.display = 'block';

        let initialNode = null;
        let initialOrbitTarget = null;
        let initialCameraPosition = new THREE.Vector3();
        let initialFov = 90;
        let initialZoom = 20;

        if (space.type === "spaces") {
            initialNode = space.space_data.nodes.find(node => node.uuid === space.space_data.initialNode);
            initialOrbitTarget = getInitialOrbitTarget(space.space_data);
            initialCameraPosition = getInitialCameraPosition(space.space_data);

            if (tour) {
                initialNode = space.space_data.nodes.find(node => node.uuid === tour.tour_data.spaces[tourSpaceActiveIdx].tourpoints[0].nodeUUID);
                initialOrbitTarget = getInitialOrbitTarget(space.space_data, initialNode);
                initialCameraPosition = getInitialCameraPosition(space.space_data, initialNode, tour.tour_data.spaces[tourSpaceActiveIdx].tourpoints[0].rotation);
                initialZoom = tour.tour_data.spaces[tourSpaceActiveIdx].tourpoints[0].zoom;
                initialFov = 110 - tour.tour_data.spaces[tourSpaceActiveIdx].tourpoints[0].zoom;
            }
        }

        Store.setState({
            cameraPosition: initialCameraPosition,
            zoomLvl: initialZoom,
            fov: initialFov,
            currentNode: initialNode,
            outgoingNode: initialNode,
            orbitControlsTarget: initialOrbitTarget,
        });

        // Initialize the custom space if needed
        if (app) {
            app.initSpaceComponents();
        }
    }

    transitionToTourPoint(tourPoint) {
        const { space, mpSdk } = Store.getState();

        try {
            if (space.type === 'matterport') {
                this.navigateToMatterportTourpoint(mpSdk, tourPoint);
            } else {
                this.navigateToCustomSpace(tourPoint);
            }
        } catch (e) {
            console.error(e);
            return;
        }
    }

    async navigateToMatterportTourpoint(tourPoint) {
        const { mpSdk, app, space } = Store.getState();


        if (tourPoint.viewMode === 'DOLLHOUSE') {
            if (this.threeJsExtraCanvasVisible) {
                this.hideThreeJsCanvas();
                app.tourUI.tourNavButtons.setLightMode(false);
            }

            mpSdk.Mode.moveTo(mpSdk.Mode.Mode.DOLLHOUSE, {
                rotation: {
                    x: tourPoint.rotation.polar,
                    y: tourPoint.rotation.azimuth,
                },
            });
        } else if (tourPoint.viewMode === 'FLOORPLAN') {
            if (this.threeJsExtraCanvasVisible) {
                this.hideThreeJsCanvas();
                app.tourUI.tourNavButtons.setLightMode(false);
            }

            mpSdk.Mode.moveTo(mpSdk.Mode.Mode.FLOORPLAN, {
                rotation: { x: 0, y: 0 },
                position: { x: 0, y: 0, z: 0 },
                zoom: tourPoint.zoom,
            });
        } else if (tourPoint.viewMode === 'ORBIT') {
            console.log("Transitioning to ORBIT model mode");

            // fade in threejs canvas  
            if (!this.threeJsExtraCanvasVisible) {
                this.showThreeJsCanvas();
            }

            app.tourUI.tourNavButtons.setLightMode(true);

            // turn off all other visible models 
            this.sceneGraph.forEach(model => {
                model.visible = false;
            });

            // turn on only models for this tour point
            console.log("showing models", tourPoint.models);
            tourPoint.models.forEach(modelId => {
                const model = this.sceneGraph.find(m => m.name === modelId);
                console.log
                if (model) {
                    model.visible = true;
                    console.log("model visible", model);
                }
            });

            // set the camera to the position of the tour point
            const { threeJsCamera, threeJsControls } = Store.getState();
            if (threeJsCamera && threeJsControls) {
                threeJsCamera.position.set(
                    tourPoint.position.x,
                    tourPoint.position.y,
                    tourPoint.position.z
                );
                threeJsControls.update();
                console.log("Camera position set to", threeJsCamera.position);
            }

        } else {
            if (this.threeJsExtraCanvasVisible) {
                this.hideThreeJsCanvas();
                app.tourUI.tourNavButtons.setLightMode(false);
            }

            let transition = mpSdk.Sweep.Transition.FLY;
            if (typeof tourPoint.transition !== 'undefined' && tourPoint.transition) {
                transition = mpSdk.Sweep.Transition[tourPoint.transition];
            }
            mpSdk.Sweep.moveTo(tourPoint.nodeUUID, {
                rotation: {
                    x: tourPoint.rotation.polar,
                    y: tourPoint.rotation.azimuth,
                },
                transition,
            }).then((sweepId) => {
                console.log('- at sweep id', sweepId);
            });
        }
    }

    navigateToCustomSpace(tourPoint) {
        const { app } = Store.getState();
        app.ensureFacesLoadedThenNavigate(tourPoint);
    }

    // Initialize extra Three.js canvas for showing models
    initThreeJsCanvas() {
        const { tour } = Store.getState();
        const container = document.createElement('div');
        container.classList.add('threejs-canvas-container');
        document.body.appendChild(container);
        container.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            z-index: 9;
        `;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        const renderer = new THREE.WebGLRenderer();
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.gammaFactor = 2.2;
        renderer.gammaOutput = true;

        container.appendChild(renderer.domElement);
        scene.background = new THREE.Color(0xe2dac9);

        const controls = new OrbitControls(camera, renderer.domElement);
        camera.position.set(5, 5, 5);
        controls.update();

       // Add ambient light to achieve a uniform lighting effect
        const ambientLight = new THREE.AmbientLight(0xffffff, 1); // white light with full intensity
        scene.add(ambientLight);


        const rightRotationAdjustment = 0.0006;
        this.extraCanvasAnimate = () => {
            requestAnimationFrame(this.extraCanvasAnimate);


            // Rotate any visible model
            this.sceneGraph.forEach(model => {
                if (model.visible) {
                    model.rotation.y += rightRotationAdjustment;
                }
            }); 
            controls.update();
            renderer.render(scene, camera);
        };
        this.extraCanvasAnimate();

        // Hide the canvas initially
        container.style.display = 'none';

        const loadModelFromSceneGraph = (modelData) => {
            this.loader.load(
                modelData.file,
                (gltf) => {
                    const model = gltf.scene;
                    model.position.set(...modelData.position);
                    model.rotation.set(...modelData.rotation);
                    model.scale.set(...modelData.scale);
                    model.name = modelData.id;

                    if (modelData.id === "plateau_photogrammetry") {
                        // Inspect and adjust materials
                        model.traverse((node) => {
                            if (node.isMesh) {
                                const material = node.material;

                                if (material) {
                                    // Log material properties for debugging
                                    console.log('Material properties:', material);


                                    // Ensure all textures are loaded
                                    if (material.map) {
                                        console.log('Base color map:', material.map);
                                    }
                                    if (material.normalMap) {
                                        console.log('Normal map:', material.normalMap);
                                    }
                                    if (material.roughnessMap) {
                                        console.log('Roughness map:', material.roughnessMap);
                                    }
                                    if (material.metalnessMap) {
                                        console.log('Metalness map:', material.metalnessMap);
                                    }

                                    // For testing, convert to a simplified MeshStandardMaterial
                                    const standardMaterial = new THREE.MeshBasicMaterial({
                                        map: material.map,
                                        normalMap: material.normalMap,
                                    });

                                    node.material = standardMaterial;
                                    console.log('Converted to MeshStandardMaterial:', standardMaterial);
                                }

                                // Log geometry properties
                                console.log('Geometry:', node.geometry);
                            }
                        });
                    }

                    this.sceneGraph.push(model);
                    scene.add(gltf.scene);
                    gltf.scene.visible = false;

                    console.log("loaded", model);
                },
                undefined,
                (error) => {
                    console.error('An error occurred while loading the model:', error);
                }
            );
        }

        Store.setState({
            threeJsScene: scene,
            threeJsCamera: camera,
            threeJsRenderer: renderer,
            threeJsControls: controls,
        });

        // Loop through the sceneGraph and load each model
        tour.tour_data.sceneGraph.forEach(modelData => {
            loadModelFromSceneGraph(modelData);
        });
    }

    // Show the Three.js canvas
    showThreeJsCanvas() {
        console.log("Showing canvas");
        const container = document.querySelector('.threejs-canvas-container');
        if (container) {
            this.threeJsExtraCanvasVisible = true;
            container.style.opacity = 0;
            container.style.display = 'block';
            setTimeout(() => {
                container.style.transition = 'opacity 0.5s ease-in-out';
                container.style.opacity = 1;
            }, 0);
        }
    }

    // Hide the Three.js canvas
    hideThreeJsCanvas() {
        console.log("Hiding canvas");
        const container = document.querySelector('.threejs-canvas-container');
        if (container) {
            this.threeJsExtraCanvasVisible = false;
            container.style.transition = 'opacity 0.5s ease-in-out';
            container.style.opacity = 0;
            setTimeout(() => {
                container.style.display = 'none';
            }, 500); // Match this duration with the transition duration
        }
    }


    update() {
        if (this.threeJsExtraCanvasVisible) {
            this.extraCanvasAnimate();
        }
    }
}

export default TransitionManager;

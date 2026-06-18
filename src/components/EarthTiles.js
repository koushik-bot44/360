import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

import { GeoUtils, WGS84_ELLIPSOID, GoogleTilesRenderer } from '3d-tiles-renderer';

import Store from '../Store';


class EarthTiles {
    constructor() {
        this.tiles = null;
        this.apiKey = process.env.GOOGLE_TILES_API_KEY || '';

        this.init();
   }

    init() {
        const { scene, camera, renderer, initialLat, initialLon } = Store.getState();

        if ( this.tiles ) {

            scene.remove( this.tiles.group );
            this.tiles.dispose();
            this.tiles = null;

        }

        this.tiles = new GoogleTilesRenderer( this.apiKey );

        this.tiles.setLatLonToYUp( initialLat * THREE.MathUtils.DEG2RAD, initialLon * THREE.MathUtils.DEG2RAD ); 
        

        // Note the DRACO compression files need to be supplied via an explicit source.
        // We use unpkg here but in practice should be provided by the application.
        const dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath( 'https://unpkg.com/three@0.153.0/examples/jsm/libs/draco/gltf/' );

        const loader = new GLTFLoader( this.tiles.manager );
        loader.setDRACOLoader( dracoLoader );

        this.tiles.manager.addHandler( /\.gltf$/, loader );

        // cast shadows 
    this.tiles.group.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;

        // Change material to MeshPhongMaterial
        obj.material = new THREE.MeshPhongMaterial({
            // Copy relevant properties from the original material
            color: obj.material.color,
            map: obj.material.map, // assuming the original material has a texture map
            // ... any other properties you need to copy
        });
      }
    });


        scene.add( this.tiles.group );
        this.tiles.group.position.y -= 100;

        this.tiles.setResolutionFromRenderer( camera, renderer );
        this.tiles.setCamera( camera );
    }


    update() {
        if (!this.tiles) return;

        const { camera, renderer } = Store.getState();

        this.tiles.setResolutionFromRenderer(camera, renderer);
        this.tiles.setCamera(camera);
        this.tiles.update();
    }

    destroy() {
        if ( this.tiles ) {
            const { scene, camera, renderer } = Store.getState();

            scene.remove( this.tiles.group );
            this.tiles.dispose();
            this.tiles = null;

        }
    }
}

export default EarthTiles;

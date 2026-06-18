import * as THREE from 'three';

import Model from './Model'; 
import Store from '../Store';




export default class SceneGraph {
  constructor() {
    const { scene, tour } = Store.getState();

    this.modelLookup = {}; // This will store models by their id
    this.buildSceneGraph(tour.tour_data.sceneGraph);
  }

  buildSceneGraph(nodes) {
    const { scene } = Store.getState();

    nodes.forEach(node => {
      if (node.type === 'model') {
        const model = new Model(node, this.light);
        this.modelLookup[node.id] = model; // Store the model by its id
      } else if (node.type === 'group') {
        const group = new THREE.Group();
        group.position.set(...(node.position || [0, 0, 0]));
        node.children.forEach(childNode => this.buildSceneGraph([childNode])); // Pass child node as array
        scene.add(group);
        this.modelLookup[node.id] = group; // Store the group by its id
      }
    });
  }

  addHelpers() {
    const { scene } = Store.getState();
    
    const size = 10; // Size of the grid (you can adjust this based on your scene scale)
    const divisions = 10; // How many divisions in the grid
    const gridHelper = new THREE.GridHelper(size, divisions);
    scene.add(gridHelper);

    const length = 5; // Length of the axes (you can adjust this based on your scene scale)
    const axesHelper = new THREE.AxesHelper(length);
    scene.add(axesHelper);
  }

  getModelById(id) {
    const model = this.modelLookup[id];
    return model;
  }

  showModelById(id) {
    const model = this.modelLookup[id];
    if (model) {
      model.show();
    } else {
      console.warn(`Model with id ${id} not found.`);
    }
  }

  hideModelById(id) {
    const model = this.modelLookup[id];
    if (model) {
      model.hide();
    } else {
      console.warn(`Model with id ${id} not found.`);
    }
  }

  // Hide all models
  hideAllModels() {
    Object.keys(this.modelLookup).forEach(id => {
      const model = this.modelLookup[id];
      if (model && typeof model.hide === 'function') {
        model.hide();
      }
    });
  }

  update() {
    // Update all models in the scene graph
    Object.keys(this.modelLookup).forEach(id => {
      const model = this.modelLookup[id];
      if (model && typeof model.update === 'function') {
        model.update();
      }
    });
  }
}


import * as THREE from 'three'

import Store from '../Store';


export const calculateCameraPosition = (target, distance, azimuth, polar) => {
  const newPosition = new THREE.Vector3();
  
  newPosition.x = target.x + distance * Math.sin(polar) * Math.cos(azimuth);
  newPosition.y = target.y + distance * Math.cos(polar);
  newPosition.z = target.z + distance * Math.sin(polar) * Math.sin(azimuth);
  
  return newPosition;
}


export const areVector3Equal = (vector1, vector2) => {
  return (
    vector1.x === vector2.x && vector1.y === vector2.y && vector1.z === vector2.z
  );
}

export const makeImageSrc = ({ image, files }) => {
  let img_src = null;

  if (typeof image !== "undefined" && image.length) {
    if (image.indexOf(".gif") >= 0) {
      img_src = `https://static.mused.org/${image}`;
    } else {
      img_src = `https://iiif.mused.org/${image}/square/600,/0/default.jpg`;
    }
  } else if (files && files.length) {
    if (files[0].mime_type.indexOf(".gif") >= 0) {
      img_src = `https://static.mused.org/${files[0].filename}`;
    } else {
      img_src = `https://iiif.mused.org/${files[0].filename}/square/600,/0/default.jpg`;
    }
  }

  return img_src;
}

export const makeVideoSrc = ({ video, files }) => {
  let video_src = null;

  if (typeof video !== "undefined" && video.length) {
    video_src = `https://static.mused.org/${video}`;
  } else if (files && files.length) {
    video_src = `https://static.mused.org/${files[0].filename}`;
  }

  return video_src;
}


export const makeMapSrc = (map) => {
  if (map.indexOf("https") === 0) {
    return map;
  } else {
    return `https://www.google.com/maps/embed/v1/place?key=${process.env.GOOGLE_MAPS_API_KEY}&q=${map}&maptype=satellite&zoom=8`;
  }
}

// Function to calculate the Euclidean distance between two points
export const calculateDistance = (pointA, pointB) => {
  const dx = pointA.x - pointB.x;
  const dy = pointA.y - pointB.y;
  const dz = pointA.z - pointB.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};


export const makeTextureTemplateUrls = (textureUrl) => {
  // resolutions
  const resolutions = ["128,", "512,", "1024,", "2048,",];

  const urls = resolutions.map((resolution) => textureUrl.replace('{resolution}', resolution));

  // IIIF messes up lighting and image quality sometimes on resizing -- need to examine in the future, but for now, just load the static version also
  urls.push(textureUrl.replace("https://iiif.mused.org", "https://static.mused.org").replace("/full/{resolution}/0/default.jpg", ""))

  return urls;
}


export const getInitialOrbitTarget = (data, initialNode=null) => {
  const sceneSettings = data.sceneSettings;
  const nodeGroupSettings = data.sceneSettings.nodes;

  if (!initialNode) {
    initialNode = data.nodes.find(node => node.uuid === data.initialNode);
  }

  // Create a matrix for the scene's transformations
  const sceneMatrix = new THREE.Matrix4();
  // Apply the scene's position offset
  sceneMatrix.setPosition(new THREE.Vector3(
    sceneSettings.offsetPosition.x,
    sceneSettings.offsetPosition.y,
    sceneSettings.offsetPosition.z
  ));
  // Apply the scene's rotation offset
  sceneMatrix.makeRotationFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(sceneSettings.offsetRotation.x),
    THREE.MathUtils.degToRad(sceneSettings.offsetRotation.y),
    THREE.MathUtils.degToRad(sceneSettings.offsetRotation.z),
    'XYZ'
  ));

  // Create a matrix for the node group's transformations
  const nodeGroupMatrix = new THREE.Matrix4();

  // Apply the node group's position offset
  nodeGroupMatrix.setPosition(new THREE.Vector3(
    nodeGroupSettings.offsetPosition.x,
    nodeGroupSettings.offsetPosition.y,
    nodeGroupSettings.offsetPosition.z
  ));

  // Apply the node group's rotation offset
  nodeGroupMatrix.makeRotationFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(nodeGroupSettings.offsetRotation.x),
    THREE.MathUtils.degToRad(nodeGroupSettings.offsetRotation.y),
    THREE.MathUtils.degToRad(nodeGroupSettings.offsetRotation.z),
    'XYZ'
  ));

    // Retrieve the node group's scale setting
  const nodeGroupScale = nodeGroupSettings.scale;

  // Apply the node group's scale
  nodeGroupMatrix.scale(new THREE.Vector3(nodeGroupScale, nodeGroupScale, nodeGroupScale));

  // Get the initial node's position
  const initialNodePosition = new THREE.Vector3(
    initialNode.position.x,
    initialNode.position.y,
    initialNode.position.z
  );

  // Transform the initial node's position by the scene matrix and then by the node group matrix
  const worldPosition = initialNodePosition.applyMatrix4(sceneMatrix).applyMatrix4(nodeGroupMatrix);

  return worldPosition;
};


export const getInitialCameraPosition = (data, initialNode=null, initialRotation=null) => {
  // Get the initial orbit target position
  const orbitTarget = getInitialOrbitTarget(data, initialNode);

  if (!initialRotation) {
    initialRotation = data.initialRotation;
  }

  // Get the azimuth and polar angles in radians
  const azimuth = THREE.MathUtils.degToRad(initialRotation.azimuth);
  const polar = THREE.MathUtils.degToRad(initialRotation.polar);

  // Calculate the distance from the target you want the camera to be
  const radius = 0.1; 

  // Calculate the camera position based on spherical coordinates
  const x = orbitTarget.x + radius * Math.sin(polar) * Math.cos(azimuth);
  const y = orbitTarget.y + radius * Math.cos(polar);
  const z = orbitTarget.z + radius * Math.sin(polar) * Math.sin(azimuth);

  // Return the initial camera position
  return new THREE.Vector3(x, y, z);
};



export const useCachedTexture = (uuid, faceI, res = "1024", version=null, onTextureLoaded=null) => {
  const { textures, loadingManager } = Store.getState();
  const url = getTextureUrl(uuid, faceI, res, version);

  const textureLoader = new THREE.TextureLoader(loadingManager);

  // handle weird edge cases where map tour points get passed in
  if (uuid.startsWith("map")) {
    return null;
  }

  if (!textures[url]) {
    textures[url] = textureLoader.load(url, (tex) => {
      applyTextureSettings(tex);

      // handle callback if necessary
      if (onTextureLoaded) {
        onTextureLoaded(uuid, faceI, tex);
      }
    }) 
  }

  return textures[url];
};

const applyTextureSettings = (texture) => {
  texture.minFilter = THREE.LinearMipMapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 16;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export const getTextureUrl = (uuid, faceI, resolution="1024", version=null) => {
  let _res = resolution;

  if (_res !== "full") {
    _res += ","
  }

  let versionPart = '';

  if (version) {
    versionPart = `_${version}`;
  }

  if (resolution === "4096") {
    return `https://static.mused.org/spaceshare/${uuid}_face${faceI}${versionPart}.jpg`;
  }

  if (resolution === "1024") {
    return `https://static.mused.org/spaceshare/${uuid}_face${faceI}${versionPart}_1024.jpg`;
  }

  return `https://iiif.mused.org/spaceshare/${uuid}_face${faceI}${versionPart}.jpg/full/${_res}/0/default.jpg`
}
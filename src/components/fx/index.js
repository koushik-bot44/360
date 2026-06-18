
// import custom components here 
import Birds from './Birds';

import Store from '../../Store';


const tours = {
    birds: Birds,
}

const setupSpaceCustom = () => {

    const { tour } = Store.getState();
    if (tours[tour.space_custom]) {
        return new tours[tour.space_custom]();
    }
    
    return null;
}

export default setupSpaceCustom;
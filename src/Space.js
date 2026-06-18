// Space.js

export default class Space {
    constructor() {
        this.space = null;
        this.tour = null;

        this.parseDataFromHTML();

        console.log("SPACE:", this.space);
        if (this.tour) {
          console.log("TOUR:", this.tour);
        }
    }

    parseDataFromHTML() {
        const tourDataElem = document.getElementById('tour_data');
        const spaceDataElem = document.getElementById('space_data');
        const orderedSpacesDataElem = document.getElementById('ordered_spaces_data');
        const meshElem = document.getElementById('space_mesh');

        if (spaceDataElem) {
          this.space = JSON.parse(spaceDataElem.textContent);
        }

        if (tourDataElem) {
          this.tour = JSON.parse(tourDataElem.textContent);

        }

        if (orderedSpacesDataElem) {
            this.spaces = JSON.parse(orderedSpacesDataElem.textContent);
            console.log("SPACES: ", this.spaces);

            // Get the first space in tour.tour_data.spaces and find the corresponding space from this.spaces
            if (this.tour 
              && this.tour.tour_data 
              && this.tour.tour_data.spaces 
              && this.tour.tour_data.spaces.length > 0
              ) {
                const firstSpaceId = this.tour.tour_data.spaces[0].id.toString();
                this.space = this.spaces.find((space) => {
                  return (space.id.toString() === firstSpaceId);
                });
            }
        }
    }
}

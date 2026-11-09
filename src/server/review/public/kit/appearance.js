// Applies the theme and density that the review app stores for the user.
// The page loads this module last; importing the stored choice as a JSON module makes it part of the page's load,
// so the page has finished loading only once the stored choice applies, and a review app that cannot be reached leaves the browser's last choice in place.
import stored from "../api/preferences" with { type: "json" };
import { adoptStoredPreferences } from "./preferences.js";

adoptStoredPreferences(stored);

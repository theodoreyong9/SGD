// Browser Geolocation wrapper, used two places for two different
// reasons: REQUIRED at submission time — every proposition is tagged
// with where it came from, never with who submitted it (see
// scripts/validate-submission.mjs, which rejects a submission with no
// location, and scripts/process-graph.mjs, which stores it on the
// node, never alongside any contributor identity) — and OPTIONAL at
// search time, to filter results within a radius (see runSearch() in
// app.js).
//
// Coordinates are rounded to 3 decimal places (~111m at the equator)
// before they ever leave this module. That's enough resolution for a
// meaningful search radius, without a submission publishing a
// contributor's exact, permanent position in a GitHub Issue that can
// never really be taken back.

export class GeolocationError extends Error {}

export function isGeolocationAvailable() {
  return typeof navigator !== "undefined" && "geolocation" in navigator;
}

function roundCoord(n) {
  return Math.round(n * 1000) / 1000;
}

const ERROR_MESSAGES = {
  1: "Location access was denied — allow it in your browser to continue.",
  2: "Your location could not be determined.",
  3: "Getting your location timed out — try again.",
};

// getCurrentLocation() -> Promise<{ lat, lon }>
export function getCurrentLocation() {
  if (!isGeolocationAvailable()) {
    return Promise.reject(new GeolocationError("Geolocation is not available in this browser."));
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: roundCoord(pos.coords.latitude),
          lon: roundCoord(pos.coords.longitude),
        });
      },
      (err) => reject(new GeolocationError(ERROR_MESSAGES[err.code] || "Could not get your location.")),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  });
}

// haversineDistanceKm(a, b): great-circle distance between two
// {lat, lon} points, in kilometers — used only for the optional
// search-radius filter, never for anything that decides a
// submission's identity or place in the graph.
const EARTH_RADIUS_KM = 6371;

export function haversineDistanceKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * NexusPay Frontend Configuration
 * ================================
 * Edit NEXUSPAY_API_URL before deploying the frontend.
 *
 * After deploying your backend to Railway/Render/Fly.io,
 * replace the URL below with your actual backend URL.
 *
 * Example:
 *   window.NEXUSPAY_API_URL = "https://nexuspay-api.railway.app/api/v1";
 */
/**
 * NEXUSPAY_API_URL
 * Automatically points to port 5000 if running on localhost, 
 * or uses the global window setting.
 */
window.NEXUSPAY_API_URL = window.NEXUSPAY_API_URL || (
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" 
    ? `http://${window.location.hostname}:5000/api/v1`
    : `http://${window.location.hostname}:5000/api/v1` // Fallback for direct IP access
);

// Platform branding
window.NEXUSPAY_BRAND = {
  name: "NexusPay",
  tagline: "Secure Payment Infrastructure",
  website: "https://nexuspay.io",
  support: "support@nexuspay.io",
  color: "#5b4fff",
};

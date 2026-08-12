const { openUrl } = window.__TAURI__.opener;

const { invoke } = window.__TAURI__.core;

// Betterfy autoplay
let autoplayEnabled = true;

// Betterfy autoplay is kept LOCAL.
//
// IMPORTANT:
// Autoplay recommendations must NOT be inserted into Spotify's
// explicit playback queue. Spotify gives explicit queued songs
// priority over playlist/album context tracks.
//
// Only the user's "+ Queue" button should call addTrackToQueue().
let autoplayPrepareInProgress = false;

let preparedAutoplayUris = [];
let preparedAutoplaySeedId = null;

let autoplayStartInProgress = false;

const AUTOPLAY_TRACK_COUNT = 3;

const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID;
const LASTFM_API_KEY = import.meta.env.VITE_LASTFM_API_KEY;

if (!CLIENT_ID) {
  throw new Error("VITE_SPOTIFY_CLIENT_ID is missing from .env");
}

if (!LASTFM_API_KEY) {
  throw new Error("VITE_LASTFM_API_KEY is missing from .env");
}

// This MUST exactly match a redirect URI registered
// in your Spotify Developer Dashboard.
const REDIRECT_URI = "http://127.0.0.1:8888/callback";

const SCOPES = [
  "user-read-private",
  "user-top-read",
  "user-read-recently-played",
  "user-read-playback-state",
  "user-modify-playback-state",
  "playlist-read-private",
  "playlist-modify-private",
  "playlist-modify-public",
  "streaming",
  "user-read-email",
];

const TOKEN_KEYS = {
  accessToken: "spotify_access_token",
  refreshToken: "spotify_refresh_token",
  expiresAt: "spotify_token_expires_at",
};

const VOLUME_KEY = "betterfy_volume";

let spotifyPlayer = null;
let spotifyDeviceId = null;

let spotifyDeviceReady = false;
let spotifyDeviceSetupPromise = null;

let currentPosition = 0;
let currentDuration = 0;
let isCurrentlyPlaying = false;

let repeatMode = "off";
let repeatChangeInProgress = false;

let shuffleEnabled = false;

let lastQueueTrackId = null;

let progressTimer = null;
let isSeeking = false;

let resourceMonitorTimer = null;
let peakRamUsage = 0;
let lowMemoryModeEnabled = true;

let currentPlaylistItems = [];
let currentPlaylist = null;
let renderedPlaylistCount = 0;

const RECENT_PLAYLISTS_KEY = "betterfy_recent_playlists";
const MAX_RECENT_PLAYLISTS = 50;
const PLAYLIST_PAGE_SIZE = 30;

let playlistReturnView = "home";
let allPlaylistsOffset = 0;
let allPlaylistsLoading = false;
let allPlaylistsFinished = false;

let searchRequestId = 0;

let artistRequestId = 0;

let currentDiscographyArtist = null;

let discographyOffset = 0;
let discographyLoading = false;
let discographyFinished = false;

let releaseReturnView = "artist";

let searchAbortController = null;

const DISCOGRAPHY_PAGE_SIZE = 10;

const PLAYLIST_RENDER_BATCH_SIZE = 30;

/* =========================
   RESOURCE & GENERAL UTILITIES
========================= */

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function debounce(callback, delay) {
  let timeoutId;

  return (...args) => {
    clearTimeout(timeoutId);

    timeoutId = setTimeout(() => callback(...args), delay);
  };
}

function generateRandomString(length) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  const values = crypto.getRandomValues(new Uint8Array(length));

  return Array.from(values)
    .map((value) => chars[value % chars.length])
    .join("");
}

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  return crypto.subtle.digest("SHA-256", data);
}

function base64UrlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function normalizeText(value) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getSmallestSpotifyImage(images) {
  if (!images || images.length === 0) {
    return "";
  }

  return images[images.length - 1]?.url ?? "";
}

function getMediumSpotifyImage(images) {
  if (!images || images.length === 0) {
    return "";
  }

  if (images.length >= 2) {
    return images[1]?.url ?? "";
  }

  return images[0]?.url ?? "";
}

async function updateResourceMeter() {
  const ramElement = document.querySelector("#ram-usage");

  const peakRamElement = document.querySelector("#peak-ram-usage");

  const coreRamElement = document.querySelector("#core-ram-usage");

  const childRamElement = document.querySelector("#child-ram-usage");

  const cpuElement = document.querySelector("#cpu-usage");

  const processCountElement = document.querySelector("#process-count");

  if (
    !ramElement ||
    !peakRamElement ||
    !coreRamElement ||
    !childRamElement ||
    !cpuElement ||
    !processCountElement
  ) {
    return;
  }

  try {
    const usage = await invoke("get_resource_usage");

    /*
     * Update peak RAM.
     */
    peakRamUsage = Math.max(peakRamUsage, usage.memory_mb);

    ramElement.textContent = `${usage.memory_mb.toFixed(0)} MB`;

    peakRamElement.textContent = `${peakRamUsage.toFixed(0)} MB`;

    coreRamElement.textContent = `${usage.core_memory_mb.toFixed(0)} MB`;

    childRamElement.textContent = `${usage.child_memory_mb.toFixed(0)} MB`;

    cpuElement.textContent = `${usage.cpu_percent.toFixed(1)}%`;

    processCountElement.textContent = String(usage.process_count);
  } catch (error) {
    console.error("Could not get resource usage:", error);

    ramElement.textContent = "-- MB";

    peakRamElement.textContent =
      peakRamUsage > 0 ? `${peakRamUsage.toFixed(0)} MB` : "-- MB";

    coreRamElement.textContent = "-- MB";

    childRamElement.textContent = "-- MB";

    cpuElement.textContent = "--%";

    processCountElement.textContent = "--";
  }
}

function startResourceMonitor() {
  // Prevent accidentally starting multiple timers
  if (resourceMonitorTimer) {
    return;
  }

  // Get a reading immediately
  updateResourceMeter();

  // Then update every 2 seconds
  resourceMonitorTimer = setInterval(updateResourceMeter, 5000);
}

function stopResourceMonitor() {
  if (resourceMonitorTimer) {
    clearInterval(resourceMonitorTimer);
    resourceMonitorTimer = null;
  }
}

async function setBetterfyMemoryMode(low) {
  try {
    await invoke("set_webview_memory_mode", {
      low,
    });

    lowMemoryModeEnabled = low;

    const button = document.querySelector("#memory-mode-button");

    if (button) {
      button.textContent = low ? "Normal memory" : "Low memory";
    }

    console.log(`Betterfy memory mode = ${low ? "LOW" : "NORMAL"}`);

    return true;
  } catch (error) {
    console.error("Could not change WebView memory mode:", error);

    return false;
  }
}

/* =========================
   SPOTIFY AUTHENTICATION & API
========================= */

function saveSpotifyTokens(tokenData) {
  if (tokenData.access_token) {
    localStorage.setItem(TOKEN_KEYS.accessToken, tokenData.access_token);
  }

  if (tokenData.refresh_token) {
    localStorage.setItem(TOKEN_KEYS.refreshToken, tokenData.refresh_token);
  }

  if (tokenData.expires_in) {
    const expiresAt = Date.now() + Number(tokenData.expires_in) * 1000;

    localStorage.setItem(TOKEN_KEYS.expiresAt, String(expiresAt));
  }
}

function clearSpotifyTokens() {
  localStorage.removeItem(TOKEN_KEYS.accessToken);
  localStorage.removeItem(TOKEN_KEYS.refreshToken);
  localStorage.removeItem(TOKEN_KEYS.expiresAt);
}

function getStoredAccessToken() {
  return localStorage.getItem(TOKEN_KEYS.accessToken);
}

function getStoredRefreshToken() {
  return localStorage.getItem(TOKEN_KEYS.refreshToken);
}

function isAccessTokenExpired() {
  const expiresAt = Number(localStorage.getItem(TOKEN_KEYS.expiresAt));

  if (!expiresAt) {
    return true;
  }

  // Refresh one minute early so the token doesn't expire
  // while a Spotify request is happening.
  return Date.now() >= expiresAt - 60_000;
}

async function refreshSpotifyAccessToken() {
  const refreshToken = getStoredRefreshToken();

  if (!refreshToken) {
    throw new Error("No Spotify refresh token found");
  }

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",

    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },

    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  const tokenData = await response.json();

  if (!response.ok) {
    console.error(
      "Spotify token refresh failed:",
      tokenData?.error ?? "unknown",
    );

    // Expired/revoked refresh token.
    if (tokenData.error === "invalid_grant") {
      clearSpotifyTokens();

      throw new Error("Spotify authorization expired. Please connect again.");
    }

    throw new Error(
      tokenData.error_description ??
        tokenData.error ??
        "Could not refresh Spotify token",
    );
  }

  saveSpotifyTokens(tokenData);

  return tokenData.access_token;
}

async function getValidSpotifyAccessToken() {
  let accessToken = getStoredAccessToken();

  const refreshToken = getStoredRefreshToken();

  if (!accessToken || isAccessTokenExpired()) {
    if (!refreshToken) {
      return null;
    }

    accessToken = await refreshSpotifyAccessToken();
  }

  return accessToken;
}

async function exchangeCodeForToken(code) {
  const verifier = sessionStorage.getItem("spotify_code_verifier");

  if (!verifier) {
    throw new Error("PKCE code verifier is missing");
  }

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "authorization_code",
    code: code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",

    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },

    body: body.toString(),
  });

  if (!response.ok) {
    const error = await response.text();

    throw new Error(`Spotify token exchange failed: ${error}`);
  }

  return response.json();
}

async function getSpotifyProfile(accessToken) {
  const response = await fetch("https://api.spotify.com/v1/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Profile request failed: ${response.status}`);
  }

  return response.json();
}

async function spotifyFetch(endpoint, options = {}) {
  const accessToken = await getValidSpotifyAccessToken();

  if (!accessToken) {
    throw new Error("No Spotify access token found");
  }

  let response = await fetch(`https://api.spotify.com/v1${endpoint}`, {
    ...options,

    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  // If Spotify rejects the token anyway,
  // try refreshing once.
  if (response.status === 401 && getStoredRefreshToken()) {
    const refreshedToken = await refreshSpotifyAccessToken();

    response = await fetch(`https://api.spotify.com/v1${endpoint}`, {
      ...options,

      headers: {
        Authorization: `Bearer ${refreshedToken}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  }

  if (!response.ok) {
    const error = await response.text();

    throw new Error(`Spotify API error ${response.status}: ${error}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function loginWithSpotify() {
  try {
    /*
     * If logout cleanup is still running,
     * wait before starting another session.
     */

    const verifier = generateRandomString(64);

    const hashed = await sha256(verifier);
    const challenge = base64UrlEncode(hashed);

    sessionStorage.setItem("spotify_code_verifier", verifier);

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPES.join(" "),
      code_challenge_method: "S256",
      code_challenge: challenge,
    });

    const authUrl = `https://accounts.spotify.com/authorize?${params.toString()}`;

    document.querySelector("#status").textContent =
      "Waiting for Spotify login...";

    // Start Rust listener FIRST
    const callbackPromise = invoke("wait_for_spotify_callback");

    // Then open Spotify
    await openUrl(authUrl);

    // Wait until Spotify redirects to localhost
    const code = await callbackPromise;

    document.querySelector("#status").textContent =
      "Spotify authorized! Getting access token...";

    const tokenData = await exchangeCodeForToken(code);

    console.debug("Spotify token received:", Boolean(tokenData?.access_token));

    // Save access token
    saveSpotifyTokens(tokenData);

    // Use the access token to get the user's Spotify profile
    const profile = await getSpotifyProfile(tokenData.access_token);

    console.debug("Spotify profile loaded:", profile?.id ?? "unknown");

    // Show the user's Spotify name in the app
    document.querySelector("#status").textContent =
      `Connected as ${profile.display_name}`;

    const loginButton = document.querySelector("#spotify-login");

    const logoutButton = document.querySelector("#spotify-logout");

    if (loginButton) {
      loginButton.setAttribute("hidden", "");
    }

    if (logoutButton) {
      logoutButton.removeAttribute("hidden");
    }

    const playlists = await getUserPlaylists();

    console.debug("Playlist count:", playlists?.items?.length ?? 0);

    renderPlaylists(playlists.items);

    /*
     * New account/session is now established.
     * Create the Web Playback SDK player LAST.
     */
    if (window.Spotify) {
      initializeSpotifyPlayer();
    }

    await updatePlayer();
  } catch (error) {
    console.error("Betterfy startup error:", error);

    document.querySelector("#status").textContent = `Error: ${error.message}`;
  }
}

function cleanupPlaybackResources() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }

  if (spotifyPlayer) {
    try {
      spotifyPlayer.disconnect();
    } catch (error) {
      console.warn("Spotify player disconnect warning:", error);
    }
  }

  spotifyPlayer = null;

  spotifyDeviceId = null;
  spotifyDeviceReady = false;
  spotifyDeviceSetupPromise = null;

  autoplayFillInProgress = false;
  lastAutoplayFillTrackId = null;
  lastQueueTrackId = null;
  lastAutoplayFillTime = 0;

  isCurrentlyPlaying = false;
  isSeeking = false;

  currentPosition = 0;
  currentDuration = 0;

  repeatChangeInProgress = false;

  const art = document.querySelector("#player-art");

  if (art) {
    art.removeAttribute("src");
  }

  clearSimilarResults();
}

async function logoutSpotify() {
  try {
    console.log("Logging out of Spotify...");

    cleanupPlaybackResources();

    /*
     * Delete Spotify authorization.
     */
    clearSpotifyTokens();

    sessionStorage.removeItem("spotify_code_verifier");

    /*
     * Clear anything Spotify-specific
     * from the UI before reload.
     */
    const playerBar = document.querySelector("#player-bar");

    if (playerBar) {
      playerBar.setAttribute("hidden", "");
    }

    const playlists = document.querySelector("#playlists");

    if (playlists) {
      playlists.innerHTML = "";
    }

    const playlistTracks = document.querySelector("#playlist-tracks");

    if (playlistTracks) {
      playlistTracks.innerHTML = "";
    }

    const searchResults = document.querySelector("#search-results");

    if (searchResults) {
      searchResults.innerHTML = "";
    }

    const queueTracks = document.querySelector("#queue-tracks");

    if (queueTracks) {
      queueTracks.innerHTML = "";
    }

    currentPlaylistItems = [];
    currentPlaylist = null;
    renderedPlaylistCount = 0;

    clearSimilarResults();

    console.log("Spotify logout complete. Reloading Betterfy...");

    /*
     * IMPORTANT:
     *
     * Completely reset the Spotify Web
     * Playback SDK and WebView JS state.
     */

    stopResourceMonitor();

    window.location.reload();
  } catch (error) {
    console.error("Spotify logout error:", error);
  }
}

async function restoreSpotifySession() {
  const refreshToken = getStoredRefreshToken();

  if (!refreshToken) {
    document.querySelector("#status").textContent = "Not connected to Spotify";

    const loginButton = document.querySelector("#spotify-login");

    const logoutButton = document.querySelector("#spotify-logout");

    if (loginButton) {
      loginButton.removeAttribute("hidden");
    }

    if (logoutButton) {
      logoutButton.setAttribute("hidden", "");
    }

    return false;
  }

  try {
    const accessToken = await getValidSpotifyAccessToken();

    if (!accessToken) {
      return false;
    }

    const profile = await getSpotifyProfile(accessToken);

    document.querySelector("#status").textContent =
      `Connected as ${profile.display_name}`;

    const loginButton = document.querySelector("#spotify-login");

    const logoutButton = document.querySelector("#spotify-logout");

    if (loginButton) {
      loginButton.setAttribute("hidden", "");
    }

    if (logoutButton) {
      logoutButton.removeAttribute("hidden");
    }

    await loadHomePlaylists();

    if (window.Spotify) {
      initializeSpotifyPlayer();
    }

    await updatePlayer();

    return true;
  } catch (error) {
    console.error("Spotify session restore failed:", error);

    document.querySelector("#status").textContent = "Connect Spotify";

    return false;
  }
}

/* =========================
   SPOTIFY DEVICE & PLAYER SETUP
========================= */

async function getSpotifyDevices() {
  return spotifyFetch("/me/player/devices");
}

async function waitForSpotifyDevice(deviceId, timeoutMs = 5000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const data = await getSpotifyDevices();

      const devices = data?.devices ?? [];

      console.debug("Spotify device count:", devices.length);

      const device = devices.find((item) => item.id === deviceId);

      if (device) {
        console.debug("Betterfy device registered:", device.id);

        return device;
      }
    } catch (error) {
      console.warn("Could not check Spotify devices yet:", error);
    }

    await sleep(500);
  }

  throw new Error(
    "Betterfy playback device did not become available in Spotify.",
  );
}

async function ensureSpotifyDeviceReady() {
  if (spotifyDeviceReady && spotifyDeviceId) {
    return spotifyDeviceId;
  }

  if (!spotifyDeviceId) {
    throw new Error("Betterfy playback device is not ready yet.");
  }

  if (spotifyDeviceSetupPromise) {
    await spotifyDeviceSetupPromise;

    return spotifyDeviceId;
  }

  const deviceId = spotifyDeviceId;

  spotifyDeviceSetupPromise = (async () => {
    try {
      console.log("Preparing Betterfy Spotify device:", deviceId);

      /*
       * Give Spotify Connect a short
       * chance to expose the SDK device
       * through /me/player/devices.
       *
       * Some systems never expose it
       * there promptly even though the
       * Web Playback SDK fired "ready".
       */
      try {
        await waitForSpotifyDevice(deviceId, 5000);
      } catch (error) {
        console.warn(
          "Betterfy device was not listed by Spotify; trying direct transfer:",
          error,
        );
      }

      if (spotifyDeviceId !== deviceId) {
        throw new Error("Spotify device changed while connecting.");
      }

      /*
       * Use the device_id supplied
       * directly by the SDK.
       */
      await transferPlaybackToTauri();

      spotifyDeviceReady = true;

      console.log("Betterfy Spotify device is fully ready:", deviceId);
    } finally {
      spotifyDeviceSetupPromise = null;
    }
  })();

  await spotifyDeviceSetupPromise;

  return spotifyDeviceId;
}

async function transferPlaybackToTauri() {
  if (!spotifyDeviceId) {
    throw new Error("Betterfy playback device is not ready");
  }

  const accessToken = await getValidSpotifyAccessToken();

  if (!accessToken) {
    throw new Error("No Spotify access token");
  }

  const response = await fetch("https://api.spotify.com/v1/me/player", {
    method: "PUT",

    headers: {
      Authorization: `Bearer ${accessToken}`,

      "Content-Type": "application/json",
    },

    body: JSON.stringify({
      device_ids: [spotifyDeviceId],

      play: false,
    }),
  });

  if (!response.ok) {
    const error = await response.text();

    throw new Error(`Transfer failed ${response.status}: ${error}`);
  }
}

function initializeSpotifyPlayer() {
  if (spotifyPlayer) {
    console.log("Spotify player already initialized");

    return;
  }

  console.log("Initializing Spotify Web Playback SDK...");

  if (!window.Spotify) {
    console.log("Spotify SDK has not loaded yet.");
    return;
  }

  const player = new Spotify.Player({
    name: "Betterfy Desktop",

    getOAuthToken: async (callback) => {
      try {
        const token = await getValidSpotifyAccessToken();

        if (!token) {
          console.error("No Spotify access token available");

          return;
        }

        callback(token);
      } catch (error) {
        console.error("Could not get Spotify token:", error);
      }
    },

    volume: getSavedVolume() / 100,
  });

  spotifyPlayer = player;

  player.addListener("ready", async ({ device_id }) => {
    if (spotifyPlayer !== player) {
      console.log("Ignoring ready event from old Spotify player:", device_id);

      return;
    }

    console.log("Betterfy SDK device ready:", device_id);

    spotifyDeviceId = device_id;

    spotifyDeviceReady = false;

    spotifyDeviceSetupPromise = null;

    /*
     * Restore saved volume.
     */
    try {
      await player.setVolume(getSavedVolume() / 100);
    } catch (error) {
      console.error("Could not restore saved volume:", error);
    }

    /*
     * IMPORTANT:
     *
     * SDK "ready" does not necessarily
     * mean Spotify's Web API can see the
     * device yet.
     */
    try {
      await ensureSpotifyDeviceReady();

      console.log("Playback transferred to Betterfy");

      /*
       * Rename Windows audio session
       * after playback device setup.
       */
      setTimeout(async () => {
        try {
          await invoke("rename_audio_session");

          console.log("Windows audio session renamed to Betterfy");
        } catch (error) {
          console.error("Could not rename audio session:", error);
        }
      }, 1500);
    } catch (error) {
      console.error("Could not prepare Betterfy playback device:", error);

      const status = document.querySelector("#status");

      if (status) {
        status.textContent = "Spotify playback device is still connecting...";
      }
    }
  });

  player.addListener("player_state_changed", (state) => {
    if (spotifyPlayer !== player) {
      return;
    }

    if (!state) {
      return;
    }

    console.log(
      "Spotify playback state:",
      "repeat_mode =",
      state.repeat_mode,
      "track =",
      state.track_window.current_track?.name,
    );

    // Keep Betterfy's repeat button synchronized with
    // Spotify's REAL playback state.
    //
    // Spotify SDK repeat_mode:
    // 0 = off
    // 1 = repeat context
    // 2 = repeat track
    if (!repeatChangeInProgress) {
      if (state.repeat_mode === 2) {
        repeatMode = "track";
      } else if (state.repeat_mode === 1) {
        repeatMode = "context";
      } else {
        repeatMode = "off";
      }

      updateRepeatButton();
    }

    const previousTrack = state.track_window.previous_tracks?.at(-1);

    const currentTrack = state.track_window.current_track;

    const currentTrackId = currentTrack?.id ?? currentTrack?.uri ?? null;

    if (currentTrackId && currentTrackId !== lastQueueTrackId) {
      const hadPreviousTrack = lastQueueTrackId !== null;

      lastQueueTrackId = currentTrackId;

      if (hadPreviousTrack) {
        void refreshQueueIfVisible();
      }
    }

    // Update the top-right currently playing text
    if (currentTrack) {
      const status = document.querySelector("#status");

      const artists =
        currentTrack.artists?.map((artist) => artist.name).join(", ") ?? "";

      if (status) {
        if (state.paused) {
          status.textContent = `Paused ${currentTrack.name} — ${artists}`;
        } else {
          status.textContent = `Playing ${currentTrack.name} — ${artists}`;
        }
      }
    }

    const nextTracks = state.track_window.next_tracks ?? [];

    /*
     * AUTOPLAY PRIORITY RULE:
     *
     * Playlist / album context
     *        ↓
     * User "+ Queue" tracks
     *        ↓
     * Betterfy autoplay
     *
     * Betterfy autoplay never enters Spotify's explicit queue.
     */

    // We're on the final known song.
    // Prepare recommendations in memory while it plays.
    if (
      !state.paused &&
      repeatMode === "off" &&
      currentTrack &&
      nextTracks.length === 0
    ) {
      void prepareAutoplay(currentTrack);
    }

    /*
     * If the context has now completely ended,
     * start our locally prepared recommendations.
     */
    if (
      state.paused &&
      repeatMode === "off" &&
      currentTrack &&
      nextTracks.length === 0
    ) {
      void startPreparedAutoplayIfFinished();
    }

    // -------------------------
    // Playback progress
    // -------------------------

    currentPosition = state.position;
    currentDuration = state.duration;
    isCurrentlyPlaying = !state.paused;

    updateProgressUI();

    // -------------------------
    // Current track
    // -------------------------

    const track = state.track_window.current_track;

    if (track) {
      const playerBar = document.querySelector("#player-bar");

      const title = document.querySelector("#player-title");

      const artist = document.querySelector("#player-artist");

      const art = document.querySelector("#player-art");

      playerBar.removeAttribute("hidden");

      title.textContent = track.name;

      artist.textContent = track.artists
        .map((artist) => artist.name)
        .join(", ");

      const artUrl = getSmallestSpotifyImage(track.album?.images ?? []);

      if (art.getAttribute("src") !== artUrl) {
        art.src = artUrl;
      }
    }

    // -------------------------
    // Play / Pause button
    // -------------------------

    const playPauseButton = document.querySelector("#play-pause-button");

    if (playPauseButton) {
      playPauseButton.textContent = state.paused ? "▶" : "⏸";
    }
  });

  player.addListener("not_ready", ({ device_id }) => {
    /*
     * An old disconnected SDK player can
     * still emit this event. Ignore it.
     */
    if (spotifyPlayer !== player) {
      console.log(
        "Ignoring not_ready event from old Spotify player:",
        device_id,
      );

      return;
    }

    console.error("Spotify device went offline:", device_id);

    if (spotifyDeviceId === device_id) {
      spotifyDeviceId = null;
      spotifyDeviceReady = false;
      spotifyDeviceSetupPromise = null;
    }

    const status = document.querySelector("#status");

    if (status) {
      status.textContent = "Spotify playback device disconnected.";
    }
  });

  player.addListener("initialization_error", ({ message }) => {
    if (spotifyPlayer !== player) {
      return;
    }

    console.error("Spotify initialization error:", message);
  });

  player.addListener("authentication_error", ({ message }) => {
    if (spotifyPlayer !== player) {
      return;
    }

    console.error("Spotify authentication error:", message);

    const status = document.querySelector("#status");

    if (status) {
      status.textContent = `Spotify authentication error: ${message}`;
    }
  });

  player.addListener("account_error", ({ message }) => {
    if (spotifyPlayer !== player) {
      return;
    }

    console.error("Spotify account error:", message);

    const status = document.querySelector("#status");

    if (status) {
      status.textContent = "Spotify Premium is required for playback.";
    }
  });

  player.addListener("playback_error", ({ message }) => {
    if (spotifyPlayer !== player) {
      return;
    }

    console.error("Spotify playback error:", message);

    const status = document.querySelector("#status");

    if (status) {
      status.textContent = `Playback error: ${message}`;
    }
  });

  player.connect().then((success) => {
    /*
     * Ignore completion from a player that
     * was logged out while connecting.
     */
    if (spotifyPlayer !== player) {
      return;
    }

    console.log("Spotify player connect result:", success);

    if (success) {
      startProgressTimer();
    }
  });
}

/* =========================
   PLAYBACK CONTROLS & STATE
========================= */

async function playTrack(trackUris, startIndex = 0) {
  clearPreparedAutoplay();
  const accessToken = await getValidSpotifyAccessToken();

  if (!accessToken) {
    throw new Error("No Spotify access token");
  }

  await ensureSpotifyDeviceReady();

  const url =
    "https://api.spotify.com/v1/me/player/play" +
    `?device_id=${encodeURIComponent(spotifyDeviceId)}`;

  const response = await fetch(url, {
    method: "PUT",

    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },

    body: JSON.stringify({
      uris: trackUris,
      offset: {
        position: startIndex,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();

    throw new Error(`Playback failed ${response.status}: ${error}`);
  }
}

async function playContext(contextUri, position = 0, shuffle = false) {
  clearPreparedAutoplay();

  const accessToken = await getValidSpotifyAccessToken();

  if (!accessToken) {
    throw new Error("No Spotify access token");
  }

  await ensureSpotifyDeviceReady();

  // Explicitly control Spotify's shuffle state.
  // This prevents a previous shuffle session from affecting
  // normal album/playlist playback.
  await setSpotifyShuffle(shuffle);

  // Keep Betterfy's local shuffle state synchronized
  // with the state we just sent to Spotify.
  shuffleEnabled = shuffle;
  updateShuffleButton();

  // Spotify does not guarantee ordering between separate
  // Player API commands. Give the shuffle command a moment
  // to take effect before starting the new context.
  await sleep(100);

  const url =
    "https://api.spotify.com/v1/me/player/play" +
    `?device_id=${encodeURIComponent(spotifyDeviceId)}`;

  const response = await fetch(url, {
    method: "PUT",

    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },

    body: JSON.stringify({
      context_uri: contextUri,

      offset: {
        position,
      },

      position_ms: 0,
    }),
  });

  if (!response.ok) {
    const error = await response.text();

    throw new Error(`Context playback failed ${response.status}: ${error}`);
  }
}

async function setSpotifyShuffle(enabled) {
  const accessToken = await getValidSpotifyAccessToken();

  if (!accessToken) {
    throw new Error("No Spotify access token");
  }

  await ensureSpotifyDeviceReady();

  const url =
    "https://api.spotify.com/v1/me/player/shuffle" +
    `?state=${enabled ? "true" : "false"}` +
    `&device_id=${encodeURIComponent(spotifyDeviceId)}`;

  const response = await fetch(url, {
    method: "PUT",

    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();

    throw new Error(`Shuffle failed ${response.status}: ${error}`);
  }
}

function updateShuffleButton() {
  const shuffleButton = document.querySelector("#shuffle-button");

  if (!shuffleButton) {
    return;
  }

  shuffleButton.classList.toggle("shuffle-active", shuffleEnabled);

  shuffleButton.title = shuffleEnabled ? "Shuffle on" : "Shuffle off";

  shuffleButton.setAttribute(
    "aria-label",
    shuffleEnabled ? "Shuffle on" : "Shuffle off",
  );

  shuffleButton.setAttribute("aria-pressed", String(shuffleEnabled));
}

async function setSpotifyRepeat(mode) {
  const accessToken = await getValidSpotifyAccessToken();

  if (!accessToken) {
    throw new Error("No Spotify access token");
  }

  await ensureSpotifyDeviceReady();

  const url =
    "https://api.spotify.com/v1/me/player/repeat" +
    `?state=${encodeURIComponent(mode)}` +
    `&device_id=${encodeURIComponent(spotifyDeviceId)}`;

  const response = await fetch(url, {
    method: "PUT",

    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();

    throw new Error(`Repeat failed ${response.status}: ${error}`);
  }

  // Spotify returns 204 before every client necessarily
  // reflects the changed playback state.
  await sleep(150);

  const playback = await getPlaybackState();

  if (playback?.repeat_state) {
    repeatMode = playback.repeat_state;
  }

  updateRepeatButton();

  console.log("Spotify repeat mode:", repeatMode);
}

function updateRepeatButton() {
  const repeatButton = document.querySelector("#repeat-button");

  if (!repeatButton) {
    return;
  }

  repeatButton.classList.remove("repeat-active", "repeat-one");

  if (repeatMode === "context") {
    repeatButton.classList.add("repeat-active");

    repeatButton.title = "Repeat playlist";
    repeatButton.setAttribute("aria-label", "Repeat playlist");
    repeatButton.setAttribute("aria-pressed", "true");

    return;
  }

  if (repeatMode === "track") {
    repeatButton.classList.add("repeat-active", "repeat-one");

    repeatButton.title = "Repeat song";
    repeatButton.setAttribute("aria-label", "Repeat song");
    repeatButton.setAttribute("aria-pressed", "true");

    return;
  }

  repeatButton.title = "Repeat off";
  repeatButton.setAttribute("aria-label", "Repeat off");
  repeatButton.setAttribute("aria-pressed", "false");
}

async function getPlaybackState() {
  const accessToken = await getValidSpotifyAccessToken();

  const response = await fetch("https://api.spotify.com/v1/me/player", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    const error = await response.text();

    throw new Error(`Playback state failed ${response.status}: ${error}`);
  }

  return response.json();
}

async function addTrackToQueue(trackUri) {
  const accessToken = await getValidSpotifyAccessToken();

  if (!accessToken) {
    throw new Error("No Spotify access token");
  }

  await ensureSpotifyDeviceReady();

  const url =
    "https://api.spotify.com/v1/me/player/queue" +
    `?uri=${encodeURIComponent(trackUri)}` +
    `&device_id=${encodeURIComponent(spotifyDeviceId)}`;

  const response = await fetch(url, {
    method: "POST",

    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();

    throw new Error(`Could not add to queue ${response.status}: ${error}`);
  }
}

async function getSpotifyQueue() {
  return spotifyFetch("/me/player/queue");
}

async function refreshQueueIfVisible() {
  const queueView = document.querySelector("#queue-view");

  if (!queueView || queueView.hasAttribute("hidden")) {
    return;
  }

  try {
    // Give Spotify a moment to update its queue
    // after the SDK reports the new track.
    await sleep(150);

    const queue = await getSpotifyQueue();

    renderQueue(queue);
  } catch (error) {
    console.error("Could not refresh queue:", error);
  }
}

function getSavedVolume() {
  const savedVolume = Number(localStorage.getItem(VOLUME_KEY));

  if (!Number.isFinite(savedVolume) || savedVolume < 0 || savedVolume > 100) {
    return 50;
  }

  return savedVolume;
}

function saveVolume(volume) {
  localStorage.setItem(VOLUME_KEY, String(volume));
}

async function setPlayerVolume(volumePercent) {
  if (!spotifyPlayer) {
    throw new Error("Spotify player is not initialized");
  }

  const normalizedVolume = volumePercent / 100;

  await spotifyPlayer.setVolume(normalizedVolume);
}

function formatTime(milliseconds) {
  if (!Number.isFinite(milliseconds)) {
    return "0:00";
  }

  const totalSeconds = Math.floor(milliseconds / 1000);

  const minutes = Math.floor(totalSeconds / 60);

  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function updateProgressUI() {
  const slider = document.querySelector("#progress-slider");

  const currentTime = document.querySelector("#current-time");

  const durationTime = document.querySelector("#duration-time");

  if (!slider || !currentTime || !durationTime) {
    return;
  }

  currentTime.textContent = formatTime(currentPosition);

  durationTime.textContent = formatTime(currentDuration);

  if (currentDuration > 0 && !isSeeking) {
    const percentage = (currentPosition / currentDuration) * 100;

    slider.value = Math.min(100, percentage);
  }
}

function startProgressTimer() {
  if (progressTimer) {
    clearInterval(progressTimer);
  }

  progressTimer = setInterval(() => {
    if (isCurrentlyPlaying && !isSeeking && currentDuration > 0) {
      currentPosition += 1000;

      if (currentPosition > currentDuration) {
        currentPosition = currentDuration;
      }

      updateProgressUI();
    }
  }, 1000);
}

async function updatePlayer() {
  try {
    const state = await getPlaybackState();

    const playerBar = document.querySelector("#player-bar");

    if (!state || !state.item) {
      playerBar.setAttribute("hidden", "");
      return;
    }

    playerBar.removeAttribute("hidden");

    const track = state.item;

    const title = document.querySelector("#player-title");

    const artist = document.querySelector("#player-artist");

    const art = document.querySelector("#player-art");

    const playPause = document.querySelector("#play-pause-button");

    title.textContent = track.name;

    artist.textContent = track.artists.map((artist) => artist.name).join(", ");

    const artUrl = getSmallestSpotifyImage(track.album?.images ?? []);

    if (art.getAttribute("src") !== artUrl) {
      art.src = artUrl;
    }

    playPause.textContent = state.is_playing ? "⏸" : "▶";
  } catch (error) {
    console.error("Could not update player:", error);
  }
}

/* =========================
   AUTOPLAY & RECOMMENDATIONS
========================= */

function spotifySdkTrackToApiTrack(track) {
  if (!track) {
    return null;
  }

  return {
    id: track.id,
    uri: track.uri,
    name: track.name,
    artists: (track.artists ?? []).map((artist) => ({
      id: artist.id,
      name: artist.name,
      uri: artist.uri,
    })),
  };
}

function clearPreparedAutoplay() {
  preparedAutoplayUris = [];
  preparedAutoplaySeedId = null;
  autoplayPrepareInProgress = false;
}

async function prepareAutoplay(currentTrack) {
  if (!autoplayEnabled || autoplayPrepareInProgress || !currentTrack?.name) {
    return;
  }

  const trackId =
    currentTrack.id ??
    currentTrack.uri ??
    `${currentTrack.name}:${currentTrack.artists?.[0]?.name ?? ""}`;

  // Already prepared recommendations for this ending track.
  if (preparedAutoplaySeedId === trackId && preparedAutoplayUris.length > 0) {
    return;
  }

  autoplayPrepareInProgress = true;

  try {
    console.log(
      "Autoplay: preparing recommendations locally from",
      currentTrack.name,
    );

    const seedTrack = spotifySdkTrackToApiTrack(currentTrack);

    const recommendations = await getSpotifySimilarTracks(seedTrack);

    const uris = recommendations
      .map((track) => track.uri)
      .filter(Boolean)
      .slice(0, AUTOPLAY_TRACK_COUNT);

    if (uris.length === 0) {
      preparedAutoplayUris = [];
      preparedAutoplaySeedId = null;

      return;
    }

    /*
     * CRITICAL:
     *
     * Do NOT call addTrackToQueue() here.
     *
     * These stay entirely inside Betterfy until Spotify's
     * current playlist/album/explicit queue has finished.
     */
    preparedAutoplayUris = uris;
    preparedAutoplaySeedId = trackId;

    console.log(`Autoplay: prepared ${uris.length} local recommendations`);
  } catch (error) {
    preparedAutoplayUris = [];
    preparedAutoplaySeedId = null;

    console.error("Autoplay preparation failed:", error);
  } finally {
    autoplayPrepareInProgress = false;
  }
}

async function startPreparedAutoplayIfFinished() {
  if (
    !autoplayEnabled ||
    autoplayStartInProgress ||
    preparedAutoplayUris.length === 0 ||
    !spotifyPlayer
  ) {
    return;
  }

  autoplayStartInProgress = true;

  try {
    const state = await spotifyPlayer.getCurrentState();

    if (!state) {
      return;
    }

    const currentTrack = state.track_window.current_track;

    if (!currentTrack) {
      return;
    }

    const currentTrackId =
      currentTrack.id ??
      currentTrack.uri ??
      `${currentTrack.name}:${currentTrack.artists?.[0]?.name ?? ""}`;

    /*
     * These recommendations belong specifically to the
     * track that was at the end of the previous context.
     */
    if (currentTrackId !== preparedAutoplaySeedId) {
      return;
    }

    const nextTracks = state.track_window.next_tracks ?? [];

    /*
     * Something else still needs to play.
     *
     * This includes:
     * - playlist tracks
     * - album tracks
     * - songs explicitly added using "+ Queue"
     *
     * All of those have priority over autoplay.
     */
    if (nextTracks.length > 0) {
      return;
    }

    /*
     * Don't interrupt the ending song.
     *
     * Spotify should be paused once the playback context
     * has actually exhausted itself.
     */
    const atEnd =
      state.paused &&
      state.duration > 0 &&
      state.position >= state.duration - 1000;

    if (!atEnd) {
      return;
    }

    const uris = [...preparedAutoplayUris];

    preparedAutoplayUris = [];
    preparedAutoplaySeedId = null;

    console.log("Autoplay: context finished; starting recommendations");

    /*
     * Start a NEW playback context instead of inserting the
     * recommendations into Spotify's explicit queue.
     */
    await playTrack(uris, 0);
  } catch (error) {
    console.error("Could not start prepared autoplay:", error);
  } finally {
    autoplayStartInProgress = false;
  }
}

async function searchSpotify(
  query,
  types = "track",
  limit = 10,
  signal = undefined,
) {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    return {
      tracks: {
        items: [],
      },

      artists: {
        items: [],
      },
    };
  }

  const encodedQuery = encodeURIComponent(trimmedQuery);

  const encodedTypes = encodeURIComponent(types);

  return spotifyFetch(
    `/search?q=${encodedQuery}&type=${encodedTypes}&limit=${limit}`,
    { signal },
  );
}

async function findSpotifyTrack(artist, trackName) {
  const query = `${trackName} ${artist}`;

  const results = await searchSpotify(query);

  const tracks = results.tracks?.items ?? [];

  if (tracks.length === 0) {
    return null;
  }

  const wantedArtist = normalizeText(artist);

  const wantedTrack = normalizeText(trackName);

  let bestTrack = null;

  let bestScore = -1;

  for (const track of tracks) {
    const spotifyTitle = normalizeText(track.name);

    const spotifyArtists =
      track.artists?.map((item) => normalizeText(item.name)) ?? [];

    let score = 0;

    if (spotifyTitle === wantedTrack) {
      score += 5;
    } else if (
      spotifyTitle.includes(wantedTrack) ||
      wantedTrack.includes(spotifyTitle)
    ) {
      score += 3;
    }

    if (spotifyArtists.includes(wantedArtist)) {
      score += 5;
    } else if (
      spotifyArtists.some(
        (name) => name.includes(wantedArtist) || wantedArtist.includes(name),
      )
    ) {
      score += 3;
    }

    const lowerTitle = track.name.toLowerCase();

    if (
      lowerTitle.includes("live") ||
      lowerTitle.includes("remix") ||
      lowerTitle.includes("karaoke")
    ) {
      score -= 2;
    }

    if (score > bestScore) {
      bestScore = score;

      bestTrack = track;
    }
  }

  return bestTrack;
}

async function getSimilarTracks(artist, trackName, limit = 20) {
  const params = new URLSearchParams({
    method: "track.getsimilar",
    artist,
    track: trackName,
    api_key: LASTFM_API_KEY,
    format: "json",
    limit: String(limit),
    autocorrect: "1",
  });

  const response = await fetch(
    `https://ws.audioscrobbler.com/2.0/?${params.toString()}`,
  );

  if (!response.ok) {
    throw new Error(`Last.fm request failed: ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`Last.fm error ${data.error}: ${data.message}`);
  }

  return data.similartracks?.track ?? [];
}

function cleanRecommendations(seedTrack, tracks) {
  const seen = new Set();

  return tracks
    .filter((track) => {
      if (!track?.id) {
        return false;
      }

      // Don't recommend the song we're already using
      if (track.id === seedTrack.id) {
        return false;
      }

      // Remove duplicates
      if (seen.has(track.id)) {
        return false;
      }

      seen.add(track.id);

      return true;
    })
    .sort((a, b) => (b.lastFmMatch ?? 0) - (a.lastFmMatch ?? 0));
}

async function getSpotifySimilarTracks(track) {
  const artist = track.artists?.[0]?.name;

  console.log("Seed artist:", artist);

  console.log("Seed track name:", track.name);

  if (!artist) {
    return [];
  }

  const lastFmTracks = await getSimilarTracks(artist, track.name, 10);

  console.debug("Last.fm recommendation count:", lastFmTracks.length);

  const results = [];

  for (const similarTrack of lastFmTracks) {
    console.log(
      "Looking up on Spotify:",
      similarTrack.artist.name,
      "-",
      similarTrack.name,
    );

    const spotifyTrack = await findSpotifyTrack(
      similarTrack.artist.name,
      similarTrack.name,
    );

    console.debug("Spotify lookup:", spotifyTrack?.id ?? "not found");

    if (!spotifyTrack) {
      continue;
    }

    results.push({
      ...spotifyTrack,
      lastFmMatch: Number(similarTrack.match),
    });
  }

  const cleanedResults = cleanRecommendations(track, results);

  console.debug("Final recommendation count:", cleanedResults.length);

  return cleanedResults;
}

function clearSimilarResults() {
  const section = document.querySelector("#similar-section");

  const container = document.querySelector("#similar-tracks");

  if (container) {
    container.replaceChildren();
  }

  if (section) {
    section.setAttribute("hidden", "");
  }
}

function renderSimilarTracks(seedTrack, tracks) {
  const section = document.querySelector("#similar-section");

  const title = document.querySelector("#similar-title");

  const status = document.querySelector("#similar-status");

  const container = document.querySelector("#similar-tracks");

  container.replaceChildren();

  title.textContent = `Similar to ${seedTrack.name}`;

  if (tracks.length === 0) {
    status.textContent = "No similar songs found.";

    section.removeAttribute("hidden");

    return;
  }

  status.textContent = `${tracks.length} recommendations`;

  const trackUris = tracks.map((track) => track.uri);

  tracks.forEach((track, index) => {
    const trackElement = document.createElement("div");

    trackElement.className = "track-card";

    const image = getSmallestSpotifyImage(track.album?.images);

    const artists =
      track.artists?.map((artist) => artist.name).join(", ") ?? "";

    const match = Math.round(track.lastFmMatch * 100);

    trackElement.innerHTML = `
      <span class="track-number">
        ${index + 1}
      </span>

      <img
        class="track-image"
        src="${image}"
        alt=""
        loading="lazy"
        decoding="async"
      />

      <div class="track-info">
        <span class="track-name">
          ${track.name}
        </span>

        <span class="track-artist">
          ${artists}
        </span>
      </div>

      <span class="similarity-score">
        ${match}% match
      </span>
    `;

    trackElement.addEventListener("click", async () => {
      try {
        await playTrack(trackUris, index);
      } catch (error) {
        console.error("Similar track playback error:", error);
      }
    });

    container.appendChild(trackElement);
  });

  section.removeAttribute("hidden");
}

/* =========================
   PLAYLIST DATA & ACTIONS
========================= */

async function getUserPlaylists(limit = 5, offset = 0) {
  return spotifyFetch(`/me/playlists?limit=${limit}&offset=${offset}`);
}

function getRecentPlaylistIds() {
  try {
    const stored = JSON.parse(
      localStorage.getItem(RECENT_PLAYLISTS_KEY) ?? "[]",
    );

    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function markPlaylistOpened(playlistId) {
  const recentIds = getRecentPlaylistIds();

  const updatedIds = [
    playlistId,
    ...recentIds.filter((id) => id !== playlistId),
  ].slice(0, MAX_RECENT_PLAYLISTS);

  localStorage.setItem(RECENT_PLAYLISTS_KEY, JSON.stringify(updatedIds));
}

async function createSpotifyPlaylist(name, description, isPrivate) {
  const accessToken = await getValidSpotifyAccessToken();

  if (!accessToken) {
    throw new Error("No Spotify access token");
  }

  const response = await fetch("https://api.spotify.com/v1/me/playlists", {
    method: "POST",

    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },

    body: JSON.stringify({
      name: name,
      description: description,
      public: !isPrivate,
    }),
  });

  if (!response.ok) {
    const error = await response.text();

    throw new Error(`Playlist creation failed ${response.status}: ${error}`);
  }

  return response.json();
}

async function refreshPlaylists() {
  await loadHomePlaylists();

  const playlistsView = document.querySelector("#playlists-view");

  if (playlistsView && !playlistsView.hasAttribute("hidden")) {
    await openPlaylistsPage();
  }
}

async function getPlaylistItems(playlistId) {
  const allItems = [];

  let endpoint = `/playlists/${encodeURIComponent(playlistId)}/items?limit=50`;

  while (endpoint) {
    const data = await spotifyFetch(endpoint);

    for (const item of data.items ?? []) {
      const compactItem = compactPlaylistItem(item);

      if (compactItem) {
        allItems.push(compactItem);
      }
    }

    if (data.next) {
      const nextUrl = new URL(data.next);

      endpoint = nextUrl.pathname.replace("/v1", "") + nextUrl.search;
    } else {
      endpoint = null;
    }
  }

  return {
    items: allItems,
  };
}

function compactPlaylistItem(playlistItem) {
  const track = playlistItem?.item;

  if (!track || track.type !== "track") {
    return null;
  }

  return {
    uri: track.uri ?? "",
    name: track.name ?? "",
    artists: track.artists?.map((artist) => artist.name) ?? [],
    image: getSmallestSpotifyImage(track.album?.images ?? []),
  };
}

async function loadHomePlaylists() {
  const recentIds = getRecentPlaylistIds();

  const homePlaylists = [];

  /*
   * Fetch recently opened playlists individually.
   *
   * We need at most five objects in memory.
   */
  for (const playlistId of recentIds.slice(0, 5)) {
    try {
      const playlist = await spotifyFetch(
        `/playlists/${encodeURIComponent(playlistId)}`,
      );

      if (playlist) {
        homePlaylists.push(playlist);
      }
    } catch (error) {
      console.warn("Could not load recent playlist:", playlistId, error);
    }
  }

  /*
   * If the user hasn't opened five playlists yet,
   * fill the remaining slots from Spotify.
   */
  if (homePlaylists.length < 5) {
    const data = await getUserPlaylists(5);

    const alreadyUsed = new Set(homePlaylists.map((playlist) => playlist.id));

    for (const playlist of data.items ?? []) {
      if (alreadyUsed.has(playlist.id)) {
        continue;
      }

      homePlaylists.push(playlist);

      if (homePlaylists.length === 5) {
        break;
      }
    }
  }

  renderPlaylists(homePlaylists.slice(0, 5), "playlists");
}

async function loadNextPlaylistPage() {
  if (allPlaylistsLoading || allPlaylistsFinished) {
    return;
  }

  allPlaylistsLoading = true;

  const status = document.querySelector("#playlists-view-status");

  try {
    status.textContent = "Loading playlists...";

    const data = await getUserPlaylists(PLAYLIST_PAGE_SIZE, allPlaylistsOffset);

    const recentIds = new Set(getRecentPlaylistIds());

    /*
     * Recently opened playlists are inserted
     * separately, so don't duplicate them here.
     */
    const playlists = (data.items ?? []).filter(
      (playlist) => !recentIds.has(playlist.id),
    );

    renderPlaylists(playlists, "all-playlists", true);

    allPlaylistsOffset += data.items?.length ?? 0;

    if (!data.next || (data.items?.length ?? 0) === 0) {
      allPlaylistsFinished = true;

      status.textContent = "";
    } else {
      status.textContent = "";
    }
  } catch (error) {
    console.error("Could not load playlists:", error);

    status.textContent = "Could not load playlists.";
  } finally {
    allPlaylistsLoading = false;
  }
}

async function loadRecentPlaylistsForLibrary() {
  const container = document.querySelector("#all-playlists");

  container.replaceChildren();

  const recentIds = getRecentPlaylistIds();

  for (const playlistId of recentIds) {
    try {
      const playlist = await spotifyFetch(
        `/playlists/${encodeURIComponent(playlistId)}`,
      );

      renderPlaylists([playlist], "all-playlists", true);
    } catch (error) {
      console.warn("Skipping unavailable recent playlist:", playlistId);
    }
  }
}

async function openPlaylistsPage() {
  showPlaylistsView();

  const container = document.querySelector("#all-playlists");

  if (!container) {
    return;
  }

  container.replaceChildren();

  allPlaylistsOffset = 0;
  allPlaylistsLoading = false;
  allPlaylistsFinished = false;

  await loadRecentPlaylistsForLibrary();

  await loadNextPlaylistPage();
}

async function openPlaylist(playlist, returnView = "home") {
  if (!playlist?.id) {
    return;
  }

  playlistReturnView = returnView;

  markPlaylistOpened(playlist.id);

  try {
    const data = await getPlaylistItems(playlist.id);

    renderPlaylistTracks(playlist, data.items ?? []);

    showPlaylistView();
  } catch (error) {
    console.error("Could not load playlist:", error);
  }
}

/* =========================
   PLAYLIST RENDERING
========================= */

function renderPlaylists(playlists, containerId = "playlists", append = false) {
  const container = document.querySelector(`#${containerId}`);

  if (!container) {
    return;
  }

  if (!append) {
    container.replaceChildren();
  }

  const fragment = document.createDocumentFragment();

  playlists.forEach((playlist) => {
    if (!playlist?.id) {
      return;
    }

    const playlistElement = document.createElement("div");

    playlistElement.className = "playlist-card";

    playlistElement.dataset.playlistId = playlist.id;

    const image = getMediumSpotifyImage(playlist.images);

    playlistElement.innerHTML = `
      <img
        class="playlist-image"
        src="${image}"
        alt=""
        loading="lazy"
        decoding="async"
      />

      <div class="playlist-info">
        <span class="playlist-name"></span>

        <span class="playlist-owner"></span>
      </div>
    `;

    const nameElement = playlistElement.querySelector(".playlist-name");

    const ownerElement = playlistElement.querySelector(".playlist-owner");

    nameElement.textContent = playlist.name ?? "Playlist";

    ownerElement.textContent = playlist.owner?.display_name ?? "";

    playlistElement.dataset.playlistId = playlist.id;

    playlistElement.dataset.playlistName = playlist.name ?? "Playlist";

    playlistElement.dataset.playlistUri = playlist.uri ?? "";

    fragment.appendChild(playlistElement);
  });

  container.appendChild(fragment);
}

function playlistFromCard(card) {
  return {
    id: card.dataset.playlistId,
    name: card.dataset.playlistName ?? "Playlist",
    uri: card.dataset.playlistUri ?? "",
  };
}

function renderPlaylistTracks(playlist, items) {
  const title = document.querySelector("#playlist-title");

  const container = document.querySelector("#playlist-tracks");

  title.textContent = playlist.name;

  container.replaceChildren();

  currentPlaylist = playlist;

  currentPlaylistItems = items;

  renderedPlaylistCount = 0;

  renderNextPlaylistBatch();
}

function renderNextPlaylistBatch() {
  const container = document.querySelector("#playlist-tracks");

  if (!currentPlaylist || currentPlaylistItems.length === 0) {
    return;
  }

  const startIndex = renderedPlaylistCount;

  const endIndex = Math.min(
    startIndex + PLAYLIST_RENDER_BATCH_SIZE,
    currentPlaylistItems.length,
  );

  const fragment = document.createDocumentFragment();

  for (let index = startIndex; index < endIndex; index++) {
    const track = currentPlaylistItems[index];

    if (!track?.uri) {
      continue;
    }

    const trackElement = document.createElement("div");

    trackElement.className = "track-card";

    const image = track.image;

    const artists = track.artists?.join(", ") ?? "";

    trackElement.innerHTML = `
      <span class="track-number">
        ${index + 1}
      </span>

      <img
        class="track-image"
        src="${image}"
        alt="${track.name}"
        loading="lazy"
        decoding="async"
      />

      <div class="track-info">
        <span class="track-name">
          ${track.name}
        </span>

        <span class="track-artist">
          ${artists}
        </span>
      </div>
    `;

    trackElement.addEventListener("click", async () => {
      try {
        await playContext(currentPlaylist.uri, index, false);
      } catch (error) {
        console.error("Playlist playback error:", error);
      }
    });

    fragment.appendChild(trackElement);
  }

  container.appendChild(fragment);

  renderedPlaylistCount = endIndex;
}

/* =========================
   ARTISTS & RELEASES
========================= */

async function getArtistTopTracks(artist) {
  const params = new URLSearchParams({
    method: "artist.gettoptracks",
    artist: artist.name,
    api_key: LASTFM_API_KEY,
    format: "json",
    limit: "5",
    autocorrect: "1",
  });

  const response = await fetch(
    `https://ws.audioscrobbler.com/2.0/?${params.toString()}`,
  );

  if (!response.ok) {
    throw new Error(`Last.fm artist top tracks failed: ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`Last.fm error ${data.error}: ${data.message}`);
  }

  const lastFmTracks = data.toptracks?.track ?? [];

  const spotifyTracks = [];

  for (const lastFmTrack of lastFmTracks.slice(0, 5)) {
    const spotifyTrack = await findSpotifyTrack(artist.name, lastFmTrack.name);

    if (spotifyTrack) {
      spotifyTracks.push(spotifyTrack);
    }

    if (spotifyTracks.length === 5) {
      break;
    }
  }

  return spotifyTracks;
}

async function getArtistAlbums(artistId, offset = 0, limit = 10) {
  return spotifyFetch(
    `/artists/${encodeURIComponent(artistId)}/albums` +
      `?include_groups=album,single&limit=${limit}&offset=${offset}`,
  );
}

async function getReleaseTracks(releaseId) {
  const tracks = [];

  let endpoint = `/albums/${encodeURIComponent(releaseId)}/tracks?limit=50`;

  while (endpoint) {
    const data = await spotifyFetch(endpoint);

    tracks.push(...(data.items ?? []));

    if (data.next) {
      const nextUrl = new URL(data.next);

      endpoint = nextUrl.pathname.replace("/v1", "") + nextUrl.search;
    } else {
      endpoint = null;
    }
  }

  return tracks;
}

async function loadNextDiscographyPage() {
  if (
    !currentDiscographyArtist?.id ||
    discographyLoading ||
    discographyFinished
  ) {
    return;
  }

  const container = document.querySelector("#artist-discography-releases");

  const status = document.querySelector("#artist-discography-status");

  discographyLoading = true;

  try {
    status.textContent = "Loading releases...";

    const data = await getArtistAlbums(
      currentDiscographyArtist.id,
      discographyOffset,
      DISCOGRAPHY_PAGE_SIZE,
    );

    const releases = data.items ?? [];

    renderArtistAlbums(
      releases,
      true,
      "artist-discography-releases",
      "discography",
    );

    discographyOffset += releases.length;

    if (!data.next || releases.length === 0) {
      discographyFinished = true;

      status.textContent =
        container.children.length === 0 ? "No releases found." : "";
    } else {
      status.textContent = "";
    }
  } catch (error) {
    console.error("Could not load artist discography:", error);

    status.textContent = "Could not load discography.";
  } finally {
    discographyLoading = false;
  }
}

async function openArtistDiscography(artist) {
  if (!artist?.id) {
    return;
  }

  currentDiscographyArtist = artist;

  discographyOffset = 0;
  discographyLoading = false;
  discographyFinished = false;

  const title = document.querySelector("#artist-discography-title");

  const status = document.querySelector("#artist-discography-status");

  const container = document.querySelector("#artist-discography-releases");

  title.textContent = `${artist.name ?? "Artist"} discography`;

  status.textContent = "";

  container.replaceChildren();

  showArtistDiscographyView();

  await loadNextDiscographyPage();
}

function clearArtistDiscographyView() {
  const container = document.querySelector("#artist-discography-releases");

  const status = document.querySelector("#artist-discography-status");

  const title = document.querySelector("#artist-discography-title");

  if (container) {
    container.replaceChildren();
  }

  if (status) {
    status.textContent = "";
  }

  if (title) {
    title.textContent = "Discography";
  }

  currentDiscographyArtist = null;

  discographyOffset = 0;
  discographyLoading = false;
  discographyFinished = false;
}

async function openArtist(artist) {
  if (!artist?.id) {
    return;
  }

  clearArtistView();

  const requestId = ++artistRequestId;

  showArtistView();

  const name = document.querySelector("#artist-name");

  const image = document.querySelector("#artist-image");

  const status = document.querySelector("#artist-status");

  name.textContent = artist.name ?? "Artist";

  const profileImage = getMediumSpotifyImage(artist.images);

  if (profileImage) {
    image.src = profileImage;

    image.alt = `${artist.name} profile`;
  }

  status.textContent = "Loading artist...";

  const [topTracksResult, albumsResult] = await Promise.allSettled([
    getArtistTopTracks(artist),
    getArtistAlbums(artist.id, 0, 5),
  ]);

  if (requestId !== artistRequestId) {
    return;
  }

  if (topTracksResult.status === "fulfilled") {
    renderArtistTopTracks(topTracksResult.value);
  } else {
    console.error("Could not load artist top tracks:", topTracksResult.reason);
  }

  if (albumsResult.status === "fulfilled") {
    const albumData = albumsResult.value;

    renderArtistAlbums(albumData.items ?? [], false);

    setupArtistDiscographyButton(artist, Boolean(albumData.next));
  } else {
    console.error("Could not load artist albums:", albumsResult.reason);
  }

  if (
    topTracksResult.status === "rejected" &&
    albumsResult.status === "rejected"
  ) {
    status.textContent = "Could not load artist.";
  } else if (topTracksResult.status === "rejected") {
    status.textContent = "Could not load top tracks.";
  } else if (albumsResult.status === "rejected") {
    status.textContent = "Could not load albums.";
  } else {
    status.textContent = "";
  }
}

function clearArtistView() {
  artistRequestId++;

  const topTracks = document.querySelector("#artist-top-tracks");

  const albums = document.querySelector("#artist-albums");

  const image = document.querySelector("#artist-image");

  const name = document.querySelector("#artist-name");

  const status = document.querySelector("#artist-status");

  const loadMore = document.querySelector("#artist-load-more");

  topTracks.innerHTML = "";

  albums.innerHTML = "";

  image.src = "";

  image.alt = "";

  name.textContent = "Artist";

  status.textContent = "";

  loadMore.setAttribute("hidden", "");

  loadMore.onclick = null;

  clearReleaseView();
}

function renderArtistTopTracks(tracks) {
  const container = document.querySelector("#artist-top-tracks");

  container.replaceChildren();

  const topFive = tracks.slice(0, 5);

  if (topFive.length === 0) {
    const empty = document.createElement("p");

    empty.className = "section-status";

    empty.textContent = "No top tracks found.";

    container.appendChild(empty);

    return;
  }

  const trackUris = topFive.map((track) => track.uri).filter(Boolean);

  const fragment = document.createDocumentFragment();

  topFive.forEach((track, index) => {
    const row = document.createElement("div");

    row.className = "track-card";

    const image = getSmallestSpotifyImage(track.album?.images);

    const artists =
      track.artists?.map((artist) => artist.name).join(", ") ?? "";

    row.innerHTML = `
      <span class="track-number">${index + 1}</span>

      <img
        class="track-image"
        src="${image}"
        alt=""
        loading="lazy"
        decoding="async"
      />

      <div class="track-info">
        <span class="track-name"></span>
        <span class="track-artist"></span>
      </div>

      <button
        class="search-play-button"
        type="button"
        aria-label="Play"
      >
        ▶
      </button>
    `;

    row.querySelector(".track-name").textContent = track.name ?? "Track";

    row.querySelector(".track-artist").textContent = artists;

    row.addEventListener("click", () => {
      void playTrack(trackUris, index);
    });

    row
      .querySelector(".search-play-button")
      .addEventListener("click", (event) => {
        event.stopPropagation();

        void playTrack(trackUris, index);
      });

    fragment.appendChild(row);
  });

  container.appendChild(fragment);
}

function getArtistReleaseType(release) {
  if (release.album_type === "album") {
    return "Album";
  }

  if (release.album_type === "single") {
    /*
     * Spotify doesn't expose "EP" as a separate album_type.
     * EPs are returned in the "single" category.
     *
     * Use track count as a lightweight presentation heuristic:
     * 1-3 tracks = Single
     * 4+ tracks = EP
     */
    if ((release.total_tracks ?? 0) >= 4) {
      return "EP";
    }

    return "Single";
  }

  return "Release";
}

function formatArtistReleaseDate(release) {
  const releaseDate = release.release_date;

  if (!releaseDate) {
    return "";
  }

  const precision = release.release_date_precision;

  if (precision === "day") {
    const [year, month, day] = releaseDate.split("-");

    return `${month}/${day}/${year}`;
  }

  if (precision === "month") {
    const [year, month] = releaseDate.split("-");

    return `${month}/${year}`;
  }

  return releaseDate;
}

function clearReleaseView() {
  const title = document.querySelector("#release-title");

  const type = document.querySelector("#release-type-label");

  const status = document.querySelector("#release-status");

  const tracks = document.querySelector("#release-tracks");

  const shuffleButton = document.querySelector("#shuffle-release");

  title.textContent = "Release";

  type.textContent = "RELEASE";

  status.textContent = "";

  tracks.innerHTML = "";

  if (shuffleButton) {
    shuffleButton.onclick = null;
  }
}

function renderReleaseTracks(release, tracks) {
  const container = document.querySelector("#release-tracks");

  container.replaceChildren();

  if (!tracks.length) {
    const empty = document.createElement("p");

    empty.className = "section-status";

    empty.textContent = "No songs found.";

    container.appendChild(empty);

    return;
  }

  const fragment = document.createDocumentFragment();

  tracks.forEach((track, index) => {
    if (!track?.uri) {
      return;
    }

    const row = document.createElement("div");

    row.className = "track-card";

    const artists =
      track.artists?.map((artist) => artist.name).join(", ") ?? "";

    row.innerHTML = `
      <span class="track-number">
        ${index + 1}
      </span>

      <img
        class="track-image"
        src="${getSmallestSpotifyImage(release.images)}"
        alt=""
        loading="lazy"
        decoding="async"
      />

      <div class="track-info">
        <span class="track-name"></span>
        <span class="track-artist"></span>
      </div>

      <button
        class="search-play-button"
        type="button"
        aria-label="Play"
      >
        ▶
      </button>
    `;

    row.querySelector(".track-name").textContent = track.name ?? "Track";

    row.querySelector(".track-artist").textContent = artists;

    row.addEventListener("click", async () => {
      try {
        await playContext(release.uri, index, false);
      } catch (error) {
        console.error("Release playback error:", error);
      }
    });

    row
      .querySelector(".search-play-button")
      .addEventListener("click", async (event) => {
        event.stopPropagation();

        try {
          await playContext(release.uri, index, false);
        } catch (error) {
          console.error("Release playback error:", error);
        }
      });

    fragment.appendChild(row);
  });

  container.appendChild(fragment);

  const shuffleButton = document.querySelector("#shuffle-release");

  if (shuffleButton) {
    shuffleButton.onclick = async () => {
      if (!release.uri || tracks.length === 0) {
        return;
      }

      const startIndex = Math.floor(Math.random() * tracks.length);

      try {
        await playContext(release.uri, startIndex, true);
      } catch (error) {
        console.error("Release shuffle error:", error);
      }
    };
  }
}

async function openRelease(release, returnView = "artist") {
  if (!release?.id) {
    return;
  }

  releaseReturnView = returnView;

  clearReleaseView();

  const title = document.querySelector("#release-title");

  const type = document.querySelector("#release-type-label");

  const status = document.querySelector("#release-status");

  title.textContent = release.name ?? "Release";

  type.textContent = getArtistReleaseType(release).toUpperCase();

  status.textContent = "Loading songs...";

  showReleaseView();

  try {
    const tracks = await getReleaseTracks(release.id);

    renderReleaseTracks(release, tracks);

    status.textContent = `${tracks.length} ${
      tracks.length === 1 ? "song" : "songs"
    }`;
  } catch (error) {
    console.error("Could not load release tracks:", error);

    status.textContent = "Could not load songs.";
  }
}

function renderArtistAlbums(
  albums,
  append = false,
  containerId = "artist-albums",
  releaseReturnView = "artist",
) {
  const container = document.querySelector(`#${containerId}`);

  if (!container) {
    return;
  }

  if (!append) {
    container.replaceChildren();
  }

  /*
   * Copy before sorting so we don't mutate Spotify's
   * response array.
   *
   * ISO Spotify dates sort correctly as strings:
   * YYYY-MM-DD
   * YYYY-MM
   * YYYY
   */
  const sortedReleases = [...albums].sort((a, b) => {
    return String(b.release_date ?? "").localeCompare(
      String(a.release_date ?? ""),
    );
  });

  const fragment = document.createDocumentFragment();

  for (const release of sortedReleases) {
    if (!release?.id) {
      continue;
    }

    const card = document.createElement("div");

    card.className = "playlist-card";

    const image = getMediumSpotifyImage(release.images);

    const releaseType = getArtistReleaseType(release);

    const releaseDate = formatArtistReleaseDate(release);

    card.innerHTML = `
      <img
        class="playlist-image"
        src="${image}"
        alt=""
        loading="lazy"
        decoding="async"
      />

      <div class="playlist-info">
        <span class="playlist-name"></span>
        <span class="playlist-owner"></span>
      </div>
    `;

    card.querySelector(".playlist-name").textContent =
      release.name ?? "Release";

    card.querySelector(".playlist-owner").textContent =
      `${releaseDate} · ${releaseType}`;

    card.addEventListener("click", () => {
      void openRelease(release, releaseReturnView);
    });

    fragment.appendChild(card);
  }

  container.appendChild(fragment);
}

function setupArtistDiscographyButton(artist, hasMoreReleases) {
  const button = document.querySelector("#artist-load-more");

  if (!artist?.id || !hasMoreReleases) {
    button.setAttribute("hidden", "");

    button.onclick = null;

    return;
  }

  button.removeAttribute("hidden");

  button.disabled = false;

  button.textContent = "View Discography";

  button.onclick = () => {
    void openArtistDiscography(artist);
  };
}

/* =========================
   SEARCH RENDERING
========================= */

function renderArtistSearchResults(artists) {
  const section = document.querySelector("#artist-results-section");

  const container = document.querySelector("#artist-search-results");

  container.replaceChildren();

  if (!artists.length) {
    section.setAttribute("hidden", "");

    return;
  }

  const fragment = document.createDocumentFragment();

  for (const artist of artists) {
    if (!artist?.id) {
      continue;
    }

    const card = document.createElement("button");

    card.className = "artist-search-card";

    card.type = "button";

    const image = getSmallestSpotifyImage(artist.images);

    card.innerHTML = `
      <img
        class="artist-search-image"
        src="${image}"
        alt=""
        loading="lazy"
        decoding="async"
      />

      <span class="artist-search-name"></span>
    `;

    card.querySelector(".artist-search-name").textContent =
      artist.name ?? "Artist";

    card.addEventListener("click", () => {
      void openArtist(artist);
    });

    fragment.appendChild(card);
  }

  container.appendChild(fragment);

  section.removeAttribute("hidden");
}

function clearArtistSearchResults() {
  const container = document.querySelector("#artist-search-results");

  const section = document.querySelector("#artist-results-section");

  if (container) {
    container.replaceChildren();
  }

  if (section) {
    section.setAttribute("hidden", "");
  }
}

function renderSearchResults(tracks) {
  const container = document.querySelector("#search-results");

  container.replaceChildren();

  if (tracks.length === 0) {
    container.replaceChildren();

    return;
  }

  const trackUris = tracks.map((track) => track.uri);

  tracks.forEach((track, index) => {
    const trackElement = document.createElement("div");

    trackElement.className = "track-card";

    const image = getSmallestSpotifyImage(track.album?.images);

    const artists = track.artists.map((artist) => artist.name).join(", ");

    trackElement.innerHTML = `
      <span class="track-number">
        ${index + 1}
      </span>

      <img
        class="track-image"
        src="${image}"
        alt="${track.name}"
        loading="lazy"
        decoding="async"
      />

      <div class="track-info">
        <span class="track-name">
          ${track.name}
        </span>

        <span class="track-artist">
          ${artists}
        </span>
      </div>

      <button
        class="similar-button"
        type="button"
      >
        ✨ Similar
      </button>

      <button
        class="queue-add-button"
        type="button"
        title="Add to queue"
      >
        + Queue
      </button>

      <button
        class="search-play-button"
        type="button"
        aria-label="Play ${track.name}"
      >
        ▶
      </button>
    `;

    const playButton = trackElement.querySelector(".search-play-button");

    const similarButton = trackElement.querySelector(".similar-button");

    const queueAddButton = trackElement.querySelector(".queue-add-button");

    similarButton.addEventListener("click", async (event) => {
      event.stopPropagation();

      try {
        similarButton.disabled = true;

        similarButton.textContent = "Finding...";

        console.log("SIMILAR BUTTON CLICKED");

        const recommendations = await getSpotifySimilarTracks(track);

        console.log("Recommendation count:", recommendations.length);

        renderSimilarTracks(track, recommendations);

        // Scroll down to the recommendations after they appear
        const similarSection = document.querySelector("#similar-section");

        if (similarSection) {
          similarSection.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        }

        console.log("renderSimilarTracks called");
      } catch (error) {
        console.error("SIMILARITY ERROR:", error);
      } finally {
        similarButton.disabled = false;

        similarButton.textContent = "✨ Similar";
      }
    });

    playButton.addEventListener("click", async (event) => {
      event.stopPropagation();

      try {
        await playTrack(trackUris, index);
      } catch (error) {
        console.error("Search playback error:", error);
      }
    });

    trackElement.addEventListener("click", async () => {
      try {
        await playTrack(trackUris, index);
      } catch (error) {
        console.error("Search playback error:", error);
      }
    });

    container.appendChild(trackElement);

    queueAddButton.addEventListener("click", async (event) => {
      event.stopPropagation();

      try {
        queueAddButton.disabled = true;

        queueAddButton.textContent = "Adding...";

        await addTrackToQueue(track.uri);

        queueAddButton.textContent = "✓ Queued";

        setTimeout(() => {
          if (!queueAddButton.isConnected) {
            return;
          }

          queueAddButton.disabled = false;
          queueAddButton.textContent = "+ Queue";
        }, 1200);
      } catch (error) {
        console.error("Add to queue error:", error);

        queueAddButton.disabled = false;

        queueAddButton.textContent = "Failed";
      }
    });
  });
}

/* =========================
   QUEUE RENDERING
========================= */

function renderQueue(queueData) {
  const container = document.querySelector("#queue-tracks");

  const status = document.querySelector("#queue-status");

  if (!container || !status) {
    return;
  }

  container.replaceChildren();

  const tracks = queueData?.queue ?? [];

  if (tracks.length === 0) {
    status.textContent = "Your queue is empty.";

    return;
  }

  status.textContent = `${tracks.length} songs queued`;

  tracks.forEach((track, index) => {
    if (!track || track.type !== "track") {
      return;
    }

    const trackElement = document.createElement("div");

    trackElement.className = "track-card";

    const image = getSmallestSpotifyImage(track.album?.images);

    const artists =
      track.artists?.map((artist) => artist.name).join(", ") ?? "";

    trackElement.innerHTML = `
      <span class="track-number">
        ${index + 1}
      </span>

      <img
        class="track-image"
        src="${image}"
        alt="${track.name}"
        loading="lazy"
        decoding="async"
      />

      <div class="track-info">
        <span class="track-name">
          ${track.name}
        </span>

        <span class="track-artist">
          ${artists}
        </span>
      </div>
    `;

    container.appendChild(trackElement);
  });
}

/* =========================
   VIEW ROUTING
========================= */

function showHomeView() {
  clearTransientViews();

  const homeView = document.querySelector("#home-view");

  const searchView = document.querySelector("#search-view");

  const playlistsView = document.querySelector("#playlists-view");

  const playlistView = document.querySelector("#playlist-view");

  const queueView = document.querySelector("#queue-view");

  const artistView = document.querySelector("#artist-view");

  const releaseView = document.querySelector("#release-view");

  const similarSection = document.querySelector("#similar-section");

  const discographyView = document.querySelector("#artist-discography-view");

  searchView?.setAttribute("hidden", "");

  playlistsView?.setAttribute("hidden", "");

  playlistView?.setAttribute("hidden", "");

  queueView?.setAttribute("hidden", "");

  similarSection?.setAttribute("hidden", "");

  artistView?.setAttribute("hidden", "");

  homeView?.removeAttribute("hidden");

  releaseView?.setAttribute("hidden", "");

  discographyView?.setAttribute("hidden", "");
}

function showPlaylistsView() {
  const homeView = document.querySelector("#home-view");

  const searchView = document.querySelector("#search-view");

  const playlistsView = document.querySelector("#playlists-view");

  const playlistView = document.querySelector("#playlist-view");

  const queueView = document.querySelector("#queue-view");

  const similarSection = document.querySelector("#similar-section");

  const artistView = document.querySelector("#artist-view");

  const releaseView = document.querySelector("#release-view");

  const discographyView = document.querySelector("#artist-discography-view");

  homeView?.setAttribute("hidden", "");

  searchView?.setAttribute("hidden", "");

  playlistView?.setAttribute("hidden", "");

  queueView?.setAttribute("hidden", "");

  similarSection?.setAttribute("hidden", "");

  artistView?.setAttribute("hidden", "");

  playlistsView?.removeAttribute("hidden");

  releaseView?.setAttribute("hidden", "");

  discographyView?.setAttribute("hidden", "");
}

function showPlaylistView() {
  const homeView = document.querySelector("#home-view");

  const searchView = document.querySelector("#search-view");

  const playlistsView = document.querySelector("#playlists-view");

  const playlistView = document.querySelector("#playlist-view");

  const queueView = document.querySelector("#queue-view");

  const similarSection = document.querySelector("#similar-section");

  const artistView = document.querySelector("#artist-view");

  const releaseView = document.querySelector("#release-view");

  const discographyView = document.querySelector("#artist-discography-view");

  homeView?.setAttribute("hidden", "");

  searchView?.setAttribute("hidden", "");

  playlistsView?.setAttribute("hidden", "");

  queueView?.setAttribute("hidden", "");

  similarSection?.setAttribute("hidden", "");

  artistView?.setAttribute("hidden", "");

  releaseView?.setAttribute("hidden", "");

  discographyView?.setAttribute("hidden", "");

  playlistView?.removeAttribute("hidden");
}

function showQueueView() {
  const homeView = document.querySelector("#home-view");

  const searchView = document.querySelector("#search-view");

  const playlistsView = document.querySelector("#playlists-view");

  const playlistView = document.querySelector("#playlist-view");

  const queueView = document.querySelector("#queue-view");

  const similarSection = document.querySelector("#similar-section");

  const releaseView = document.querySelector("#release-view");

  const artistView = document.querySelector("#artist-view");

  const discographyView = document.querySelector("#artist-discography-view");

  homeView?.setAttribute("hidden", "");

  searchView?.setAttribute("hidden", "");

  playlistsView?.setAttribute("hidden", "");

  playlistView?.setAttribute("hidden", "");

  similarSection?.setAttribute("hidden", "");

  artistView?.setAttribute("hidden", "");

  queueView?.removeAttribute("hidden");

  releaseView?.setAttribute("hidden", "");

  discographyView?.setAttribute("hidden", "");
}

function showSearchView() {
  const homeView = document.querySelector("#home-view");

  const searchView = document.querySelector("#search-view");

  const playlistsView = document.querySelector("#playlists-view");

  const playlistView = document.querySelector("#playlist-view");

  const queueView = document.querySelector("#queue-view");

  const artistView = document.querySelector("#artist-view");

  const releaseView = document.querySelector("#release-view");

  const discographyView = document.querySelector("#artist-discography-view");

  homeView?.setAttribute("hidden", "");

  playlistsView?.setAttribute("hidden", "");

  playlistView?.setAttribute("hidden", "");

  queueView?.setAttribute("hidden", "");

  artistView?.setAttribute("hidden", "");

  releaseView?.setAttribute("hidden", "");

  searchView?.removeAttribute("hidden");

  discographyView?.setAttribute("hidden", "");
}

function showArtistView() {
  const homeView = document.querySelector("#home-view");

  const searchView = document.querySelector("#search-view");

  const playlistsView = document.querySelector("#playlists-view");

  const playlistView = document.querySelector("#playlist-view");

  const queueView = document.querySelector("#queue-view");

  const artistView = document.querySelector("#artist-view");

  const similarSection = document.querySelector("#similar-section");

  const releaseView = document.querySelector("#release-view");

  const discographyView = document.querySelector("#artist-discography-view");

  homeView?.setAttribute("hidden", "");

  searchView?.setAttribute("hidden", "");

  playlistsView?.setAttribute("hidden", "");

  playlistView?.setAttribute("hidden", "");

  queueView?.setAttribute("hidden", "");

  similarSection?.setAttribute("hidden", "");

  releaseView?.setAttribute("hidden", "");

  artistView?.removeAttribute("hidden");

  discographyView?.setAttribute("hidden", "");
}

function showArtistDiscographyView() {
  const homeView = document.querySelector("#home-view");

  const searchView = document.querySelector("#search-view");

  const playlistsView = document.querySelector("#playlists-view");

  const playlistView = document.querySelector("#playlist-view");

  const queueView = document.querySelector("#queue-view");

  const artistView = document.querySelector("#artist-view");

  const releaseView = document.querySelector("#release-view");

  const discographyView = document.querySelector("#artist-discography-view");

  const similarSection = document.querySelector("#similar-section");

  homeView?.setAttribute("hidden", "");

  searchView?.setAttribute("hidden", "");

  playlistsView?.setAttribute("hidden", "");

  playlistView?.setAttribute("hidden", "");

  queueView?.setAttribute("hidden", "");

  artistView?.setAttribute("hidden", "");

  releaseView?.setAttribute("hidden", "");

  similarSection?.setAttribute("hidden", "");

  discographyView?.removeAttribute("hidden");
}

function showReleaseView() {
  const homeView = document.querySelector("#home-view");

  const searchView = document.querySelector("#search-view");

  const playlistsView = document.querySelector("#playlists-view");

  const playlistView = document.querySelector("#playlist-view");

  const queueView = document.querySelector("#queue-view");

  const artistView = document.querySelector("#artist-view");

  const releaseView = document.querySelector("#release-view");

  const similarSection = document.querySelector("#similar-section");

  const discographyView = document.querySelector("#artist-discography-view");

  homeView?.setAttribute("hidden", "");

  searchView?.setAttribute("hidden", "");

  playlistsView?.setAttribute("hidden", "");

  playlistView?.setAttribute("hidden", "");

  queueView?.setAttribute("hidden", "");

  artistView?.setAttribute("hidden", "");

  similarSection?.setAttribute("hidden", "");

  discographyView?.setAttribute("hidden", "");

  releaseView?.removeAttribute("hidden");
}

function clearTransientViews() {
  const queueTracks = document.querySelector("#queue-tracks");

  if (queueTracks) {
    queueTracks.replaceChildren();
  }

  clearSimilarResults();
}

/* =========================
   SPOTIFY SDK CALLBACK
========================= */

window.onSpotifyWebPlaybackSDKReady = async () => {
  console.log("Spotify Web Playback SDK loaded");

  try {
    const token = await getValidSpotifyAccessToken();

    if (token) {
      initializeSpotifyPlayer();
    }
  } catch (error) {
    console.error("Could not restore Spotify connection:", error);
  }
};

/* =========================
   UI INITIALIZATION & EVENTS
========================= */

window.addEventListener("DOMContentLoaded", async () => {
  try {
    await invoke("register_webview_process");
  } catch (error) {
    console.error("Could not register WebView2 process:", error);
  }

  startResourceMonitor();

  setTimeout(() => {
    void setBetterfyMemoryMode(true);
  }, 3000);

  startResourceMonitor();

  setTimeout(() => {
    void setBetterfyMemoryMode(true);
  }, 3000);

  const loginButton = document.querySelector("#spotify-login");

  const logoutButton = document.querySelector("#spotify-logout");

  const playPauseButton = document.querySelector("#play-pause-button");

  const nextButton = document.querySelector("#next-button");

  const repeatButton = document.querySelector("#repeat-button");

  const queueButton = document.querySelector("#queue-button");

  const closeQueueButton = document.querySelector("#close-queue");

  const previousButton = document.querySelector("#previous-button");

  const shuffleButton = document.querySelector("#shuffle-button");

  const volumeSlider = document.querySelector("#volume-slider");

  const volumeValue = document.querySelector("#volume-value");

  const savedVolume = getSavedVolume();

  volumeSlider.value = String(savedVolume);

  volumeValue.textContent = `${savedVolume}%`;

  const progressSlider = document.querySelector("#progress-slider");

  const currentTime = document.querySelector("#current-time");

  const searchInput = document.querySelector("#search-input");

  const searchResults = document.querySelector("#search-results");

  const searchStatus = document.querySelector("#search-status");

  const clearSearchButton = document.querySelector("#clear-search");

  const closeArtistButton = document.querySelector("#close-artist");

  const closeArtistDiscographyButton = document.querySelector(
    "#close-artist-discography",
  );

  const closeReleaseButton = document.querySelector("#close-release");

  const closePlaylistButton = document.querySelector("#close-playlist");

  const playlistView = document.querySelector("#playlist-view");

  const content = document.querySelector(".content");

  const showCreatePlaylistButton = document.querySelector(
    "#show-create-playlist",
  );

  const createPlaylistForm = document.querySelector("#create-playlist-form");

  const cancelCreatePlaylistButton = document.querySelector(
    "#cancel-create-playlist",
  );

  const playlistNameInput = document.querySelector("#new-playlist-name");

  const playlistDescriptionInput = document.querySelector(
    "#new-playlist-description",
  );

  const playlistPrivateInput = document.querySelector("#new-playlist-private");

  const createPlaylistStatus = document.querySelector(
    "#create-playlist-status",
  );

  const homeNav = document.querySelector("#home-nav");

  const playlistsNav = document.querySelector("#playlists-nav");

  const homePlaylists = document.querySelector("#playlists");

  const allPlaylists = document.querySelector("#all-playlists");

  const memoryModeButton = document.querySelector("#memory-mode-button");

  loginButton.addEventListener("click", loginWithSpotify);

  logoutButton.addEventListener("click", logoutSpotify);

  shuffleButton.addEventListener("click", async () => {
    try {
      if (!spotifyPlayer) {
        return;
      }

      const nextShuffleState = !shuffleEnabled;

      await setSpotifyShuffle(nextShuffleState);

      shuffleEnabled = nextShuffleState;

      updateShuffleButton();
    } catch (error) {
      console.error("Shuffle error:", error);
    }
  });

  playPauseButton.addEventListener("click", async () => {
    try {
      if (!spotifyPlayer) {
        return;
      }

      await spotifyPlayer.togglePlay();

      await new Promise((resolve) => setTimeout(resolve, 200));

      await updatePlayer();
    } catch (error) {
      console.error("Play/pause error:", error);
    }
  });

  nextButton.addEventListener("click", async () => {
    try {
      if (!spotifyPlayer) {
        return;
      }

      await spotifyPlayer.nextTrack();

      await new Promise((resolve) => setTimeout(resolve, 500));

      await updatePlayer();
    } catch (error) {
      console.error("Next error:", error);
    }
  });

  repeatButton.addEventListener("click", async () => {
    if (!spotifyPlayer || repeatChangeInProgress) {
      return;
    }

    repeatChangeInProgress = true;

    try {
      let nextRepeatMode;

      if (repeatMode === "off") {
        nextRepeatMode = "context";
      } else if (repeatMode === "context") {
        nextRepeatMode = "track";
      } else {
        nextRepeatMode = "off";
      }

      await setSpotifyRepeat(nextRepeatMode);
    } catch (error) {
      console.error("Repeat error:", error);
    } finally {
      repeatChangeInProgress = false;
    }
  });

  previousButton.addEventListener("click", async () => {
    try {
      if (!spotifyPlayer) {
        return;
      }

      await spotifyPlayer.previousTrack();

      await new Promise((resolve) => setTimeout(resolve, 500));

      await updatePlayer();
    } catch (error) {
      console.error("Previous error:", error);
    }
  });

  volumeSlider.addEventListener("input", async () => {
    const volume = Number(volumeSlider.value);

    /*
     * Update the displayed percentage.
     */
    volumeValue.textContent = `${volume}%`;

    /*
     * Persist it immediately.
     */
    saveVolume(volume);

    /*
     * If Spotify Player exists,
     * update actual playback volume.
     */
    if (spotifyPlayer) {
      try {
        await setPlayerVolume(volume);
      } catch (error) {
        console.error("Volume error:", error);
      }
    }
  });

  progressSlider.addEventListener("input", () => {
    isSeeking = true;

    if (currentDuration <= 0) {
      return;
    }

    const percentage = Number(progressSlider.value) / 100;

    const previewPosition = currentDuration * percentage;

    currentTime.textContent = formatTime(previewPosition);
  });

  progressSlider.addEventListener("change", async () => {
    try {
      if (!spotifyPlayer || currentDuration <= 0) {
        return;
      }

      const percentage = Number(progressSlider.value) / 100;

      const newPosition = Math.floor(currentDuration * percentage);

      await spotifyPlayer.seek(newPosition);

      currentPosition = newPosition;

      updateProgressUI();
    } catch (error) {
      console.error("Seek error:", error);
    } finally {
      isSeeking = false;
    }
  });

  const handleSearch = debounce(async () => {
    const query = searchInput.value.trim();

    const requestId = ++searchRequestId;

    // Remove recommendations from the
    // previous search.
    clearSimilarResults();

    if (!query) {
      searchResults.innerHTML = "";

      searchStatus.textContent = "";

      clearArtistSearchResults();

      clearArtistView();

      showHomeView();

      return;
    }

    // Switch to the search "page"
    showSearchView();

    try {
      searchAbortController?.abort();

      searchAbortController = new AbortController();

      searchStatus.textContent = "Searching...";

      const results = await searchSpotify(
        query,
        "track,artist",
        10,
        searchAbortController.signal,
      );

      if (requestId !== searchRequestId) {
        return;
      }

      const tracks = results.tracks?.items ?? [];

      const artists = results.artists?.items ?? [];

      renderArtistSearchResults(artists);

      renderSearchResults(tracks);

      if (tracks.length === 0 && artists.length === 0) {
        searchStatus.textContent = "No results found.";
      } else {
        searchStatus.textContent = `${artists.length} artists · ${tracks.length} songs`;
      }
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }

      console.error("Spotify search error:", error);

      searchStatus.textContent = "Search failed.";
    }
  }, 350);

  searchInput.addEventListener("input", handleSearch);

  clearSearchButton.addEventListener("click", () => {
    searchAbortController?.abort();
    searchAbortController = null;

    searchRequestId++;

    searchInput.value = "";

    // Remove song search DOM.
    searchResults.innerHTML = "";

    // Remove artist search DOM.
    clearArtistSearchResults();

    // Remove artist page DOM.
    clearArtistView();

    searchStatus.textContent = "";

    // Remove recommendation DOM.
    clearSimilarResults();

    showHomeView();

    searchInput.focus();
  });

  closePlaylistButton.addEventListener("click", () => {
    const playlistTracks = document.querySelector("#playlist-tracks");

    if (playlistTracks) {
      playlistTracks.innerHTML = "";
    }

    currentPlaylistItems = [];

    currentPlaylist = null;

    renderedPlaylistCount = 0;

    if (playlistReturnView === "playlists") {
      showPlaylistsView();
    } else {
      showHomeView();
    }
  });

  showCreatePlaylistButton.addEventListener("click", () => {
    createPlaylistForm.removeAttribute("hidden");

    showCreatePlaylistButton.setAttribute("hidden", "");

    playlistNameInput.focus();
  });

  cancelCreatePlaylistButton.addEventListener("click", () => {
    createPlaylistForm.setAttribute("hidden", "");

    showCreatePlaylistButton.removeAttribute("hidden");

    createPlaylistForm.reset();

    createPlaylistStatus.textContent = "";
  });

  createPlaylistForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const name = playlistNameInput.value.trim();

    const description = playlistDescriptionInput.value.trim();

    const isPrivate = playlistPrivateInput.checked;

    if (!name) {
      createPlaylistStatus.textContent = "Enter a playlist name.";

      return;
    }

    try {
      createPlaylistStatus.textContent = "Creating playlist...";

      const playlist = await createSpotifyPlaylist(
        name,
        description,
        isPrivate,
      );

      console.log("Created playlist:", playlist);

      createPlaylistStatus.textContent = `Created "${playlist.name}"`;

      await refreshPlaylists();

      createPlaylistForm.reset();

      createPlaylistForm.setAttribute("hidden", "");

      showCreatePlaylistButton.removeAttribute("hidden");
    } catch (error) {
      console.error("Create playlist error:", error);

      createPlaylistStatus.textContent = "Could not create playlist.";
    }
  });

  if (memoryModeButton) {
    memoryModeButton.addEventListener("click", async () => {
      await setBetterfyMemoryMode(!lowMemoryModeEnabled);
    });
  }

  content.addEventListener("scroll", () => {
    const playlistView = document.querySelector("#playlist-view");

    const playlistsView = document.querySelector("#playlists-view");

    const discographyView = document.querySelector("#artist-discography-view");

    const distanceFromBottom =
      content.scrollHeight - content.scrollTop - content.clientHeight;

    if (distanceFromBottom >= 400) {
      return;
    }

    /*
     * Load the next page of artist releases.
     */
    if (discographyView && !discographyView.hasAttribute("hidden")) {
      void loadNextDiscographyPage();

      return;
    }

    /*
     * Load more tracks inside one playlist.
     */
    if (playlistView && !playlistView.hasAttribute("hidden")) {
      if (renderedPlaylistCount < currentPlaylistItems.length) {
        renderNextPlaylistBatch();
      }

      return;
    }

    /*
     * Load the next page of playlists.
     */
    if (playlistsView && !playlistsView.hasAttribute("hidden")) {
      void loadNextPlaylistPage();
    }
  });

  if (queueButton) {
    queueButton.addEventListener("click", async () => {
      try {
        const queue = await getSpotifyQueue();

        renderQueue(queue);

        showQueueView();
      } catch (error) {
        console.error("Could not load queue:", error);

        const status = document.querySelector("#queue-status");

        if (status) {
          status.textContent = "Could not load queue.";
        }

        showQueueView();
      }
    });
  }

  if (closeQueueButton) {
    closeQueueButton.addEventListener("click", () => {
      const container = document.querySelector("#queue-tracks");

      if (container) {
        container.replaceChildren();
      }

      showHomeView();
    });
  }

  homeNav.addEventListener("click", (event) => {
    event.preventDefault();

    showHomeView();
  });

  playlistsNav.addEventListener("click", async (event) => {
    event.preventDefault();

    await openPlaylistsPage();
  });

  homePlaylists.addEventListener("click", async (event) => {
    const card = event.target.closest(".playlist-card");

    if (!card || !homePlaylists.contains(card)) {
      return;
    }

    await openPlaylist(playlistFromCard(card), "home");
  });

  allPlaylists.addEventListener("click", async (event) => {
    const card = event.target.closest(".playlist-card");

    if (!card || !allPlaylists.contains(card)) {
      return;
    }

    await openPlaylist(playlistFromCard(card), "playlists");
  });

  closeArtistButton.addEventListener("click", () => {
    clearArtistView();

    showSearchView();
  });

  closeArtistDiscographyButton.addEventListener("click", () => {
    clearArtistDiscographyView();

    showArtistView();
  });

  closeReleaseButton.addEventListener("click", () => {
    clearReleaseView();

    if (releaseReturnView === "discography" && currentDiscographyArtist) {
      showArtistDiscographyView();
    } else {
      showArtistView();
    }
  });

  void restoreSpotifySession();
});

const { openUrl } = window.__TAURI__.opener;

const { invoke } = window.__TAURI__.core;

// Betterfy autoplay: when a finite queue/context ends, seed a new queue
// from the final song using the existing Last.fm -> Spotify recommender.
let autoplayEnabled = true;
let autoplayInProgress = false;
let lastAutoplaySeedId = null;

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

let progressTimer = null;
let isSeeking = false;

let resourceMonitorTimer = null;
let peakRamUsage = 0;
let lowMemoryModeEnabled = true;

let currentPlaylistItems = [];
let currentPlaylist = null;
let renderedPlaylistCount = 0;

const PLAYLIST_RENDER_BATCH_SIZE = 30;

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

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
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
    console.error("Spotify token refresh failed:", tokenData);

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

function debounce(callback, delay) {
  let timeoutId;

  return (...args) => {
    clearTimeout(timeoutId);

    timeoutId = setTimeout(() => callback(...args), delay);
  };
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

async function getSpotifyDevices() {
  return spotifyFetch("/me/player/devices");
}

async function waitForSpotifyDevice(deviceId, timeoutMs = 5000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const data = await getSpotifyDevices();

      const devices = data?.devices ?? [];

      console.log("Spotify devices:", devices);

      const device = devices.find((item) => item.id === deviceId);

      if (device) {
        console.log("Betterfy device is registered with Spotify:", device);

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
async function playTrack(trackUris, startIndex = 0) {
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

async function startAutoplayFromTrack(track) {
  if (!autoplayEnabled || autoplayInProgress || !track?.name) {
    return;
  }

  const seedId =
    track.id ?? track.uri ?? `${track.name}:${track.artists?.[0]?.name ?? ""}`;

  // The SDK can emit the same end-of-track state more than once.
  if (lastAutoplaySeedId === seedId) {
    return;
  }

  autoplayInProgress = true;
  lastAutoplaySeedId = seedId;

  try {
    console.log("Autoplay: finding songs similar to", track.name);

    const seedTrack = spotifySdkTrackToApiTrack(track);
    const recommendations = await getSpotifySimilarTracks(seedTrack);

    if (recommendations.length === 0) {
      console.log("Autoplay: no recommendations found");
      return;
    }

    // Keep the UI in sync with what Betterfy is about to continue with.
    renderSimilarTracks(seedTrack, recommendations);

    const uris = recommendations.map((item) => item.uri).filter(Boolean);

    if (uris.length === 0) {
      return;
    }

    document.querySelector("#status").textContent =
      `Autoplaying songs similar to ${track.name}`;

    await playTrack(uris, 0);
  } catch (error) {
    // Allow a future end event for this song to retry if recommendation lookup
    // or playback failed.
    lastAutoplaySeedId = null;
    console.error("Autoplay error:", error);
  } finally {
    autoplayInProgress = false;
  }
}

async function playPlaylist(playlistUri, position) {
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
      context_uri: playlistUri,

      offset: {
        position: position,
      },

      position_ms: 0,
    }),
  });

  if (!response.ok) {
    const error = await response.text();

    throw new Error(`Playlist playback failed ${response.status}: ${error}`);
  }
}

async function searchSpotify(query) {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    return {
      tracks: {
        items: [],
      },
    };
  }

  const encodedQuery = encodeURIComponent(trimmedQuery);

  return spotifyFetch(`/search?q=${encodedQuery}&type=track&limit=10`);
}

function normalizeText(value) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
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

  console.log("LAST.FM TRACKS:", lastFmTracks);

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

    console.log("Spotify lookup result:", spotifyTrack);

    if (!spotifyTrack) {
      continue;
    }

    results.push({
      ...spotifyTrack,
      lastFmMatch: Number(similarTrack.match),
    });
  }

  const cleanedResults = cleanRecommendations(track, results);

  console.log("Final cleaned recommendations:", cleanedResults);

  return cleanedResults;
}

async function getUserPlaylists() {
  return spotifyFetch("/me/playlists?limit=12");
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
  const playlists = await getUserPlaylists();

  renderPlaylists(playlists.items);
}

async function getPlaylistItems(playlistId) {
  const allItems = [];

  let endpoint = `/playlists/${encodeURIComponent(playlistId)}/items?limit=50`;

  while (endpoint) {
    const data = await spotifyFetch(endpoint);

    allItems.push(...(data.items ?? []));

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

function showHomeView() {
  const homeView = document.querySelector("#home-view");

  const searchView = document.querySelector("#search-view");

  const playlistView = document.querySelector("#playlist-view");

  const queueView = document.querySelector("#queue-view");

  if (searchView) {
    searchView.setAttribute("hidden", "");
  }

  if (playlistView) {
    playlistView.setAttribute("hidden", "");
  }

  if (queueView) {
    queueView.setAttribute("hidden", "");
  }

  if (homeView) {
    homeView.removeAttribute("hidden");
  }
}

function showPlaylistView() {
  const homeView = document.querySelector("#home-view");

  const searchView = document.querySelector("#search-view");

  const playlistView = document.querySelector("#playlist-view");

  const similarSection = document.querySelector("#similar-section");

  // Hide home
  if (homeView) {
    homeView.setAttribute("hidden", "");
  }

  // Hide search page
  if (searchView) {
    searchView.setAttribute("hidden", "");
  }

  // Hide recommendations
  if (similarSection) {
    similarSection.setAttribute("hidden", "");
  }

  // Show playlist page
  if (playlistView) {
    playlistView.removeAttribute("hidden");
  }
}

function showQueueView() {
  const homeView = document.querySelector("#home-view");

  const searchView = document.querySelector("#search-view");

  const playlistView = document.querySelector("#playlist-view");

  const queueView = document.querySelector("#queue-view");

  const similarSection = document.querySelector("#similar-section");

  if (homeView) {
    homeView.setAttribute("hidden", "");
  }

  if (searchView) {
    searchView.setAttribute("hidden", "");
  }

  if (playlistView) {
    playlistView.setAttribute("hidden", "");
  }

  if (similarSection) {
    similarSection.setAttribute("hidden", "");
  }

  if (queueView) {
    queueView.removeAttribute("hidden");
  }
}

function clearSimilarResults() {
  const section = document.querySelector("#similar-section");

  const container = document.querySelector("#similar-tracks");

  if (container) {
    container.innerHTML = "";
  }

  if (section) {
    section.setAttribute("hidden", "");
  }
}

function showSearchView() {
  const homeView = document.querySelector("#home-view");

  const searchView = document.querySelector("#search-view");

  const playlistView = document.querySelector("#playlist-view");

  homeView.setAttribute("hidden", "");

  playlistView.setAttribute("hidden", "");

  searchView.removeAttribute("hidden");
}

function hideSearchView() {
  const searchView = document.querySelector("#search-view");

  searchView.setAttribute("hidden", "");
}

function renderPlaylists(playlists) {
  const container = document.querySelector("#playlists");

  container.innerHTML = "";

  playlists.forEach((playlist) => {
    const playlistElement = document.createElement("div");

    playlistElement.className = "playlist-card";

    const image = getMediumSpotifyImage(playlist.images);

    playlistElement.innerHTML = `
      <img
        class="playlist-image"
        src="${image}"
        alt="${playlist.name}"
        loading="lazy"
        decoding="async"
      />

      <div class="playlist-info">
        <span class="playlist-name">
          ${playlist.name}
        </span>

        <span class="playlist-owner">
          ${playlist.owner?.display_name ?? ""}
        </span>
      </div>
    `;

    playlistElement.addEventListener("click", async () => {
      try {
        const data = await getPlaylistItems(playlist.id);

        console.log("Playlist items:", data);

        renderPlaylistTracks(playlist, data.items);

        showPlaylistView();
      } catch (error) {
        console.error("Could not load playlist:", error);
      }
    });

    container.appendChild(playlistElement);
  });
}

function renderPlaylistTracks(playlist, items) {
  const title = document.querySelector("#playlist-title");

  const container = document.querySelector("#playlist-tracks");

  title.textContent = playlist.name;

  container.innerHTML = "";

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
    const playlistItem = currentPlaylistItems[index];

    const track = playlistItem.item;

    if (!track || track.type !== "track") {
      continue;
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

    trackElement.addEventListener("click", async () => {
      try {
        await playPlaylist(currentPlaylist.uri, index);
      } catch (error) {
        console.error("Playlist playback error:", error);
      }
    });

    fragment.appendChild(trackElement);
  }

  container.appendChild(fragment);

  renderedPlaylistCount = endIndex;
}

function renderSearchResults(tracks) {
  const container = document.querySelector("#search-results");

  container.innerHTML = "";

  if (tracks.length === 0) {
    container.innerHTML = "";
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
        console.log("Seed track:", track);

        const recommendations = await getSpotifySimilarTracks(track);

        console.log("Recommendations returned:", recommendations);

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

function renderSimilarTracks(seedTrack, tracks) {
  const section = document.querySelector("#similar-section");
  const title = document.querySelector("#similar-title");
  const status = document.querySelector("#similar-status");
  const container = document.querySelector("#similar-tracks");

  container.innerHTML = "";

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
        alt="${track.name}"
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

function renderQueue(queueData) {
  const container = document.querySelector("#queue-tracks");

  const status = document.querySelector("#queue-status");

  if (!container || !status) {
    return;
  }

  container.innerHTML = "";

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

async function pausePlayback() {
  const accessToken = await getValidSpotifyAccessToken();

  await ensureSpotifyDeviceReady();

  const response = await fetch(
    "https://api.spotify.com/v1/me/player/pause" +
      `?device_id=${encodeURIComponent(spotifyDeviceId)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    const error = await response.text();

    throw new Error(`Pause failed ${response.status}: ${error}`);
  }
}

async function resumePlayback() {
  const accessToken = await getValidSpotifyAccessToken();

  await ensureSpotifyDeviceReady();

  const response = await fetch(
    "https://api.spotify.com/v1/me/player/play" +
      `?device_id=${encodeURIComponent(spotifyDeviceId)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    const error = await response.text();

    throw new Error(`Resume failed ${response.status}: ${error}`);
  }
}

async function nextTrack() {
  const accessToken = await getValidSpotifyAccessToken();

  await ensureSpotifyDeviceReady();

  const response = await fetch(
    "https://api.spotify.com/v1/me/player/next" +
      `?device_id=${encodeURIComponent(spotifyDeviceId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    const error = await response.text();

    throw new Error(`Next track failed ${response.status}: ${error}`);
  }
}

async function previousTrack() {
  const accessToken = await getValidSpotifyAccessToken();

  await ensureSpotifyDeviceReady();

  const response = await fetch(
    "https://api.spotify.com/v1/me/player/previous" +
      `?device_id=${encodeURIComponent(spotifyDeviceId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    const error = await response.text();

    throw new Error(`Previous track failed ${response.status}: ${error}`);
  }
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

    art.src = track.album?.images?.[0]?.url ?? "";

    playPause.textContent = state.is_playing ? "⏸" : "▶";
  } catch (error) {
    console.error("Could not update player:", error);
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

  spotifyPlayer = new Spotify.Player({
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

  spotifyPlayer.addListener("ready", async ({ device_id }) => {
    console.log("Betterfy SDK device ready:", device_id);

    spotifyDeviceId = device_id;

    spotifyDeviceReady = false;

    spotifyDeviceSetupPromise = null;

    /*
     * Restore saved volume.
     */
    try {
      await spotifyPlayer.setVolume(getSavedVolume() / 100);
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

  spotifyPlayer.addListener("player_state_changed", (state) => {
    if (!state) {
      return;
    }

    const previousTrack = state.track_window.previous_tracks?.at(-1);

    const currentTrack = state.track_window.current_track;

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

    // A finished final song is reported as paused at
    // (or extremely close to) its duration, with no
    // next track left in Spotify's playback window.
    const endedFinalTrack =
      state.paused &&
      state.duration > 0 &&
      state.position >= state.duration - 750 &&
      nextTracks.length === 0;

    if (endedFinalTrack) {
      void startAutoplayFromTrack(currentTrack ?? previousTrack);
    } else if (!state.paused) {
      // Once playback has moved on, a future queue can
      // use this song as a new autoplay seed if it
      // becomes the final track later.
      const activeId = currentTrack?.id ?? currentTrack?.uri;

      if (activeId && activeId !== lastAutoplaySeedId) {
        lastAutoplaySeedId = null;
      }
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

      art.src = track.album?.images?.[0]?.url ?? "";
    }

    // -------------------------
    // Play / Pause button
    // -------------------------

    const playPauseButton = document.querySelector("#play-pause-button");

    if (playPauseButton) {
      playPauseButton.textContent = state.paused ? "▶" : "⏸";
    }
  });

  spotifyPlayer.addListener("not_ready", ({ device_id }) => {
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

  spotifyPlayer.addListener("initialization_error", ({ message }) => {
    console.error("Spotify initialization error:", message);
  });

  spotifyPlayer.addListener("authentication_error", ({ message }) => {
    console.error("Spotify authentication error:", message);

    const status = document.querySelector("#status");

    if (status) {
      status.textContent = `Spotify authentication error: ${message}`;
    }
  });

  spotifyPlayer.addListener("account_error", ({ message }) => {
    console.error("Spotify account error:", message);

    const status = document.querySelector("#status");

    if (status) {
      status.textContent = "Spotify Premium is required for playback.";
    }
  });

  spotifyPlayer.addListener("playback_error", ({ message }) => {
    console.error("Spotify playback error:", message);

    const status = document.querySelector("#status");

    if (status) {
      status.textContent = `Playback error: ${message}`;
    }
  });

  spotifyPlayer.connect().then((success) => {
    console.log("Spotify player connect result:", success);

    if (success) {
      startProgressTimer();
    }
  });
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

async function loginWithSpotify() {
  try {
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

    console.log("Spotify token response:", tokenData);

    // Save access token
    saveSpotifyTokens(tokenData);

    if (window.Spotify) {
      initializeSpotifyPlayer();
    }

    // Use the access token to get the user's Spotify profile
    const profile = await getSpotifyProfile(tokenData.access_token);

    console.log("Spotify profile:", profile);

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

    console.log("Playlists:", playlists);

    renderPlaylists(playlists.items);

    await updatePlayer();
  } catch (error) {
    console.error("Betterfy startup error:", error);

    document.querySelector("#status").textContent = `Error: ${error.message}`;
  }
}

async function logoutSpotify() {
  try {
    /*
     * Disconnect the Web Playback SDK.
     */
    if (spotifyPlayer) {
      spotifyPlayer.disconnect();
      spotifyPlayer = null;
    }

    spotifyDeviceId = null;
    spotifyDeviceReady = false;
    spotifyDeviceSetupPromise = null;

    /*
     * Stop local playback/progress state.
     */
    isCurrentlyPlaying = false;
    currentPosition = 0;
    currentDuration = 0;

    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }

    /*
     * Remove saved Spotify authorization.
     */
    clearSpotifyTokens();

    /*
     * Remove any leftover PKCE state.
     */
    sessionStorage.removeItem("spotify_code_verifier");

    /*
     * Reset buttons.
     */
    const loginButton = document.querySelector("#spotify-login");

    const logoutButton = document.querySelector("#spotify-logout");

    if (loginButton) {
      loginButton.removeAttribute("hidden");

      loginButton.disabled = false;
      loginButton.textContent = "Connect";
    }

    if (logoutButton) {
      logoutButton.setAttribute("hidden", "");
    }

    /*
     * Reset status.
     */
    const status = document.querySelector("#status");

    if (status) {
      status.textContent = "Not connected to Spotify";
    }

    /*
     * Hide player.
     */
    const playerBar = document.querySelector("#player-bar");

    if (playerBar) {
      playerBar.setAttribute("hidden", "");
    }

    /*
     * Clear user-specific content.
     */
    const playlists = document.querySelector("#playlists");

    const searchResults = document.querySelector("#search-results");

    const playlistTracks = document.querySelector("#playlist-tracks");

    if (playlists) {
      playlists.innerHTML = "";
    }

    if (searchResults) {
      searchResults.innerHTML = "";
    }

    if (playlistTracks) {
      playlistTracks.innerHTML = "";
    }

    clearSimilarResults();

    /*
     * Reset playlist state.
     */
    currentPlaylistItems = [];
    currentPlaylist = null;
    renderedPlaylistCount = 0;

    /*
     * Return to home.
     */
    showHomeView();

    console.log("Spotify logout complete");
  } catch (error) {
    console.error("Spotify logout error:", error);
  }
}

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

    const playlists = await getUserPlaylists();

    renderPlaylists(playlists.items ?? []);

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

window.addEventListener("DOMContentLoaded", () => {
  startResourceMonitor();

  setTimeout(() => {
    void setBetterfyMemoryMode(true);
  }, 3000);

  const loginButton = document.querySelector("#spotify-login");

  const logoutButton = document.querySelector("#spotify-logout");

  const playPauseButton = document.querySelector("#play-pause-button");

  const nextButton = document.querySelector("#next-button");

  const queueButton = document.querySelector("#queue-button");

  const closeQueueButton = document.querySelector("#close-queue");

  const previousButton = document.querySelector("#previous-button");

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

  const memoryModeButton = document.querySelector("#memory-mode-button");

  loginButton.addEventListener("click", loginWithSpotify);

  logoutButton.addEventListener("click", logoutSpotify);

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

    // Remove recommendations from the
    // previous search.
    clearSimilarResults();

    if (!query) {
      searchResults.innerHTML = "";
      searchStatus.textContent = "";

      showHomeView();

      return;
    }

    // Switch to the search "page"
    showSearchView();

    try {
      searchStatus.textContent = "Searching...";

      const results = await searchSpotify(query);

      const tracks = results.tracks?.items ?? [];

      renderSearchResults(tracks);

      if (tracks.length === 0) {
        searchStatus.textContent = "No songs found.";
      } else {
        searchStatus.textContent = `${tracks.length} results`;
      }
    } catch (error) {
      console.error("Spotify search error:", error);

      searchStatus.textContent = "Search failed.";
    }
  }, 350);

  searchInput.addEventListener("input", handleSearch);

  clearSearchButton.addEventListener("click", () => {
    searchInput.value = "";

    // Remove search DOM.
    searchResults.innerHTML = "";

    searchStatus.textContent = "";

    // Remove recommendation DOM.
    clearSimilarResults();

    // Return to playlists /
    // recently played.
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

    showHomeView();
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

    if (!playlistView || playlistView.hasAttribute("hidden")) {
      return;
    }

    const distanceFromBottom =
      content.scrollHeight - content.scrollTop - content.clientHeight;

    if (distanceFromBottom < 400) {
      if (renderedPlaylistCount < currentPlaylistItems.length) {
        renderNextPlaylistBatch();
      }
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
        container.innerHTML = "";
      }

      showHomeView();
    });
  }
  void restoreSpotifySession();
});

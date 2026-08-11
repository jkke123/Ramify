# Betterfy

A Spotify API/LAST.FM API application designed to use less memory than the current Spotify desktop app

It uses up to 60% less memory overall compared to the Spotify desktop app, with results coming out to around 200-400 MB of memory.

It uses WebView2 Low mode, as well as removing lots of different features that might add unnecessary memory usage.

## Steps to Setup

1. Get a [Spotify API](https://developer.spotify.com)
2. Get a [Last.FM API](https://www.last.fm/api)
3. Add a .env file, following the .env.example format, adding your respective API keys
4. Run
```
npm install
```
5. Run
```
npm run tauri build
```
To get the executable file

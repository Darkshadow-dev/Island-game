# ISLAD

A 3D island exploration game using the supplied images/images.jfif map as the island outline. The terrain spans 447,000 × 447,000 metres, rises to 5,500 metres above sea level, with the island floor extending to -1,000 metres below the sea-level plane. Water is not rendered yet. Forests, bushes, grass, walking, sprinting, jumping, and fall damage are generated around the player. No animals or enemies are included.

## Run locally

Requires Node.js 18 or newer.

1. Run npm install.
2. Run npm start.
3. Open http://localhost:8080.

The page can run local singleplayer as a static site if the browser can load the map image and Three.js CDN. Running npm start also enables the exact map-based terrain and invite-link multiplayer. Three.js is loaded from jsDelivr.

## Worlds and saves

The game has three local world slots. Local data is saved to browser storage and, where supported, the browser's private origin storage file islad-save.json. A world can be shared by copying its invite URL. That URL is the only join mechanism; there are no room codes. Public worlds are stored in data/worlds.json on the server and accept up to four connected players, including when the owner is offline. The owner can delete a public world from the slot menu after confirming.

For hosted deployments, set WORLD_DATA_DIR to a persistent disk directory. On Render, mount a persistent disk and point this variable at its mount path; without persistent storage, public worlds reset when the service filesystem resets. GitHub Pages alone can serve the singleplayer files but cannot run the WebSocket/API server needed for persistent public worlds.

## Controls

- Desktop: WASD to move, mouse to look, Space to jump, Shift to sprint, Esc to pause.
- Mobile: left joystick to move, drag on the right side to look, and tap Jump.

Brightness, render distance, sound effects, and the mobile detail cap are available in Settings. Mining, inventory, tree harvesting, support columns, water, animals, and enemies are not part of this first game build.


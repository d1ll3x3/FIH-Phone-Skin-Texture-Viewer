# FIH Phone Skin & Charm Viewer

A skin and charm viewer for **Flipping is Hard**, based on
[FIH-Phone-Skin-Texture-Viewer](https://github.com/d1ll3x3/FIH-Phone-Skin-Texture-Viewer).
Preview the phone and load charms converted from Unity AssetBundles.

## Run On Windows

Install Python 3.12 or later. Open PowerShell in this folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-viewer.ps1
```

The script creates a `.venv` environment, installs `tools/requirements.txt` on
the first launch, and opens your browser. The server listens only on your
computer at `http://127.0.0.1:8765/`. If that port is busy, it uses the next
available port. The selected URL stays visible in the terminal. Stop the server
with `Ctrl+C`.

To choose another port or prevent a new browser window from opening:

```powershell
.\start-viewer.ps1 -Port 9000 -NoBrowser
```

In the viewer, select **Charm** and upload your bundle using the same upload
area as textures, either by clicking or dragging the file. The converter
processes the file locally, with a 64 MB limit, and deletes its temporary copy
when finished. The sample charm is provided as preconverted JSON, so it can
be opened without installing Unity or modifying the game installation.
`assets/charms/hat.json` was extracted from the `hatbundle` supplied for testing.
`assets/charms/hat.js` contains the same charm as a static sample.
`assets/charms/hat-preset.json` preserves the supplied MC2 preset and is applied
to MeshCloth by default. You can also upload another preset JSON with **Charm**
selected, without replacing the current mesh.

In that tab, **Hide phone** hides only the phone mesh so you can inspect the
charm. Rotation and physics remain active. **Phone collisions** enables
collisions with the phone. It is disabled by default and independent of phone
visibility. These settings are retained when switching charms or tabs, until
the page is reloaded.

## Convert A Bundle To JSON

You can also convert a bundle from the terminal:

```powershell
.\.venv\Scripts\python.exe tools\convert_charm.py "I:\SteamLibrary\steamapps\common\Flipping is Hard Demo\BepInEx\plugins\charmreplacer\hatbundle" "hat.charm.json"
```

The JSON contains the geometry, textures, and hierarchy needed to display the
charm. Upload it using the same viewer control. To inspect the extracted data,
pass `--report "hat.report.json"` to the converter.

## GitHub Pages

The viewer and JSON charms work on static hosting, including GitHub Pages.
Publish `index.html`, `scripts/`, `assets/`, and `vendor/` from this repository.
To load another charm on Pages, first convert it with `tools/convert_charm.py`,
then select the JSON in the viewer.

Uploading a Unity bundle directly requires the local Python server.
GitHub Pages serves static files and cannot run the converter.

## Physics And Compatibility

The browser uses Three.js for rendering and Cannon.js 0.6.2 for simulation.
The sample charm retains its MagicaCloth proxy mesh: particles, fixed points,
and constraints deform the visible mesh when the phone moves. Other charms can
use their bones or a hanging rigid body, depending on the available data.
**The viewer does not run MagicaCloth or reproduce its physics exactly.**
MagicaCloth is a Unity component, and its compiled scripts cannot run in this
web viewer. The simulation is a preview; check the final result in the game.

Extraction preserves the available prefab data, meshes, and textures.
Settings or components that cannot be represented in the browser are listed
in the JSON warnings. Bundles that depend on missing external resources may
need additional conversion.

The included hat preserves 60 proxy particles, four fixed points, 45 fixed
vertices in the visible mesh, 165 distance constraints, and the prebuild's
depths and hierarchy. The MC2 fixed selection keeps the attachment at its
local position and orientation relative to the phone, without making the
moving particles stiffer.

The external MC2 preset supplies gravity (10), damping (0), angle restoration
and limit curves, tether compression (0.1), distance and bending stiffness,
restoration attenuation (1), inertia smoothing, and speed limits.
Unity curves are evaluated with Hermite interpolation; angles use a normalized
180-degree range. Forces are adapted to Cannon's equations with a softer
angular response: restoration uses 8% and limit correction uses 10% of their
values, without increasing stiffness based on branch mass.

The original preset is not modified. No wind or springs are added to hold an
imposed pose. The Spring section is not used for MeshCloth. When the phone is
stationary and the charm has settled, the assembly sleeps to eliminate
residual numerical oscillation. Moving the phone reactivates physics.
After half a second without phone movement, passive velocity drag is applied
to reduce swinging without pulling the mesh toward a pose. This drag is not
applied while the phone is moving.

This adaptation does not reproduce MagicaCloth's jobs, iterations, or all of
its internal constraints. Triangle bending still uses a distance-based
approximation, and the viewer has no local animation or wind.
Optional collisions use a rectangular phone volume and spheres on the charm's
moving particles. These are not Unity's exact colliders, and self-collisions
are not included. Fixed points do not collide with their own phone.
The bundle alone does not include the game's runtime parameters. The preset
is a separate file and may correspond to a different configuration.

Placement preserves the X=-0.25 and Z=-0.15 offsets from the upper-right
attachment, measured in phone-height units. The attachment height is fixed at
2% above the top edge, with no position controls. The charm retains its native
bundle scale, including node scales; it is not normalized to fit the phone.
The hat is rotated 180 degrees from its previous orientation.
The charm does not collide with the phone unless **Phone collisions** is enabled.

Dragging the view physically rotates the phone and its anchors; the physics
responds to that movement. One finger also rotates the object. The mouse wheel
or a pinch gesture adjusts zoom, and the right mouse button pans the view.
The view buttons and auto-rotation also move the phone.
The [MagicaCloth2 documentation](https://magicasoft.jp/en/mc2_about/) explains
its Unity dependency and WebGL limitation.

## Tests

Physics tests run with Node.js without installing packages. Python tests use
the local environment created by the launcher:

```powershell
node tests/charm-physics.test.cjs
node tests/phone-controls.test.cjs
node tests/mc2-preset.test.cjs
node tests/charm-collisions.test.cjs
.\.venv\Scripts\python.exe -m unittest discover -s tools -p "test_*.py"
```

To check rendering and controls in the browser:

```powershell
npm install
npx playwright install chromium
npm run test:browser
```

The browser test opens the HTML directly. Set `VIEWER_URL` to use a server,
`CHARM_BUNDLE` to test direct bundle uploads, and `PLAYWRIGHT_CHANNEL` to a value
such as `msedge` to use an installed Edge browser. Screenshots are saved in
`.test-output/`.

#! Getting started

# ForgeSkin character skins {#what}

ForgeSkin replaces your character with a humanoid model you import, and its hair and skirt swing with physics. The editor does two things: **characters** (import, bone match, first-person arms, hair and skirt, colliders, materials, check, export — one work at a time) and **dance** (turn VMD actions, cameras and songs into what the game plays on F9).

- The **ForgeSkin plugin** goes into your r2modman game profile. **Apply** installs it together with ForgeCore; there is nothing to download by hand.
- **Works** are saved automatically in the editor's data folder.
- A finished skin packs into a `.forgeskin` file for your game, or exports as a Thunderstore mod to share.

## What you need

- GTFO installed. Settings shows the game folder; if it is not found, click **Choose folder** and pick the folder with `GTFO.exe`.
- A profile with BepInExPack_GTFO (an r2modman profile, or the game folder itself). Pick it under **Apply to:** at the top of the left column.
- A humanoid model: `.glb` (glTF Binary when exporting from Blender) or `.vrm` (VRoid and others). It needs a skinned mesh and a humanoid skeleton.

# The editor at a glance {#editor}

1. **Left column.** **Works** lists every character skin as a card with its state in the profile (editor only / installed / in use). The last work opens at start.
2. **Steps.** The left column's other tab walks through the six steps: import, bones, first-person arms, hair and skirt, materials, check.
3. **3D view.** Left drag orbits, right drag pans, the wheel zooms. The bar at the bottom plays dance clips to show the hair and skirt swinging.
4. **Right column.** The settings of the current step.
5. **Top bar.** Guide, settings (language, game folder, data folder, update), export.

# Import a model {#import}

Drop a `.glb` / `.vrm` onto the window, click **＋ New** in the left column, or click **Choose model** on the first step.

- Bones, spring bones and colliders a VRM carries are filled in.
- A plain glTF gets its bones matched from the skeleton; hair and skirt chains are found and made into spring sets.
- The body collider (the surface hair and skirt cannot pass through) is measured from the model as it imports.
- Every edit is saved automatically.

## Replace the model

Click **Replace** on the first step. Bone match, springs and colliders are measured again for the new model; the work keeps its name.

# Bone match {#bones}

Each dot on the figure is a joint: green = matched, red = a required joint is missing (the hip), grey = left out (its chain stays in its rest pose in game, which is not an error). Click a joint, then pick its bone in the search box below. **Rematch** runs the automatic match again.

The finger grids show one cell per phalanx; lit cells are driven by the game. A hand without bones still exports, its fingers just do not move.

# First-person arms {#arms}

The game cuts the first-person arms from the model. **View arms** switches the 3D view to how they look in first person; switch off materials you do not want to see there (often the body or sleeves).

The game wears your model as its first-person arms only when both upper arms have bones; otherwise it uses its own arms.

# Hair and skirt {#springs}

- **＋ Add spring set**: pick a bone; its chain downward becomes a set.
- **Auto-detect**: finds hair (one set per root), skirts (the ring around the hips) and tails by name and position.

Each set is a card. On a card you can:

- See every **strand** (bone chain) in the set. Click one to highlight it in the 3D view; the bin removes that strand, and the last one removes the set.
- Pick a **preset** (long hair, short hair, skirt, tail): it gives every value below its default.
- Drag the sliders. A value you have not touched follows the preset; once touched, the reset button beside it drops it back to the preset.
- Open **Advanced** for restore, style leash, inertia, azimuth limit, step rate, iterations, length passes and the collide / collide cloth / self-collide switches.

## What the values do

| Value | Effect |
| --- | --- |
| Stiffness | How strongly each piece stays straight. Low = soft and floaty, high = firm and close to the body. |
| Damping | How quickly swinging stops. Low = swings long, high = settles fast. |
| Weight | How much gravity and movement drag it. Hair 0.3–0.8, skirt 0.6–1.2. |
| Gravity | How much it hangs down. 0 = no hang, only the motion swings it. |
| Radius | The chain's thickness, used to keep off the collider and for self-collision. |
| Bend limit | How far one piece may turn from the one above it. Small = the chain stays straight, large = free. |
| Restore | The pull back to the rest shape. Add it when a long ponytail flails too much. |
| Style leash | Pulls each piece toward the direction of the one above, keeping the hairstyle's outline. |
| Inertia | Lag behind the body's acceleration. Higher = thrown around more easily. |
| Azimuth limit | How far a piece may leave its radial plane, so hair cannot swing in front of the face or into the head. |
| Step rate | Physics steps per second. Higher is steadier and costs more (60–480 Hz). |
| Iterations | Constraint passes per step. Higher is firmer and costs more. |
| Length passes | Pulls stretched bones back to their length so a chain cannot grow while it swings. |
| Collide / cloth / self | Whether it collides with the body collider, other spring sets, and itself. |

## It flails on small movements?

Long chains of short pieces excite themselves (MMD twin tails often have pieces 1 cm apart). In order of effect:

1. Remove the dense bones from the chain (try keeping only the first and the last bone of a strand);
2. Raise **Damping** and **Restore**;
3. Raise the **step rate** (120 Hz, for example) to see whether that settles it, then lower it again;
4. Lower **Inertia**.

# Colliders {#colliders}

The collider is the body surface hair and skirt cannot pass through. By default it is **Body surface**: the exact surface measured from the model's own triangles. Switch off materials in the list (a very short skirt may not need one) and click **Measure again** to redo it.

A VRM's own colliders are used when it has some; **Back to automatic** switches to the measured ones.

**Body capsules** are a simpler collider per joint: a little cheaper, but cloth slips between the legs more easily. The default surface is usually the right choice.

# Materials {#materials}

Every material of the model. The game shades them all lit for now; the list is there to confirm which materials take part in the collider and the arm switches.

# Check and export {#export}

The sixth step, **Check**, confirms the required joints have bones. Then:

- **Export ▸ Export mod** in the top bar: name, version, description and icon, exported as a Thunderstore mod zip to share;
- **Export pack** in the same window writes just the `.forgeskin` file.

# Apply to the game {#apply}

**Apply** on a work's card builds and installs it into the profile under **Apply to:**, and the game wears it at once (a running game hot-reloads in seconds). The first apply installs the ForgeSkin plugin for you.

**Install only** puts it into the profile without making the game use it (the in-game skin button picks it later).

# Dance {#dance}

Switch to **Dance** in the top bar to turn an MMD dance into what the game plays on F9: pick an action, a camera, a song and optionally face morphs, convert them, then install the result into a profile.

The editor starts the **Blender** on this machine (4.2 or newer, found automatically; if it is not, point the first step at `blender.exe`) with mmd_tools to evaluate the motion — the same pipeline the hand-baked dances came from.

## What you need

- An MMD action `.vmd`. Optional: a camera `.vmd` (or an already baked `.cam`) and a song (`.wav`/`.mp3`/…). Expressions need no file of their own: what the action animates (blinks, mouth shapes, eye movement) is picked up from it.
- A profile with **BepInExPack_GTFO** and **GTFO_API 0.6.1** installed **by hand**: those two are the base dependencies and the editor does not install them. ForgeCore, ForgeSkin and the dance plugin ship with the editor and are installed for you.

## Step 1 — Import

The dance tab's three steps (**1. Action** / **2. Trim** / **3. Export**) stand as tabs down the right panel's edge (icon over name; hover for the full title); click one to switch to it. Under **1. Action**, press **+ New dance** in **My dances**, give it a name (that name is what the game shows; rename it any time by double-clicking the name in **My dances** — it edits the same name), then:

1. **Action** — pick the `.vmd`, press **Convert**. It takes about a minute for a three-to-four minute dance.
2. **Music** — pick the song. The game plays `.wav` only; the editor converts to PCM WAV when it exports.
3. **Camera** — pick a camera `.vmd` or an already baked `.cam`, and decide whether **Use camera** is on. Off keeps the game's own camera. The camera may be shorter than the dance; it then holds its last frame.
4. **Face** — the expressions the action animates (blinks, mouth shapes, glances; the usual MMD morph names) are read from it and written as the game's `.face` on export. The names found are listed here, and **Write the action's expressions** turns that off. You can also pick an already baked `.face`; that one is used instead.

## Step 2 — Motion

- **Trim** — each of the three lanes (camera, MMD action, music) holds a row of strips. Click one to pick it, drag its ends to trim it, drag its middle to slide it. The scissors (or Ctrl+B) cuts the picked strip in two at the playhead, the bin (or Delete) throws the picked strip away. A wrong move is undone with Ctrl+Z and redone with Ctrl+Shift+Z (or Ctrl+Y), just like the two arrows at the left of the toolbar; the last 100 steps are kept. Strips in one lane never **overlap**: a strip slid or stretched into its neighbour stops at that neighbour's edge. With snapping on (the default) a strip's ends also catch 0:00, the playhead and other strips' edges, and an orange line shows what caught it. The picture and the music follow the drag as it goes.
- **Blow up the time axis** — the **− / 1.0× / ＋** group at the right of the toolbar, or Ctrl + wheel, stretches the axis sideways (up to 32×) for frame-level placement. Once stretched, the wheel pans it, and the canvas follows the playhead while dragging or playing; back at 1.0× the whole dance fills the window. Past the window width a sideways bar appears under the lanes: drag it or click along it to jump, and the wheel still pans.
- **Clip settings** — click a strip on a lane and the side panel shows that strip's settings. A music strip has **Volume** (0–200%, written into the exported `.wav`) and **Fade in / Fade out** (seconds); an MMD-action or camera strip has **Speed** (0.25–3×; the strip keeps its length on the timeline, and footage past its end holds the last frame). Changes apply to the preview at once and drive the export through the same maths, and reopening the project keeps them.
- **Volume** — playback volume in game (30% by default).

## The stage

Drag with the left button to orbit, scroll to zoom, drag with the right button to pan — the same freedom the character pages have. Once a camera is in, the top-left corner switches between **Free view** and **Camera view**: the latter is what the game's camera move frames. Next to it sits the frame button: press it and a 16:9 window covers the stage, hiding everything outside — what remains inside is exactly what the game will show (the stage itself is not 16:9, so without the frame you see more than the game does). Switch back to keep looking around by hand. The action's expressions play along with the clock — blinks, mouth shapes, glances — exactly as the game will show them after export. The player sits at the bottom edge: click anywhere on the bar to start from there, the round button pauses and resumes, the buttons either side jump 5 seconds, and the arrow keys do the same. Space also pauses and resumes, and once a dance has run to its end, play (or space) starts it over from 0:00.

## Step 3 — Export

**Export** writes `name.dance`, `name.cam` and `name.wav` into the work's `out` folder.

**Apply to the game** does the rest: copies them into the profile's `BepInEx\plugins\GtfoMmdDance\Dances\` and installs ForgeCore, ForgeSkin and the dance plugin. When BepInExPack_GTFO or GTFO_API is missing it says so first. Then press **F9** in game — no restart needed.

> A dance is known by its **filename**, and network sync compares the file's hash: a `.dance` sent to someone else has to be byte-identical (same action, baked on the same machine).

# Common questions {#faq}

- **The character does not show in game?** Check that the plugin version (profile menu, left column) matches the editor; one apply updates it.
- **Hair clips through?** Make sure the collider is **Body surface** and no material is switched off, then raise the radius or lower the stiffness.
- **The character floats or sinks?** Adjust **Height** on the first step; if the model's feet are not at the origin, fix that in Blender first.
- **Where are my works?** Under the data folder's `autosave\character` (Settings ▸ data folder).